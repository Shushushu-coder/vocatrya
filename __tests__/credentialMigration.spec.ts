// @vitest-environment node
/**
 * BYOK credential migration — the explicit legacy→os:v1 upgrade (design §5).
 *
 * Real disposable SQLite DB + the REAL desktop credential broker on an
 * ephemeral loopback port (tagged-marker safeStorage stand-in). Synthetic
 * keys only — no real credential is ever touched.
 *
 * Covers the full §5 matrix: format identification, seal + pre-write
 * round-trip, single-row CAS, post-write re-read verification, concurrent
 * conflict, interruption, crash recovery via the durable journal, and the
 * guarantee that a failed migration never leaves a CONNECTED projection.
 */
import fs from "node:fs";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { encrypt } from "@/lib/encryption";
import {
  OS_ENVELOPE_IV,
  resolveApiKeySecret,
  sealApiKeySecret,
} from "@/lib/ai/credential-store";
import {
  CREDENTIAL_MIGRATION_REASON_CODES,
  createCredentialMigrationJournal,
  migrateByokCredentialsForUser,
  restoreCredentialRowFromJournal,
} from "@/lib/ai/credential-migration";
import { resolveByokCredential } from "@/lib/ai/byok";
import { saveApiKey, getUserApiKeys } from "@/actions/apiKey.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { seedAccount } from "./helpers/backupTestDb";

vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
const mockedGetCurrentUser = vi.mocked(getCurrentUser);

const require = createRequire(import.meta.url);
const { startCredentialBroker } = require("../desktop/main/credential-broker.js");

const TOKEN = "credential-migration-spec-token";
const LEGACY_SALT = "jobsync-api-key-encryption";
const ENC_KEY = "credential-migration-spec-key";
const JOURNAL_FILE = "credential-migration-recovery.jsonl";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

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
  server: { close: (cb: () => void) => void };
}

let broker: RunningBroker | null = null;
const journalDir = ctx.dir;

async function startBroker() {
  broker = (await startCredentialBroker({
    token: TOKEN,
    safeStorage: storage("userA"),
  })) as RunningBroker;
  process.env.VOCATRYA_CREDENTIAL_URL = broker.url;
  process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN = TOKEN;
}

async function stopBroker(keepUrl = false) {
  if (!broker) return;
  const b = broker;
  broker = null;
  await new Promise<void>((resolve) => b.server.close(resolve));
  if (!keepUrl) delete process.env.VOCATRYA_CREDENTIAL_URL;
}

let userId: string;

async function addRow(
  provider: string,
  plaintext: string,
  format: "v1" | "legacy" | "plaintext" | "os",
) {
  let data: { encryptedKey: string; iv: string };
  if (format === "v1") {
    const sealed = encrypt(plaintext);
    data = { encryptedKey: sealed.encrypted, iv: sealed.iv };
  } else if (format === "legacy") {
    const sealed = legacySeal(plaintext);
    data = { encryptedKey: sealed.encrypted, iv: sealed.iv };
  } else if (format === "plaintext") {
    data = { encryptedKey: plaintext, iv: "" };
  } else {
    const sealed = await sealApiKeySecret(plaintext);
    data = { encryptedKey: sealed.encryptedKey, iv: sealed.iv };
  }
  return prisma.apiKey.create({
    data: {
      userId,
      provider,
      encryptedKey: data.encryptedKey,
      iv: data.iv,
      last4: plaintext.slice(-4),
    },
  });
}

async function addByokConnection(provider: string, apiKeyId: string, status = "CONNECTED") {
  const byokProvider = provider.toUpperCase();
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: byokProvider,
      backendKind: "LOCAL_BYOK",
      authType: "API_KEY",
      displayName: `${byokProvider} (API key)`,
      status,
      credentialRef: apiKeyId,
    },
  });
}

async function cleanup() {
  await prisma.aIBusinessAssignment.deleteMany();
  await prisma.aIConnection.deleteMany();
  await prisma.apiKey.deleteMany();
  const journalPath = `${journalDir}/${JOURNAL_FILE}`;
  if (fs.existsSync(journalPath)) fs.rmSync(journalPath);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
  userId = await seedAccount(prisma, "cred-migration@example.com");
  await startBroker();
}, 240_000);

afterAll(async () => {
  await stopBroker();
  await prisma.$disconnect();
  delete process.env.ENCRYPTION_KEY;
});

beforeEach(() => {
  mockedGetCurrentUser.mockResolvedValue({ id: userId } as never);
});

afterEach(async () => {
  await cleanup();
});

const migrateDeps = () => ({ journalDir });

