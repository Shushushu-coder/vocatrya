import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/encryption";

const require = createRequire(import.meta.url);

type DesktopSecretsModule = {
  SECRET_STORE_VERSION: number;
  loadOrCreateDesktopSecrets: (args: {
    secretStorePath: string;
    configDir?: string;
    safeStorage: unknown;
    generateAuthSecretValue?: () => string;
    generateEncryptionKeyValue?: () => string;
  }) => { authSecret: string; encryptionKey: string; created: boolean };
};

type DesktopLocalDataModule = {
  buildDesktopFilesystemConfig: (layout: {
    databasePath: string;
    secretStorePath: string;
    filesDir: string;
    logsDir: string;
  }) => { databasePath: string; databaseUrl: string; uploadsDir: string; logDirectory: string; secretStorePath: string };
  buildDesktopLayout: (root: string) => {
    root: string;
    dataDir: string;
    filesDir: string;
    configDir: string;
    logsDir: string;
    backupsDir: string;
    tmpDir: string;
    electronDir: string;
    databasePath: string;
    secretStorePath: string;
  };
  ensureDesktopLayout: <T>(layout: T) => T;
};

const secrets = require("../desktop/main/secrets.js") as DesktopSecretsModule;
const localData = require("../desktop/main/local-data.js") as DesktopLocalDataModule;

function createFakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, "utf8"),
    decryptString: (cipher: Buffer | string) => {
      const text = Buffer.isBuffer(cipher) ? cipher.toString("utf8") : String(cipher);
      if (!text.startsWith("enc:")) throw new Error("fake decrypt failed");
      return text.slice("enc:".length);
    },
  };
}

const previousEncryptionKey = process.env.ENCRYPTION_KEY;
afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

describe("desktop secret persistence across restarts", () => {
  it("reuses the persisted key so launch-1 ciphertext decrypts after reload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-desktop-secret-"));
    try {
      const layout = localData.ensureDesktopLayout(localData.buildDesktopLayout(root));
      const config = localData.buildDesktopFilesystemConfig(layout);
      const safeStorage = createFakeSafeStorage();

      const launch1 = secrets.loadOrCreateDesktopSecrets({ secretStorePath: config.secretStorePath, safeStorage });
      expect(launch1.created).toBe(true);

      process.env.ENCRYPTION_KEY = launch1.encryptionKey;
      const fixture = "synthetic-provider-key-do-not-use";
      const sealed = encrypt(fixture);

      const launch2 = secrets.loadOrCreateDesktopSecrets({ secretStorePath: config.secretStorePath, safeStorage });
      expect(launch2.created).toBe(false);
      expect(launch2.authSecret).toBe(launch1.authSecret);
      expect(launch2.encryptionKey).toBe(launch1.encryptionKey);

      process.env.ENCRYPTION_KEY = launch2.encryptionKey;
      expect(decrypt(sealed.encrypted, sealed.iv)).toBe(fixture);

      const raw = fs.readFileSync(config.secretStorePath, "utf8");
      expect(JSON.parse(raw).version).toBe(1);
      expect(raw).not.toContain(launch1.authSecret);
      expect(raw).not.toContain(launch1.encryptionKey);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
