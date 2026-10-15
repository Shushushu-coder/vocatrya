// Vocatrya Windows desktop secret persistence (DPAPI-backed via Electron safeStorage).
// Generates AUTH_SECRET / ENCRYPTION_KEY once, persists only ciphertext,
// and reuses the same logical values on every later launch. Fail-closed:
// corruption or unavailable encryption never regenerates silently.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SECRET_STORE_VERSION = 1;
const SECRET_STORE_FILE_NAME = "secrets.dat";

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isBase64Text(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    const roundTrip = Buffer.from(value, "base64").toString("base64");
    return roundTrip === value;
  } catch {
    return false;
  }
}

// 256-bit CSPRNG for AUTH_SECRET (base64url, accepted by NextAuth/Auth.js).
function generateAuthSecret(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

// >=256-bit entropy for ENCRYPTION_KEY. The backend uses the value as an
// opaque PBKDF2 password (salted, 100k iterations, sha256) for AES-256-GCM
// API-key encryption, so any high-entropy string is compatible; base64 of
// 32 random bytes matches the documented `openssl rand -base64 32` format.
function generateEncryptionKey(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64");
}

function validateSecretStoreObject(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new Error("Local secure configuration is invalid (unexpected format)");
  }
  if (store.version !== SECRET_STORE_VERSION) {
    throw new Error("Local secure configuration is invalid (unsupported version)");
  }
  if (!isBase64Text(store.authSecret) || !isBase64Text(store.encryptionKey)) {
    throw new Error("Local secure configuration is invalid (ciphertext fields)");
  }
}

function requireSafeStorage(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
    throw new Error("Desktop secure storage is unavailable; refusing to generate plaintext secrets");
  }
  if (safeStorage.isEncryptionAvailable() !== true) {
    throw new Error("Desktop secure storage is unavailable; refusing to generate plaintext secrets");
  }
  if (typeof safeStorage.encryptString !== "function" || typeof safeStorage.decryptString !== "function") {
    throw new Error("Desktop secure storage is unavailable; refusing to generate plaintext secrets");
  }
}

function encryptToBase64(safeStorage, plaintext) {
  const ciphertext = safeStorage.encryptString(plaintext);
  const buffer = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  if (buffer.length === 0) {
    throw new Error("Desktop secure storage encryption failed");
  }
  return buffer.toString("base64");
}

function decryptFromBase64(safeStorage, field, label) {
  let buffer;
  try {
    buffer = Buffer.from(field, "base64");
  } catch {
    throw new Error("Local secure configuration cannot be decrypted");
  }
  try {
    const plaintext = safeStorage.decryptString(buffer);
    const text = typeof plaintext === "string" ? plaintext : String(plaintext);
    if (!isNonEmptyString(text)) {
      throw new Error("Local secure configuration cannot be decrypted");
    }
    return text;
  } catch (error) {
    if (error && error.message === "Local secure configuration cannot be decrypted") throw error;
    throw new Error("Local secure configuration cannot be decrypted");
  }
}

const WIN32_ERROR_NOT_SAME_DEVICE = 17;
const WIN32_ERROR_INVALID_PARAMETER = 87;
const WINDOWS_COMMIT_TIMEOUT_MS = 20000;