describe("happy path — format identification through verified os envelope", () => {
  it("migrates a v1 row: CAS write, verified resolve, connection untouched", async () => {
    const row = await addRow("openai", "sk-mig-openai-v1", "v1");
    const conn = await addByokConnection("openai", row.id);
    const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(summary.migrated).toEqual([
      { apiKeyId: row.id, provider: "openai" },
    ]);
    expect(summary.failed).toEqual([]);
    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.iv).toBe(OS_ENVELOPE_IV);
    expect(after.encryptedKey).not.toContain("sk-mig-openai-v1");
    await expect(resolveApiKeySecret(after)).resolves.toBe("sk-mig-openai-v1");
    await expect(
      resolveByokCredential(
        { userId, connection: { credentialRef: row.id, provider: "OPENAI" } },
        prisma,
      ),
    ).resolves.toBe("sk-mig-openai-v1");
    expect((await prisma.aIConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("CONNECTED");
  });

  it("migrates a LEGACY_SALT row (iv without a dot)", async () => {
    const row = await addRow("deepseek", "sk-mig-legacy", "legacy");
    const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(summary.migrated).toEqual([
      { apiKeyId: row.id, provider: "deepseek" },
    ]);
    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.iv).toBe(OS_ENVELOPE_IV);
    await expect(resolveApiKeySecret(after)).resolves.toBe("sk-mig-legacy");
  });

  it("skips plaintext and already-os rows; a mixed batch migrates cleanly", async () => {
    const v1 = await addRow("openai", "sk-mix-v1", "v1");
    const plain = await addRow("ollama", "http://127.0.0.1:11434", "plaintext");
    const os = await addRow("gemini", "sk-mix-os", "os");
    const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(summary.migrated.map((m) => m.apiKeyId)).toEqual([v1.id]);
    expect(
      summary.skipped.find((s) => s.apiKeyId === plain.id)?.reason,
    ).toBe("non-sensitive");
    expect(
      summary.skipped.find((s) => s.apiKeyId === os.id)?.reason,
    ).toBe("already-os-envelope");
    expect(summary.failed).toEqual([]);
    // Idempotent: a second run migrates nothing.
    const second = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(second.migrated).toEqual([]);
    expect(second.failed).toEqual([]);
  });
});

describe("CAS, interruption, and recovery", () => {
  it("a concurrent save wins the CAS — migration reports WRITE_CONFLICT and steps aside", async () => {
    const row = await addRow("openai", "sk-cas-before", "v1");
    const summary = await migrateByokCredentialsForUser(userId, {
      ...migrateDeps(),
      beforeCasWrite: async (rowId) => {
        // A user save lands between journal and CAS — rewrites the row.
        const fresh = encrypt("sk-cas-concurrent-save");
        await prisma.apiKey.update({
          where: { id: rowId },
          data: { encryptedKey: fresh.encrypted, iv: fresh.iv },
        });
      },
    });
    expect(summary.migrated).toEqual([]);
    expect(summary.failed).toEqual([
      {
        apiKeyId: row.id,
        provider: "openai",
        reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.WRITE_CONFLICT,
      },
    ]);
    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    await expect(resolveApiKeySecret(after)).resolves.toBe(
      "sk-cas-concurrent-save",
    );
  });

  it("an interrupt before the CAS leaves the row untouched; re-run still migrates", async () => {
    const row = await addRow("openai", "sk-interrupt", "v1");
    const first = await migrateByokCredentialsForUser(userId, {
      ...migrateDeps(),
      beforeCasWrite: () => {
        throw new Error("simulated crash");
      },
    });
    expect(first.migrated).toEqual([]);
    expect(first.failed).toHaveLength(1);
    const mid = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    expect(mid.iv).not.toBe(OS_ENVELOPE_IV);
    await expect(resolveApiKeySecret(mid)).resolves.toBe("sk-interrupt");
    const second = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(second.migrated.map((m) => m.apiKeyId)).toEqual([row.id]);
  });

  it("post-write verify failure restores the journaled ciphertext (VERIFY_FAILED)", async () => {
    const row = await addRow("openai", "sk-verify-fail", "v1");
    const before = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    const summary = await migrateByokCredentialsForUser(userId, {
      ...migrateDeps(),
      afterCasWrite: async () => {
        await stopBroker();
      },
    });
    try {
      expect(summary.migrated).toEqual([]);
      expect(summary.failed).toEqual([
        {
          apiKeyId: row.id,
          provider: "openai",
          reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.VERIFY_FAILED,
        },
      ]);
      const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.iv).toBe(before.iv);
      expect(after.encryptedKey).toBe(before.encryptedKey);
      await expect(resolveApiKeySecret(after)).resolves.toBe("sk-verify-fail");
    } finally {
      await startBroker();
    }
  });

  it("ops-level restoreCredentialRowFromJournal recovers a stranded migrated row", async () => {
    const row = await addRow("openai", "sk-ops-restore", "v1");
    const before = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    const summary = await migrateByokCredentialsForUser(userId, {
      ...migrateDeps(),
      afterCasWrite: async () => {
        await stopBroker();
      },
    });
    try {
      expect(summary.failed[0]?.reasonCode).toBe(
        CREDENTIAL_MIGRATION_REASON_CODES.VERIFY_FAILED,
      );
      // Simulate the row being left holding the os blob (e.g. restore raced):
      const sealedNow = await prisma.apiKey.findUniqueOrThrow({
        where: { id: row.id },
      });
      // Row was restored already; re-apply the migrated value to model a
      // crash that landed after CAS but before restore:
      const journal = createCredentialMigrationJournal(journalDir);
      const entry = journal.latest(row.id);
      expect(entry).not.toBeNull();
      await prisma.apiKey.update({
        where: { id: row.id },
        data: {
          encryptedKey: entry!.migratedEncryptedKey,
          iv: entry!.migratedIv,
        },
      });
      const outcome = await restoreCredentialRowFromJournal(row.id, {
        db: prisma,
        journalDir,
      });
      expect(outcome).toBe("restored");
      const restored = await prisma.apiKey.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(restored.iv).toBe(before.iv);
      expect(restored.encryptedKey).toBe(before.encryptedKey);
      expect(sealedNow.id).toBe(row.id);
    } finally {
      await startBroker();
    }
  });

  it("a restore that cannot land marks the connection REAUTH_REQUIRED — never CONNECTED", async () => {
    const row = await addRow("deepseek", "sk-restore-fail", "v1");
    const conn = await addByokConnection("deepseek", row.id);
    const journalPath = `${journalDir}/${JOURNAL_FILE}`;
    const summary = await migrateByokCredentialsForUser(userId, {
      ...migrateDeps(),
      afterCasWrite: async () => {
        // Destroy the recovery record AND kill the broker: verification
        // fails and the journal restore has nothing to apply.
        fs.writeFileSync(journalPath, "not-json\n", "utf8");
        await stopBroker();
      },
    });
    try {
      expect(summary.failed).toEqual([
        {
          apiKeyId: row.id,
          provider: "deepseek",
          reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.RESTORE_FAILED,
        },
      ]);
      const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.iv).toBe(OS_ENVELOPE_IV);
      expect(
        (await prisma.aIConnection.findUniqueOrThrow({ where: { id: conn.id } }))
          .status,
      ).toBe("REAUTH_REQUIRED");
    } finally {
      await startBroker();
    }
  });
});

