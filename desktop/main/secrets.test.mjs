import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SECRET_STORE_VERSION,
  commitSecretStoreCrossDevice,
  generateAuthSecret,
  generateEncryptionKey,
  loadOrCreateDesktopSecrets,
  validateSecretStoreObject,
  writeSecretStoreAtomically,
} from "./secrets.js";

function createFakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, "utf8"),
    decryptString: (cipher) => {
      const text = Buffer.isBuffer(cipher) ? cipher.toString("utf8") : Buffer.from(String(cipher)).toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("fake decrypt failed");
      return text.slice("enc:".length);
    },
  };
}

function makeStorePath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, store: path.join(dir, "config", "secrets.dat") };
}

describe("desktop secret generation", () => {
  it("generates 256-bit high-entropy secrets in the documented encodings", () => {
    const auth = generateAuthSecret();
    const key = generateEncryptionKey();
    expect(typeof auth).toBe("string");
    expect(auth.length).toBeGreaterThanOrEqual(43);
    expect(auth).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(typeof key).toBe("string");
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  it("rejects unsupported versions and malformed ciphertext fields", () => {
    expect(() => validateSecretStoreObject(null)).toThrow(/invalid/i);
    expect(() => validateSecretStoreObject({ version: 999, authSecret: "eA==", encryptionKey: "eQ==" })).toThrow(
      /version/,
    );
    expect(() =>
      validateSecretStoreObject({ version: 1, authSecret: "not-base64!!!", encryptionKey: "eQ==" }),
    ).toThrow(/ciphertext/);
    expect(() => validateSecretStoreObject({ version: SECRET_STORE_VERSION, authSecret: "eA==" })).toThrow(
      /ciphertext/,
    );
  });
});

describe("desktop secret persistence", () => {
  it("generates once then reuses the exact logical values on reload", () => {
    const { dir, store } = makeStorePath("vocatrya-secrets-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(first.created).toBe(true);
    expect(first.authSecret.length).toBeGreaterThan(0);
    expect(first.encryptionKey.length).toBeGreaterThan(0);
    const before = fs.readFileSync(store, "utf8");
    const second = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(second.created).toBe(false);
    expect(second.authSecret).toBe(first.authSecret);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    expect(fs.readFileSync(store, "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists only ciphertext with a versioned format", () => {
    const { dir, store } = makeStorePath("vocatrya-cipher-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const raw = fs.readFileSync(store, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(SECRET_STORE_VERSION);
    expect(typeof parsed.authSecret).toBe("string");
    expect(typeof parsed.encryptionKey).toBe("string");
    expect(raw).not.toContain(first.authSecret);
    expect(raw).not.toContain(first.encryptionKey);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically without leaving temp files", () => {
    const { dir, store } = makeStorePath("vocatrya-atomic-");
    writeSecretStoreAtomically(store, { version: 1, authSecret: "eA==", encryptionKey: "eQ==" });
    expect(JSON.parse(fs.readFileSync(store, "utf8")).version).toBe(1);
    const leftovers = fs.readdirSync(path.dirname(store)).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on corrupt ciphertext without regenerating or overwriting", () => {
    const { dir, store } = makeStorePath("vocatrya-corrupt-");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
      '{"version":1,"authSecret":"@@@not-base64@@@","encryptionKey":"@@@also-bad@@@"}',
      "utf8",
    );
    const safeStorage = createFakeSafeStorage();
    expect(() => loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage })).toThrow(
      /cannot be decrypted|invalid/i,
    );
    expect(fs.readFileSync(store, "utf8")).toBe(
      '{"version":1,"authSecret":"@@@not-base64@@@","encryptionKey":"@@@also-bad@@@"}',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on undecryptable ciphertext without silent rotation", () => {
    const { dir, store } = makeStorePath("vocatrya-tamper-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const raw = fs.readFileSync(store, "utf8");
    const parsed = JSON.parse(raw);
    parsed.authSecret = Buffer.from("tampered-bytes").toString("base64");
    fs.writeFileSync(store, JSON.stringify(parsed), "utf8");
    expect(() => loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage })).toThrow(
      /cannot be decrypted/i,
    );
    expect(fs.readFileSync(store, "utf8")).not.toContain(first.authSecret);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when safeStorage is unavailable and creates no plaintext file", () => {
    const { dir, store } = makeStorePath("vocatrya-nosafe-");
    const unavailable = createFakeSafeStorage({ available: false });
    expect(() => loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage: unavailable })).toThrow(
      /unavailable/i,
    );
    expect(fs.existsSync(store)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires a secret store path", () => {
    expect(() => loadOrCreateDesktopSecrets({ safeStorage: createFakeSafeStorage() })).toThrow(/required/);
  });
});

function exdevError() {
  const error = new Error("EXDEV: cross-device link not permitted, rename");
  error.code = "EXDEV";
  return error;
}

function fileAcl(target) {
  const result = spawnSync("icacls.exe", [target], { encoding: "utf8" });
  return result.stdout;
}

function fileAttributes(target) {
  const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", "Write-Output (Get-Item -LiteralPath $env:PROBE_TARGET -Force).Attributes.ToString()"],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PROBE_TARGET: target,
      },
    },
  );
  return (result.stdout || "").trim();
}