// Constant script. Source and destination paths arrive only as environment
// variables, never by interpolating them into the command text.
const WINDOWS_COMMIT_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SecretStoreCommit {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool MoveFileEx(string source, string destination, int flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool ReplaceFile(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  public static int Commit(string source, string destination, string backup) {
    if (!System.IO.File.Exists(destination)) {
      if (MoveFileEx(source, destination, 0)) return 0;
      return Marshal.GetLastWin32Error();
    }
    // ReplaceFile moves the existing file to backup before publishing.
    // A null backup can leave the existing file deleted on ERROR_UNABLE_TO_MOVE_REPLACEMENT.
    if (string.IsNullOrEmpty(backup)) return 87;
    if (ReplaceFile(destination, source, backup, 0, IntPtr.Zero, IntPtr.Zero)) return 0;
    return Marshal.GetLastWin32Error();
  }
}
'@
if ([string]::IsNullOrEmpty($env:VOCATRYA_SECRET_SRC) -or [string]::IsNullOrEmpty($env:VOCATRYA_SECRET_DST)) { exit 87 }
exit [SecretStoreCommit]::Commit($env:VOCATRYA_SECRET_SRC, $env:VOCATRYA_SECRET_DST, $env:VOCATRYA_SECRET_BAK)
`;

function isCrossDeviceError(error) {
  return Boolean(error && (error.code === "EXDEV" || error.win32 === WIN32_ERROR_NOT_SAME_DEVICE));
}

function powershellExe() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function writeTempDurable(tempPath, payload) {
  const fd = fs.openSync(tempPath, "wx");
  try {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sameExistingFile(tempPath, secretStorePath) {
  try {
    if (!fs.existsSync(tempPath) || !fs.existsSync(secretStorePath)) return false;
    const tempStat = fs.statSync(tempPath);
    const destStat = fs.statSync(secretStorePath);
    return tempStat.ino !== 0 && tempStat.dev === destStat.dev && tempStat.ino === destStat.ino;
  } catch {
    return false;
  }
}

function removeTempBestEffort(tempPath, secretStorePath) {
  try {
    if (!fs.existsSync(tempPath) || sameExistingFile(tempPath, secretStorePath)) return;
    fs.rmSync(tempPath, { force: true });
  } catch {
    // Best-effort temp cleanup after the commit attempt.
  }
}

// EXDEV fallback used only after same-directory rename fails.
// Absent destination: MoveFileEx with flags 0, the same call as .NET File.Move
// without overwrite. Existing destination: ReplaceFile, which keeps the
// destination ACL and encryption attribute and does not use copyFile.
// If either call fails, this throws and does not write the destination.
function previousStorePath(secretStorePath) {
  return `${secretStorePath}.previous`;
}

function readFileIfPresent(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

// Missing and unreadable are different. A read error is not proof that the
// existing bytes are stale, so recovery must not overwrite them.
function readStoreState(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { kind: "missing", bytes: null };
    return { kind: "readable", bytes: fs.readFileSync(filePath) };
  } catch {
    return { kind: "unreadable", bytes: null };
  }
}

function refuseUnreadableOverwrite() {
  const error = new Error(
    "Local secure configuration commit failed and the existing file could not be read; refusing to overwrite it",
  );
  error.code = "EIO";
  return error;
}

function commitSecretStoreCrossDevice(tempPath, secretStorePath, backupPath = previousStorePath(secretStorePath)) {
  if (process.platform !== "win32") {
    const error = new Error("EXDEV: cross-device link not permitted");
    error.code = "EXDEV";
    throw error;
  }
  const executable = powershellExe();
  if (!fs.existsSync(executable)) {
    const error = new Error("Windows PowerShell is unavailable; refusing to copy over the secret store");
    error.code = "ENOENT";
    throw error;
  }
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMMIT_COMMAND], {
    windowsHide: true,
    encoding: "utf8",
    timeout: WINDOWS_COMMIT_TIMEOUT_MS,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      VOCATRYA_SECRET_SRC: tempPath,
      VOCATRYA_SECRET_DST: secretStorePath,
      VOCATRYA_SECRET_BAK: backupPath || "",
    },
  });
  if (result.error) {
    const error = new Error(`Windows secret store commit could not start: ${result.error.message}`);
    error.code = result.error.code || "EIO";
    throw error;
  }
  if (result.status === 0) return;
  const status = result.status === null ? WIN32_ERROR_INVALID_PARAMETER : result.status;
  const error = new Error(`Windows secret store commit failed with Win32 status ${status}`);
  error.code = status === WIN32_ERROR_NOT_SAME_DEVICE ? "EXDEV" : "EIO";
  error.win32 = status;
  throw error;
}

function previousFileBytes(secretStorePath) {
  try {
    if (!fs.existsSync(secretStorePath)) return null;
    return fs.readFileSync(secretStorePath);
  } catch (error) {
    throw new Error(`Local secure configuration cannot be read before commit: ${error.message}`);
  }
}

function publishFile(sourcePath, secretStorePath) {
  try {
    fs.renameSync(sourcePath, secretStorePath);
    return;
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    commitSecretStoreCrossDevice(sourcePath, secretStorePath, previousStorePath(secretStorePath));
  }
}

// Put the previous bytes back at secretStorePath. Prefer the ReplaceFile backup,
// then an fsynced copy of the in-memory bytes. Never delete the backup while the
// destination is missing or different. A readable new payload and an unreadable
// existing file are both left untouched.
function restorePreviousFile(secretStorePath, previous, backupPath, protectedPayload = null) {
  if (previous === null) return;
  let state = readStoreState(secretStorePath);
  if (state.kind === "unreadable") throw refuseUnreadableOverwrite();
  if (state.kind === "readable" && protectedPayload && state.bytes.equals(protectedPayload)) return;
  if (state.kind === "readable" && state.bytes.equals(previous)) return;
  const backupBytes = readFileIfPresent(backupPath);
  if (backupBytes?.equals(previous) && state.kind === "missing") {
    publishFile(backupPath, secretStorePath);
    state = readStoreState(secretStorePath);
    if (state.kind === "unreadable") throw refuseUnreadableOverwrite();
    if (state.kind === "readable" && protectedPayload && state.bytes.equals(protectedPayload)) return;
    if (state.kind === "readable" && state.bytes.equals(previous)) return;
  }
  const restorePath = `${secretStorePath}.restore-${crypto.randomBytes(4).toString("hex")}`;
  writeTempDurable(restorePath, previous);
  const displacedPath = `${secretStorePath}.displaced-${crypto.randomBytes(4).toString("hex")}`;
  const displaceBackup = `${secretStorePath}.displace-bak`;
  try {
    state = readStoreState(secretStorePath);
    if (state.kind === "unreadable") throw refuseUnreadableOverwrite();
    if (state.kind === "readable" && protectedPayload && state.bytes.equals(protectedPayload)) return;
    if (state.kind === "readable" && !state.bytes.equals(previous)) {
      try {
        fs.renameSync(secretStorePath, displacedPath);
      } catch (error) {
        if (!isCrossDeviceError(error)) throw error;
        commitSecretStoreCrossDevice(restorePath, secretStorePath, displaceBackup);
      }
    }
    if (!fs.existsSync(secretStorePath)) {
      publishFile(restorePath, secretStorePath);
    }
  } finally {
    const restored = readStoreState(secretStorePath);
    const preserved = restored.kind === "readable"
      && (restored.bytes.equals(previous) || (protectedPayload && restored.bytes.equals(protectedPayload)));
    if (preserved) {
      removeTempBestEffort(restorePath, secretStorePath);
      if (restored.bytes.equals(previous)) {
        removeTempBestEffort(displacedPath, secretStorePath);
        removeTempBestEffort(displaceBackup, secretStorePath);
      }
    } else if (fs.existsSync(displacedPath) && !fs.existsSync(secretStorePath)) {
      try {
        fs.renameSync(displacedPath, secretStorePath);
      } catch {
        // Leave the displaced previous file in place rather than deleting it.
      }
    }
  }
  const finalState = readStoreState(secretStorePath);
  if (finalState.kind === "unreadable") throw refuseUnreadableOverwrite();
  if (!finalState.bytes?.equals(previous)) {
    const error = new Error("Local secure configuration commit failed and the previous file could not be restored");
    error.code = "EIO";
    throw error;
  }
}

function assertPublishedPayload(secretStorePath, payloadBuffer) {
  const published = readFileIfPresent(secretStorePath);
  if (!published || !published.equals(payloadBuffer)) {
    const error = new Error("Local secure configuration publish did not match the payload");
    error.code = "EIO";
    throw error;
  }
}

// Serialize to a temp file in the same directory, fsync it, then publish.
// Rename remains the first attempt. EXDEV uses commitSecretStoreCrossDevice.
// An existing destination is published with ReplaceFile and a .previous backup.
// A failed publish restores that previous file before returning.
// Power loss inside the Win32 call itself is not established by the automated tests.
function writeSecretStoreAtomically(secretStorePath, store, dependencies = {}) {
  const directory = path.dirname(secretStorePath);
  fs.mkdirSync(directory, { recursive: true });
  const payload = JSON.stringify(store);
  const payloadBuffer = Buffer.from(payload, "utf8");
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tempPath = `${secretStorePath}.tmp-${nonce}`;
  const backupPath = previousStorePath(secretStorePath);
  const previous = previousFileBytes(secretStorePath);
  const writeTemp = dependencies.writeTemp || writeTempDurable;
  const renameSync = dependencies.renameSync || fs.renameSync.bind(fs);
  const commitCrossDevice = dependencies.commitCrossDevice || commitSecretStoreCrossDevice;
  const removeTemp = dependencies.removeTemp || removeTempBestEffort;
  if (previous && fs.existsSync(backupPath) && readFileIfPresent(secretStorePath)?.equals(previous)) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // ReplaceFile requires the backup name to be absent. A later failure restores from memory.
    }
  }
  let commitError = null;
  try {
    writeTemp(tempPath, payload);
    try {
      renameSync(tempPath, secretStorePath);
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error;
      commitCrossDevice(tempPath, secretStorePath, backupPath);
    }
    assertPublishedPayload(secretStorePath, payloadBuffer);
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
  } catch (error) {
    const published = readStoreState(secretStorePath);
    if (published.kind === "readable" && published.bytes.equals(payloadBuffer)) {
      // The new store is already durable. A backup-cleanup failure must not roll it back.
    } else if (published.kind === "unreadable") {
      // The existing file may already contain the new store. Leave it in place.
      commitError = error;
    } else {
      try {
        restorePreviousFile(secretStorePath, previous, backupPath, payloadBuffer);
      } catch (integrityError) {
        integrityError.cause = error;
        commitError = integrityError;
      }
      if (!commitError) commitError = error;
    }
  } finally {
    try {
      removeTemp(tempPath, secretStorePath);
    } catch {
      // Cleanup must not hide a commit result or replace a successful publish.
    }
    if (commitError && previous && !readFileIfPresent(secretStorePath)?.equals(previous)) {
      // Keep .previous when it is the only remaining copy of the old store.
    } else if (!commitError && fs.existsSync(backupPath)) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // The published file already matched the payload.
      }
    }
  }
  if (commitError) throw commitError;
}

function readSecretStoreFile(secretStorePath) {
  let raw;
  try {
    raw = fs.readFileSync(secretStorePath, "utf8");
  } catch (error) {
    throw new Error(`Local secure configuration cannot be read: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Local secure configuration cannot be decrypted");
  }
  validateSecretStoreObject(parsed);
  return parsed;
}