describe("store unavailability and leakage boundaries", () => {
  it("fails STORE_UNAVAILABLE when the broker is down — rows unchanged", async () => {
    const row = await addRow("openai", "sk-no-broker", "v1");
    await stopBroker();
    try {
      const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
      expect(summary.migrated).toEqual([]);
      expect(summary.failed).toEqual([
        {
          apiKeyId: row.id,
          provider: "openai",
          reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE,
        },
      ]);
      const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      await expect(resolveApiKeySecret(after)).resolves.toBe("sk-no-broker");
    } finally {
      await startBroker();
    }
  });

  it("fails STORE_UNAVAILABLE when no broker is configured at all (web backend)", async () => {
    const row = await addRow("openai", "sk-web-migrate", "v1");
    const url = process.env.VOCATRYA_CREDENTIAL_URL;
    delete process.env.VOCATRYA_CREDENTIAL_URL;
    try {
      const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
      expect(summary.failed).toEqual([
        {
          apiKeyId: row.id,
          provider: "openai",
          reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE,
        },
      ]);
    } finally {
      process.env.VOCATRYA_CREDENTIAL_URL = url;
    }
  });

  it("a corrupted legacy row reports DECRYPT_LEGACY_FAILED and is left alone", async () => {
    const row = await prisma.apiKey.create({
      data: {
        userId,
        provider: "gemini",
        encryptedKey: "AAAA", // valid base64, not a real GCM payload
        iv: "BBBB.CCCC",
        last4: "junk",
      },
    });
    const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
    expect(summary.failed).toEqual([
      {
        apiKeyId: row.id,
        provider: "gemini",
        reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.DECRYPT_LEGACY_FAILED,
      },
    ]);
    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.encryptedKey).toBe("AAAA");
    expect(after.iv).toBe("BBBB.CCCC");
  });

  it("journal entries carry ciphertext only — never plaintext", async () => {
    const secret = "sk-journal-hygiene-9z8y7x";
    await addRow("openai", secret, "v1");
    await migrateByokCredentialsForUser(userId, migrateDeps());
    const journalPath = `${journalDir}/${JOURNAL_FILE}`;
    expect(fs.existsSync(journalPath)).toBe(true);
    const raw = fs.readFileSync(journalPath, "utf8");
    expect(raw).not.toContain(secret);
    const journal = createCredentialMigrationJournal(journalDir);
    expect(journal.entries().length).toBeGreaterThan(0);
  });

  it("summary objects never contain plaintext or ciphertext material", async () => {
    const secret = "sk-summary-hygiene";
    await addRow("openai", secret, "v1");
    const summary = await migrateByokCredentialsForUser(userId, migrateDeps());
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("encryptedKey");
    expect(serialized).not.toContain("iv\":\"os");
  });
});