const sampleStore = { version: 1, authSecret: "eA==", encryptionKey: "eQ==" };
const updatedStore = { version: 1, authSecret: "eB==", encryptionKey: "eR==" };
const secretsJsPath = fileURLToPath(new URL("./secrets.js", import.meta.url));
const repoRoot = path.resolve(path.dirname(secretsJsPath), "..", "..");

describe("desktop secret EXDEV publish", () => {
  it("creates a secret store on ordinary NTFS without the Windows fallback", () => {
    const { dir, store } = makeStorePath("vocatrya-ntfs-create-");
    let fallbackCalls = 0;
    writeSecretStoreAtomically(store, sampleStore, {
      commitCrossDevice() {
        fallbackCalls += 1;
        throw new Error("fallback should not run");
      },
    });
    expect(fallbackCalls).toBe(0);
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(sampleStore);
    expect(fs.readdirSync(path.dirname(store)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("updates an existing store on ordinary NTFS without the Windows fallback", () => {
    const { dir, store } = makeStorePath("vocatrya-ntfs-update-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    writeSecretStoreAtomically(store, updatedStore, {
      commitCrossDevice() {
        throw new Error("fallback should not run");
      },
    });
    expect(fs.readFileSync(store).equals(before)).toBe(false);
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(updatedStore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("publishes a new store when rename raises EXDEV", () => {
    const { dir, store } = makeStorePath("vocatrya-exdev-create-");
    writeSecretStoreAtomically(store, sampleStore, { renameSync: () => { throw exdevError(); } });
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(sampleStore);
    expect(fs.readdirSync(path.dirname(store)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces an existing store through ReplaceFile and keeps its ACL and attributes", () => {
    const { dir, store } = makeStorePath("vocatrya-exdev-update-");
    writeSecretStoreAtomically(store, sampleStore);
    const beforeAcl = fileAcl(store);
    const beforeAttributes = fileAttributes(store);
    let copyCalls = 0;
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = (...args) => {
      copyCalls += 1;
      return originalCopy(...args);
    };
    try {
      writeSecretStoreAtomically(store, updatedStore, { renameSync: () => { throw exdevError(); } });
    } finally {
      fs.copyFileSync = originalCopy;
    }
    expect(copyCalls).toBe(0);
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(updatedStore);
    expect(fileAcl(store)).toBe(beforeAcl);
    expect(fileAttributes(store)).toBe(beforeAttributes);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an existing ciphertext readable after a failed EXDEV update", () => {
    const { dir, store } = makeStorePath("vocatrya-exdev-keep-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const before = fs.readFileSync(store);
    expect(() =>
      writeSecretStoreAtomically(store, updatedStore, {
        renameSync: () => {
          throw exdevError();
        },
        commitCrossDevice() {
          throw exdevError();
        },
      }),
    ).toThrow(/EXDEV/);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    const second = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(second.created).toBe(false);
    expect(second.authSecret).toBe(first.authSecret);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not call the Windows fallback for a non-EXDEV rename failure", () => {
    const { dir, store } = makeStorePath("vocatrya-eacces-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    let fallbackCalls = 0;
    const error = new Error("EACCES");
    error.code = "EACCES";
    expect(() =>
      writeSecretStoreAtomically(store, updatedStore, {
        renameSync: () => {
          throw error;
        },
        commitCrossDevice() {
          fallbackCalls += 1;
        },
      }),
    ).toThrow(/EACCES/);
    expect(fallbackCalls).toBe(0);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves no destination when the temp write fails", () => {
    const { dir, store } = makeStorePath("vocatrya-write-fail-");
    expect(() =>
      writeSecretStoreAtomically(store, sampleStore, {
        writeTemp() {
          throw new Error("disk full");
        },
      }),
    ).toThrow(/disk full/);
    expect(fs.existsSync(store)).toBe(false);
    expect(fs.readdirSync(path.dirname(store)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the previous file unchanged when the temp write fails during an update", () => {
    const { dir, store } = makeStorePath("vocatrya-write-fail-update-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    expect(() =>
      writeSecretStoreAtomically(store, updatedStore, {
        writeTemp() {
          throw new Error("disk full");
        },
      }),
    ).toThrow(/disk full/);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores the previous file when a failed commit removes it and leaves a backup", () => {
    const { dir, store } = makeStorePath("vocatrya-restore-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    expect(() =>
      writeSecretStoreAtomically(store, updatedStore, {
        renameSync: () => {
          throw exdevError();
        },
        commitCrossDevice(_tempPath, destination) {
          fs.renameSync(destination, `${destination}.previous`);
          const error = new Error("simulated replacement failure");
          error.win32 = 1176;
          throw error;
        },
      }),
    ).toThrow(/simulated replacement failure/);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    expect(fs.existsSync(`${store}.previous`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores previous bytes when a failed commit tears the existing file", () => {
    const { dir, store } = makeStorePath("vocatrya-damage-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    expect(() =>
      writeSecretStoreAtomically(store, updatedStore, {
        renameSync: () => {
          throw exdevError();
        },
        commitCrossDevice(_tempPath, destination) {
          fs.writeFileSync(destination, "torn");
          throw exdevError();
        },
      }),
    ).toThrow(/EXDEV/);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reloads a previous store after the destination disappeared", () => {
    const { dir, store } = makeStorePath("vocatrya-previous-reload-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    fs.renameSync(store, `${store}.previous`);
    const second = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(second.created).toBe(false);
    expect(second.authSecret).toBe(first.authSecret);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    expect(fs.existsSync(store)).toBe(true);
    expect(fs.existsSync(`${store}.previous`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a successful publish when temp cleanup fails", () => {
    const { dir, store } = makeStorePath("vocatrya-cleanup-");
    writeSecretStoreAtomically(store, sampleStore, {
      removeTemp() {
        throw new Error("cleanup locked");
      },
    });
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(sampleStore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails the real Windows commit when the source is missing and does not change the destination", () => {
    const { dir, store } = makeStorePath("vocatrya-missing-src-");
    writeSecretStoreAtomically(store, sampleStore);
    const before = fs.readFileSync(store);
    const missing = path.join(dir, "missing.tmp");
    expect(() => commitSecretStoreCrossDevice(missing, store)).toThrow(/Win32 status 2/);
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a store created by the rename path after a new process starts", () => {
    const { dir, store } = makeStorePath("vocatrya-restart-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const driver = path.join(dir, "reload.cjs");
    fs.writeFileSync(
      driver,
      [
        "const fs = require('node:fs');",
        "const { loadOrCreateDesktopSecrets } = require(process.argv[2]);",
        "const safeStorage = {",
        "  isEncryptionAvailable: () => true,",
        "  encryptString: (plaintext) => Buffer.from('enc:' + plaintext, 'utf8'),",
        "  decryptString: (cipher) => {",
        "    const text = Buffer.isBuffer(cipher) ? cipher.toString('utf8') : String(cipher);",
        "    if (!text.startsWith('enc:')) throw new Error('fake decrypt failed');",
        "    return text.slice(4);",
        "  },",
        "};",
        "const loaded = loadOrCreateDesktopSecrets({ secretStorePath: process.argv[3], safeStorage });",
        "fs.writeFileSync(process.argv[4], JSON.stringify({ created: loaded.created, authSecret: loaded.authSecret, encryptionKey: loaded.encryptionKey }));",
      ].join("\n"),
      "utf8",
    );
    const resultPath = path.join(dir, "reload.json");
    const child = spawnSync(process.execPath, [driver, secretsJsPath, store, resultPath], {
      encoding: "utf8",
    });
    if (child.status !== 0) {
      throw new Error(child.stderr || child.stdout || `reload exited ${child.status}`);
    }
    expect(child.status).toBe(0);
    const loaded = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    expect(loaded.created).toBe(false);
    expect(loaded.authSecret).toBe(first.authSecret);
    expect(loaded.encryptionKey).toBe(first.encryptionKey);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the previous store intact when the process is killed before commit", async () => {
    const { dir, store } = makeStorePath("vocatrya-kill-");
    const safeStorage = createFakeSafeStorage();
    const first = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const before = fs.readFileSync(store);
    const driver = path.join(dir, "pause.cjs");
    const signal = path.join(dir, "ready.txt");
    const secretsPath = secretsJsPath;
    fs.writeFileSync(
      driver,
      [
        "const fs = require('node:fs');",
        "const { writeSecretStoreAtomically } = require(process.argv[2]);",
        "fs.renameSync = () => {",
        "  fs.writeFileSync(process.argv[4], 'ready');",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);",
        "  const error = new Error('EXDEV');",
        "  error.code = 'EXDEV';",
        "  throw error;",
        "};",
        "writeSecretStoreAtomically(process.argv[3], { version: 1, authSecret: 'eB==', encryptionKey: 'eR==' });",
      ].join("\n"),
      "utf8",
    );
    const child = spawn(process.execPath, [driver, secretsPath, store, signal], { stdio: "ignore" });
    const started = Date.now();
    while (!fs.existsSync(signal)) {
      if (Date.now() - started > 10000) throw new Error("paused writer did not reach commit");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    const second = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(second.authSecret).toBe(first.authSecret);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses a real encrypted directory when the OS can provision one, and otherwise does not invent that coverage", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-efs-"));
    const dir = path.join(parent, "encrypted");
    fs.mkdirSync(dir);
    const cipher = spawnSync("cipher.exe", ["/e", "/q", dir], { encoding: "utf8" });
    if (cipher.status !== 0) {
      expect(fileAttributes(dir).includes("Encrypted")).toBe(false);
      fs.rmSync(parent, { recursive: true, force: true });
      return;
    }
    try {
      const store = path.join(dir, "secrets.dat");
      writeSecretStoreAtomically(store, sampleStore);
      expect(fileAttributes(store).includes("Encrypted")).toBe(true);
      writeSecretStoreAtomically(store, updatedStore);
      expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(updatedStore);
      expect(fileAttributes(store).includes("Encrypted")).toBe(true);
    } finally {
      spawnSync("cipher.exe", ["/d", "/q", dir], { encoding: "utf8" });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not replace a newer store with a stale previous backup", () => {
    const { dir, store } = makeStorePath("vocatrya-stale-backup-");
    const safeStorage = createFakeSafeStorage();
    const created = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    const before = fs.readFileSync(store);
    fs.writeFileSync(`${store}.previous`, Buffer.from("stale-backup"));
    const loaded = loadOrCreateDesktopSecrets({ secretStorePath: store, safeStorage });
    expect(fs.readFileSync(store).equals(before)).toBe(true);
    expect(loaded.created).toBe(false);
    expect(loaded.authSecret).toBe(created.authSecret);
    expect(loaded.encryptionKey).toBe(created.encryptionKey);
    expect(fs.existsSync(`${store}.previous`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a published store when it cannot be read back after the real Windows fallback", () => {
    const { dir, store } = makeStorePath("vocatrya-unreadable-new-");
    writeSecretStoreAtomically(store, sampleStore);
    const realRead = fs.readFileSync;
    let blockRead = false;
    fs.readFileSync = (filePath, ...args) => {
      if (blockRead && filePath === store) {
        const error = new Error("busy");
        error.code = "EBUSY";
        throw error;
      }
      return realRead(filePath, ...args);
    };
    try {
      expect(() =>
        writeSecretStoreAtomically(store, updatedStore, {
          renameSync() {
            throw exdevError();
          },
          commitCrossDevice(tempPath, destination, backupPath) {
            commitSecretStoreCrossDevice(tempPath, destination, backupPath);
            blockRead = true;
          },
        }),
      ).toThrow(/publish did not match|could not be read/);
    } finally {
      fs.readFileSync = realRead;
    }
    expect(JSON.parse(fs.readFileSync(store, "utf8"))).toEqual(updatedStore);
    expect(fs.readFileSync(store, "utf8").includes("eA==")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds Windows PowerShell and kernel32 on this desktop without a new package dependency", () => {
    const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    expect(fs.existsSync(executable)).toBe(true);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(declared.koffi).toBeUndefined();
    expect(declared["ffi-napi"]).toBeUndefined();
    const builder = fs.readFileSync(path.join(repoRoot, "desktop", "electron-builder.yml"), "utf8");
    expect(builder).toContain("desktop/main/**/*.js");
  });
});