// Main entry: load existing encrypted state, or generate + persist once.
// Returns { authSecret, encryptionKey, created }. Never logs secret values,
// never deletes a corrupt store, never regenerates silently.
function loadOrCreateDesktopSecrets({
  secretStorePath,
  configDir,
  safeStorage,
  generateAuthSecretValue = generateAuthSecret,
  generateEncryptionKeyValue = generateEncryptionKey,
} = {}) {
  if (!isNonEmptyString(secretStorePath)) {
    throw new Error("secretStorePath is required");
  }
  requireSafeStorage(safeStorage);
  const directory = configDir || path.dirname(secretStorePath);
  fs.mkdirSync(directory, { recursive: true });

  const backupPath = previousStorePath(secretStorePath);
  if (!fs.existsSync(secretStorePath) && fs.existsSync(backupPath)) {
    try {
      publishFile(backupPath, secretStorePath);
    } catch (error) {
      throw new Error(`Local secure configuration cannot be read: ${error.message}`);
    }
    if (!fs.existsSync(secretStorePath)) {
      throw new Error("Local secure configuration cannot be read: previous secret store could not be restored");
    }
  }

  if (fs.existsSync(secretStorePath)) {
    const store = readSecretStoreFile(secretStorePath);
    const authSecret = decryptFromBase64(safeStorage, store.authSecret, "authSecret");
    const encryptionKey = decryptFromBase64(safeStorage, store.encryptionKey, "encryptionKey");
    if (fs.existsSync(backupPath)) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // The restored or existing store is already loaded.
      }
    }
    return { authSecret, encryptionKey, created: false };
  }

  const authSecret = generateAuthSecretValue();
  const encryptionKey = generateEncryptionKeyValue();
  if (!isNonEmptyString(authSecret) || !isNonEmptyString(encryptionKey)) {
    throw new Error("Desktop secure storage generation failed");
  }
  const store = {
    version: SECRET_STORE_VERSION,
    authSecret: encryptToBase64(safeStorage, authSecret),
    encryptionKey: encryptToBase64(safeStorage, encryptionKey),
  };
  validateSecretStoreObject(store);
  writeSecretStoreAtomically(secretStorePath, store);
  return { authSecret, encryptionKey, created: true };
}

module.exports = {
  SECRET_STORE_FILE_NAME,
  SECRET_STORE_VERSION,
  decryptFromBase64,
  encryptToBase64,
  generateAuthSecret,
  generateEncryptionKey,
  loadOrCreateDesktopSecrets,
  validateSecretStoreObject,
  writeSecretStoreAtomically,
  commitSecretStoreCrossDevice,
};