describe("save path — new keys prefer the OS envelope", () => {
  it("saveApiKey seals through the broker and binds the BYOK connection", async () => {
    const result = await saveApiKey({ provider: "openai", key: "sk-save-os" });
    expect(result.success).toBe(true);
    expect(result.data?.protection).toBe("os");
    expect(result.data?.last4).toBe("e-os");
    expect(JSON.stringify(result)).not.toContain("sk-save-os");
    const row = await prisma.apiKey.findUniqueOrThrow({
      where: { userId_provider: { userId, provider: "openai" } },
    });
    expect(row.iv).toBe(OS_ENVELOPE_IV);
    await expect(
      resolveByokCredential(
        { userId, connection: { credentialRef: row.id, provider: "OPENAI" } },
        prisma,
      ),
    ).resolves.toBe("sk-save-os");
    const conn = await prisma.aIConnection.findFirstOrThrow({
      where: { userId, provider: "OPENAI", backendKind: "LOCAL_BYOK" },
    });
    expect(conn.status).toBe("CONNECTED");
    expect(conn.credentialRef).toBe(row.id);
  });

  it("a configured-but-down broker fails the save — no row, no downgrade", async () => {
    // URL stays injected (the desktop-launched backend state); only the
    // broker process is gone — seal must fail closed, not degrade to v1.
    await stopBroker(true);
    try {
      const result = await saveApiKey({ provider: "openai", key: "sk-no-write" });
      expect(result.success).toBe(false);
      expect(result.code).toBe("CREDENTIAL_STORE_UNAVAILABLE");
      expect(result.message).not.toContain("sk-no-write");
      const row = await prisma.apiKey.findUnique({
        where: { userId_provider: { userId, provider: "openai" } },
      });
      expect(row).toBeNull();
    } finally {
      await startBroker();
    }
  });

  it("a client-supplied sensitive:false cannot downgrade an api-key provider to plaintext", async () => {
    const result = await saveApiKey({
      provider: "openai",
      key: "sk-downgrade-attempt",
      sensitive: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.protection).toBe("os");
    const row = await prisma.apiKey.findUniqueOrThrow({
      where: { userId_provider: { userId, provider: "openai" } },
    });
    expect(row.iv).toBe(OS_ENVELOPE_IV);
    expect(row.encryptedKey).not.toBe("sk-downgrade-attempt");
    const list = await getUserApiKeys();
    const entry = list.data!.find((k) => k.provider === "openai");
    expect(entry?.displayValue).toBeUndefined();
    expect(entry?.protection).toBe("os");
  });

  it("non-sensitive saves keep the plaintext passthrough (Ollama URL)", async () => {
    const result = await saveApiKey({
      provider: "ollama",
      key: "http://127.0.0.1:11434",
      sensitive: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.protection).toBe("none");
    expect(result.data?.displayValue).toBe("http://127.0.0.1:11434");
    const row = await prisma.apiKey.findUniqueOrThrow({
      where: { userId_provider: { userId, provider: "ollama" } },
    });
    expect(row.iv).toBe("");
    expect(row.encryptedKey).toBe("http://127.0.0.1:11434");
  });

  it("getUserApiKeys exposes protection metadata only — never ciphertext", async () => {
    await addRow("openai", "sk-list-os", "os");
    await addRow("deepseek", "sk-list-v1", "v1");
    await addRow("ollama", "http://127.0.0.1:11434", "plaintext");
    const result = await getUserApiKeys();
    expect(result.success).toBe(true);
    const byProvider = new Map(result.data!.map((k) => [k.provider, k]));
    expect(byProvider.get("openai")?.protection).toBe("os");
    expect(byProvider.get("deepseek")?.protection).toBe("app");
    expect(byProvider.get("ollama")?.protection).toBe("none");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-list-os");
    expect(serialized).not.toContain("sk-list-v1");
    expect(serialized).not.toContain("encryptedKey");
    // Sensitive rows carry no displayValue; the plaintext one does.
    expect(byProvider.get("openai")?.displayValue).toBeUndefined();
    expect(byProvider.get("ollama")?.displayValue).toBe(
      "http://127.0.0.1:11434",
    );
  });
});
