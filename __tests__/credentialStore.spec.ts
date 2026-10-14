// @vitest-environment node
/**
 * BYOK CredentialStore — format dispatch, broker wire contract, fail-closed
 * behavior. Uses synthetic keys only. The broker under test is the REAL
 * desktop/main/credential-broker.js bound to an ephemeral loopback port,
 * with a tagged-marker safeStorage stand-in simulating a fixed OS user.
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { encrypt } from "@/lib/encryption";
import {
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  OS_ENVELOPE_IV,
  credentialStoreStatus,
  isOsEnvelopeIv,
  credentialNeedsOsMigration,
  resolveApiKeySecret,
  sealApiKeySecret,
  type CredentialStoreDeps,
} from "@/lib/ai/credential-store";
import { resolveByokCredential } from "@/lib/ai/byok";

const require = createRequire(import.meta.url);
const { startCredentialBroker } = require("../desktop/main/credential-broker.js");

const TOKEN = "credential-store-spec-token";
const LEGACY_SALT = "jobsync-api-key-encryption";
const ENC_KEY = "credential-store-spec-key";

// safeStorage stand-in: ciphertext is tagged with the owning OS user; a
// blob sealed under a different tag throws on decrypt — the DPAPI shape.
function storage(tag = "userA") {
  const marker = `dpapi:${tag}:`;
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "dpapi",
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from(marker), Buffer.from(value, "utf8")]),
    decryptString: (buffer: Buffer) => {
      const raw = Buffer.from(buffer).toString("utf8");
      if (!raw.startsWith(marker)) throw new Error("decrypt failed");
      const out = raw.slice(marker.length);
      if (!out) throw new Error("decrypt failed");
      return out;
    },
  };
}

// A pre-v1 row: fixed LEGACY_SALT PBKDF2 + AES-256-GCM, iv holds no ".".
function legacySeal(plaintext: string): { encrypted: string; iv: string } {
  const key = pbkdf2Sync(ENC_KEY, LEGACY_SALT, 100_000, 32, "sha256");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encrypted: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

interface RunningBroker {
  url: string;
  env: Record<string, string>;
  close: () => Promise<void>;
}

async function startBroker(safeStorage: unknown): Promise<RunningBroker> {
  const broker = await startCredentialBroker({ token: TOKEN, safeStorage });
  return {
    url: broker.url,
    env: {
      VOCATRYA_CREDENTIAL_URL: broker.url,
      VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
      ENCRYPTION_KEY: ENC_KEY,
    },
    close: () =>
      new Promise((resolve) => {
        broker.server.close(resolve);
      }),
  };
}

function fakeDb(row: { id: string; encryptedKey: string; iv: string } | null) {
  return {
    apiKey: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(() => Promise.resolve()),
    },
  };
}

let broker: RunningBroker | undefined;
let brokerEnv: Record<string, string>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
  broker = await startBroker(storage("userA"));
  brokerEnv = broker.env;
});

afterAll(async () => {
  await broker?.close();
});

describe("resolveApiKeySecret — format dispatch", () => {
  it("passes through non-sensitive plaintext rows (iv === \"\")", async () => {
    await expect(
      resolveApiKeySecret({ encryptedKey: "http://127.0.0.1:11434", iv: "" }),
    ).resolves.toBe("http://127.0.0.1:11434");
  });

  it("decrypts a v1 per-record-salt row without any broker", async () => {
    const { encrypted, iv } = encrypt("sk-v1-secret");
    expect(iv).toContain(".");
    await expect(
      resolveApiKeySecret({ encryptedKey: encrypted, iv }),
    ).resolves.toBe("sk-v1-secret");
  });

  it("decrypts a LEGACY_SALT row whose iv carries no dot", async () => {
    const legacy = legacySeal("sk-legacy-secret");
    expect(legacy.iv).not.toContain(".");
    await expect(
      resolveApiKeySecret({ encryptedKey: legacy.encrypted, iv: legacy.iv }),
    ).resolves.toBe("sk-legacy-secret");
  });

  it("unseals an os:v1 row through the broker", async () => {
    const sealed = await sealApiKeySecret("sk-os-secret", { env: brokerEnv });
    expect(sealed.iv).toBe(OS_ENVELOPE_IV);
    expect(sealed.encryptedKey).not.toContain("sk-os-secret");
    await expect(
      resolveApiKeySecret(sealed, { env: brokerEnv }),
    ).resolves.toBe("sk-os-secret");
  });

  it("rejects an unknown os:* envelope revision", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveApiKeySecret(
        { encryptedKey: "QUJD", iv: "os:v9" },
        { env: brokerEnv, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPT_FAILED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed os blob without calling the broker", async () => {
    const fetchImpl = vi.fn();
    for (const blob of ["not base64!!!", "", "QUJD=", "A".repeat(50 * 1024)]) {
      await expect(
        resolveApiKeySecret(
          { encryptedKey: blob, iv: OS_ENVELOPE_IV },
          { env: brokerEnv, fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPT_FAILED" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails os rows when no broker URL is configured (web opening a desktop DB)", async () => {
    const sealed = await sealApiKeySecret("sk-os-secret", { env: brokerEnv });
    await expect(
      resolveApiKeySecret(sealed, { env: { ENCRYPTION_KEY: ENC_KEY } }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });

  it("maps a foreign-OS-context blob to DECRYPT_FAILED", async () => {
    const sealed = await sealApiKeySecret("sk-os-secret", { env: brokerEnv });
    await expect(
      resolveApiKeySecret(sealed, {
        env: brokerEnv,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: false, code: "CREDENTIAL_DECRYPT_FAILED" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPT_FAILED" });
  });
});

describe("sealApiKeySecret — write policy", () => {
  it("seals through the broker on a desktop backend (iv = os:v1)", async () => {
    const sealed = await sealApiKeySecret("sk-new-desktop-key", { env: brokerEnv });
    expect(sealed.iv).toBe(OS_ENVELOPE_IV);
    await expect(
      resolveApiKeySecret(sealed, { env: brokerEnv }),
    ).resolves.toBe("sk-new-desktop-key");
  });

  it("keeps the v1 application cipher when no broker exists (web/docker/dev)", async () => {
    const sealed = await sealApiKeySecret("sk-web-key", {
      env: { ENCRYPTION_KEY: ENC_KEY },
    });
    expect(sealed.iv).toContain(".");
    await expect(
      resolveApiKeySecret(sealed, { env: { ENCRYPTION_KEY: ENC_KEY } }),
    ).resolves.toBe("sk-web-key");
  });

  it("fails closed on a desktop backend when the broker is down — no downgrade", async () => {
    const dead = {
      VOCATRYA_CREDENTIAL_URL: "http://127.0.0.1:9/",
      VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
      ENCRYPTION_KEY: ENC_KEY,
    };
    await expect(
      sealApiKeySecret("sk-no-downgrade", { env: dead }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });

  it("rejects non-loopback or malformed broker URLs", async () => {
    for (const url of [
      "https://127.0.0.1:1234/",
      "http://localhost:1234/",
      "http://user:pw@127.0.0.1:1234/",
      "http://127.0.0.1:1234/credential",
      "not a url",
    ]) {
      await expect(
        sealApiKeySecret("sk-x", {
          env: {
            VOCATRYA_CREDENTIAL_URL: url,
            VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
            ENCRYPTION_KEY: ENC_KEY,
          },
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    }
  });

  it("fails when the internal token is missing from a desktop backend", async () => {
    await expect(
      sealApiKeySecret("sk-x", {
        env: { VOCATRYA_CREDENTIAL_URL: brokerEnv.VOCATRYA_CREDENTIAL_URL },
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });
});

describe("credentialStoreStatus", () => {
  it("reports os-backed availability from the live broker", async () => {
    const status = await credentialStoreStatus({ env: brokerEnv });
    expect(status).toEqual({ mode: "os-backed", available: true, backend: "dpapi" });
  });

  it("reports the app-cipher contract when no broker URL exists", async () => {
    await expect(
      credentialStoreStatus({ env: { ENCRYPTION_KEY: ENC_KEY } }),
    ).resolves.toEqual({ mode: "app-cipher", available: true, backend: null });
    await expect(credentialStoreStatus({ env: {} })).resolves.toEqual({
      mode: "app-cipher",
      available: false,
      backend: null,
    });
  });

  it("reports unavailable (never errors) when the broker is unreachable", async () => {
    await expect(
      credentialStoreStatus({
        env: {
          VOCATRYA_CREDENTIAL_URL: "http://127.0.0.1:9/",
          VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
        },
      }),
    ).resolves.toEqual({ mode: "os-backed", available: false, backend: null });
  });

  it("reports unavailable when the OS store itself is gated off", async () => {
    const off = await startBroker({ ...storage(), isEncryptionAvailable: () => false });
    try {
      const status = await credentialStoreStatus({ env: off.env });
      expect(status.mode).toBe("os-backed");
      expect(status.available).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe("resolveByokCredential — os rows and boundaries", () => {
  const connection = (id: string) => ({
    credentialRef: id,
    provider: "DEEPSEEK",
  });

  it("resolves an os:v1 row to plaintext for an explicit BYOK connection", async () => {
    const sealed = await sealApiKeySecret("sk-byok-os-key", { env: brokerEnv });
    const row = { id: "k-os-1", encryptedKey: sealed.encryptedKey, iv: sealed.iv };
    await expect(
      resolveByokCredential(
        { userId: "user-1", connection: connection(row.id) },
        fakeDb(row) as never,
        { env: brokerEnv },
      ),
    ).resolves.toBe("sk-byok-os-key");
  });

  it("still resolves a v1 row — the compatibility path is intact", async () => {
    const { encrypted, iv } = encrypt("sk-v1-still-works");
    const row = { id: "k-v1-1", encryptedKey: encrypted, iv };
    await expect(
      resolveByokCredential(
        { userId: "user-1", connection: connection(row.id) },
        fakeDb(row) as never,
        { env: brokerEnv },
      ),
    ).resolves.toBe("sk-v1-still-works");
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE when the OS store cannot be reached", async () => {
    const sealed = await sealApiKeySecret("sk-byok-os-key", { env: brokerEnv });
    const row = { id: "k-os-2", encryptedKey: sealed.encryptedKey, iv: sealed.iv };
    const deps: CredentialStoreDeps = {
      env: {
        VOCATRYA_CREDENTIAL_URL: "http://127.0.0.1:9/",
        VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
      },
    };
    await expect(
      resolveByokCredential(
        { userId: "user-1", connection: connection(row.id) },
        fakeDb(row) as never,
        deps,
      ),
    ).rejects.toMatchObject({ code: "BYOK_CREDENTIAL_UNAVAILABLE" });
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE on a foreign-context blob (other OS user)", async () => {
    const sealed = await sealApiKeySecret("sk-foreign-user", { env: brokerEnv });
    const row = { id: "k-os-3", encryptedKey: sealed.encryptedKey, iv: sealed.iv };
    // Simulate the same row decrypted under a different OS user: the broker
    // answers CREDENTIAL_DECRYPT_FAILED.
    const foreignDeps: CredentialStoreDeps = {
      env: brokerEnv,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, code: "CREDENTIAL_DECRYPT_FAILED" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    };
    await expect(
      resolveByokCredential(
        { userId: "user-1", connection: connection(row.id) },
        fakeDb(row) as never,
        foreignDeps,
      ),
    ).rejects.toMatchObject({
      code: "BYOK_CREDENTIAL_UNAVAILABLE",
    });
  });

  it("an unauthorized backend caller cannot unseal — 401 maps to UNAVAILABLE", async () => {
    const sealed = await sealApiKeySecret("sk-byok-os-key", { env: brokerEnv });
    await expect(
      resolveApiKeySecret(sealed, {
        env: {
          VOCATRYA_CREDENTIAL_URL: brokerEnv.VOCATRYA_CREDENTIAL_URL,
          VOCATRYA_DESKTOP_INTERNAL_TOKEN: "wrong-token",
        },
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  });
});

describe("helpers and leakage boundaries", () => {
  it("classifies iv discriminators correctly", () => {
    expect(isOsEnvelopeIv("os:v1")).toBe(true);
    expect(isOsEnvelopeIv("os:v2")).toBe(true);
    expect(isOsEnvelopeIv("")).toBe(false);
    expect(isOsEnvelopeIv("abc.def")).toBe(false);
    expect(isOsEnvelopeIv("abc")).toBe(false);
    expect(credentialNeedsOsMigration({ iv: "" })).toBe(false);
    expect(credentialNeedsOsMigration({ iv: "os:v1" })).toBe(false);
    expect(credentialNeedsOsMigration({ iv: "abc.def" })).toBe(true);
    expect(credentialNeedsOsMigration({ iv: "abc" })).toBe(true);
  });

  it("error messages never carry key material", async () => {
    const secret = "sk-leak-guard-9f8e7d6c";
    try {
      await resolveApiKeySecret(
        { encryptedKey: "QUJD", iv: OS_ENVELOPE_IV },
        {
          env: {
            VOCATRYA_CREDENTIAL_URL: "http://127.0.0.1:9/",
            VOCATRYA_DESKTOP_INTERNAL_TOKEN: secret,
          },
        },
      );
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("QUJD");
    }
    try {
      await sealApiKeySecret(secret, {
        env: {
          VOCATRYA_CREDENTIAL_URL: "http://127.0.0.1:9/",
          VOCATRYA_DESKTOP_INTERNAL_TOKEN: TOKEN,
        },
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as CredentialStoreError).code).toBe(
        CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
      );
    }
  });
});
