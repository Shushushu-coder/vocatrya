import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECRET_STORE_VERSION,
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
