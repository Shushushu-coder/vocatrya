// Vocatrya Windows desktop secret persistence (DPAPI-backed via Electron safeStorage).
// Generates AUTH_SECRET / ENCRYPTION_KEY once, persists only ciphertext,
// and reuses the same logical values on every later launch. Fail-closed:
// corruption or unavailable encryption never regenerates silently.
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

// Atomic write: serialize -> temp file in the same config directory ->
// rename over the target, so crash/power loss never leaves half a JSON file.
function writeSecretStoreAtomically(secretStorePath, store) {
  const directory = path.dirname(secretStorePath);
  fs.mkdirSync(directory, { recursive: true });
  const payload = JSON.stringify(store);
  const nonce = `${process.pid}-${Date.now()}`;
  const tempPath = `${secretStorePath}.tmp-${nonce}`;
  try {
    fs.writeFileSync(tempPath, payload, { encoding: "utf8" });
    fs.renameSync(tempPath, secretStorePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup; the authoritative file already renamed.
    }
  }
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

  if (fs.existsSync(secretStorePath)) {
    const store = readSecretStoreFile(secretStorePath);
    const authSecret = decryptFromBase64(safeStorage, store.authSecret, "authSecret");
    const encryptionKey = decryptFromBase64(safeStorage, store.encryptionKey, "encryptionKey");
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
};
