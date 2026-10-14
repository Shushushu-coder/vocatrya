// @vitest-environment node
/**
 * BYOK (Custom API Key) → AIConnection bridge.
 *
 * Covers:
 * - classifyAIConnection: well-formed API_KEY/LOCAL_BYOK binding vs malformed
 * - ApiKey lifecycle sync: save upserts CONNECTED, delete degrades to
 *   DISCONNECTED, read-path self-heal creates connections for pre-bridge keys
 * - resolveByokCredential: strict credentialRef binding — a missing or
 *   foreign-owned key fails BYOK_CREDENTIAL_UNAVAILABLE and NEVER falls
 *   through to env vars or defaults
 * - assignments: a BYOK connection resolves RESOLVED with LOCAL_BYOK;
 *   key deletion makes the same assignment INVALID_ASSIGNMENT
 * - executeAIConnectionText: BYOK runs the AI SDK in-process — the desktop
 *   loopback channel and ticket mint are never touched
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  classifyAIConnection,
  AIBusinessError,
} from "@/lib/ai/connections";
import {
  ensureByokConnectionsForUser,
  markByokConnectionDisconnected,
  resolveByokCredential,
  upsertByokConnectionForApiKey,
} from "@/lib/ai/byok";
import {
  resolveBusinessAIConfig,
  setBusinessAssignment,
} from "@/lib/ai/assignments";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { encrypt } from "@/lib/encryption";
import type { generateText } from "ai";
import { seedAccount } from "./helpers/backupTestDb";

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

let userId: string;
let otherUserId: string;

async function saveApiKeyRow(provider: string, plaintext: string) {
  const sealed = encrypt(plaintext);
  return prisma.apiKey.create({
    data: {
      userId,
      provider,
      encryptedKey: sealed.encrypted,
      iv: sealed.iv,
      last4: plaintext.slice(-4),
    },
  });
}

async function byokConnectionRow(provider = "DEEPSEEK") {
  return prisma.aIConnection.findFirstOrThrow({
    where: {
      userId,
      provider,
      backendKind: "LOCAL_BYOK",
      authType: "API_KEY",
    },
  });
}

async function cleanup() {
  await prisma.aIBusinessAssignment.deleteMany();
  await prisma.aIConnection.deleteMany();
  await prisma.apiKey.deleteMany();
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "byok-spec-test-key";
  userId = await seedAccount(prisma, "byok@example.com");
  otherUserId = await seedAccount(prisma, "byok-other@example.com");
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const fs = await import("node:fs");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

beforeEach(cleanup);

describe("classifyAIConnection — BYOK identity", () => {
  const wellFormed = {
    provider: "DEEPSEEK",
    backendKind: "LOCAL_BYOK",
    authType: "API_KEY",
    credentialRef: "9b2d1c2a-0000-4000-8000-000000000001",
    runtimeProfileRef: null,
    accountIdentity: null,
  };

  it("classifies a well-formed API_KEY binding as BYOK", () => {
    expect(classifyAIConnection(wellFormed)).toBe("BYOK");
  });

  it("rejects credentialRef that is not an ApiKey row id", () => {
    expect(
      classifyAIConnection({ ...wellFormed, credentialRef: "sk-live-key" }),
    ).toBe("INVALID");
  });

  it("rejects a BYOK row carrying a runtime profile", () => {
    expect(
      classifyAIConnection({
        ...wellFormed,
        runtimeProfileRef: `rp_${randomUUID()}`,
      }),
    ).toBe("INVALID");
  });

  it("rejects an unknown BYOK provider", () => {
    expect(
      classifyAIConnection({ ...wellFormed, provider: "GROK" }),
    ).toBe("INVALID");
  });

  it("rejects API_KEY on a runtime backend", () => {
    expect(
      classifyAIConnection({ ...wellFormed, backendKind: "CODEX_RUNTIME" }),
    ).toBe("INVALID");
  });
});

describe("BYOK connection lifecycle", () => {
  it("upserts a CONNECTED connection bound to the saved ApiKey", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    expect(connection.status).toBe("CONNECTED");
    expect(connection.credentialRef).toBe(key.id);
    expect(connection.runtimeProfileRef).toBeNull();
    expect(connection.providerMetadata).toBeNull();
    // Re-saving rebinds the new row id and keeps CONNECTED.
    const key2 = await prisma.apiKey.update({
      where: { id: key.id },
      data: {},
    });
    await upsertByokConnectionForApiKey({ userId, apiKey: key2 });
    expect((await byokConnectionRow()).credentialRef).toBe(key2.id);
  });

  it("degrades to DISCONNECTED when the ApiKey is deleted", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    await markByokConnectionDisconnected({ userId, provider: "deepseek" });
    const connection = await byokConnectionRow();
    expect(connection.status).toBe("DISCONNECTED");
    // The credential binding survives for the audit trail — assignments
    // still resolve to this row and fail explicitly at run time.
    expect(connection.credentialRef).toBe(key.id);
  });

  it("self-heals a pre-bridge ApiKey row into a connection on read", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await ensureByokConnectionsForUser(userId);
    const connection = await byokConnectionRow();
    expect(connection.status).toBe("CONNECTED");
    expect(connection.credentialRef).toBe(key.id);
  });

  it("self-heals an orphaned connection to DISCONNECTED", async () => {
    await prisma.aIConnection.create({
      data: {
        userId,
        provider: "DEEPSEEK",
        backendKind: "LOCAL_BYOK",
        authType: "API_KEY",
        displayName: "DeepSeek (API key)",
        status: "CONNECTED",
        credentialRef: randomUUID(),
      },
    });
    await ensureByokConnectionsForUser(userId);
    expect((await byokConnectionRow()).status).toBe("DISCONNECTED");
  });
});

describe("resolveByokCredential — strict binding, fail closed", () => {
  it("decrypts the bound ApiKey row", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-real-secret-value");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    const credential = await resolveByokCredential({ userId, connection });
    expect(credential).toBe("sk-real-secret-value");
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE when the bound row is gone", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-real-secret-value");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    await prisma.apiKey.delete({ where: { id: key.id } });
    await expect(
      resolveByokCredential({ userId, connection }),
    ).rejects.toMatchObject({ code: "BYOK_CREDENTIAL_UNAVAILABLE" });
  });

  it("never substitutes an env credential for a dead binding", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env-must-not-leak";
    try {
      await expect(
        resolveByokCredential({
          userId,
          connection: { credentialRef: randomUUID(), provider: "DEEPSEEK" },
        }),
      ).rejects.toMatchObject({ code: "BYOK_CREDENTIAL_UNAVAILABLE" });
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("rejects another user's ApiKey row", async () => {
    const sealed = encrypt("sk-foreign");
    const foreign = await prisma.apiKey.create({
      data: {
        userId: otherUserId,
        provider: "deepseek",
        encryptedKey: sealed.encrypted,
        iv: sealed.iv,
        last4: "eign",
      },
    });
    await expect(
      resolveByokCredential({
        userId,
        connection: { credentialRef: foreign.id, provider: "DEEPSEEK" },
      }),
    ).rejects.toMatchObject({ code: "BYOK_CREDENTIAL_UNAVAILABLE" });
  });
});

describe("BYOK assignments", () => {
  it("saves and resolves a BYOK connection + provider model", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    const saved = await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: connection.id,
      model: "deepseek-chat",
    });
    expect(saved.connectionId).toBe(connection.id);
    const resolution = await resolveBusinessAIConfig({
      userId,
      purpose: "RESUME",
    });
    expect(resolution).toMatchObject({
      status: "RESOLVED",
      connectionId: connection.id,
      model: "deepseek-chat",
      provider: "DEEPSEEK",
      backendKind: "LOCAL_BYOK",
    });
  });

  it("fails INVALID_ASSIGNMENT after the bound key is deleted", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: connection.id,
      model: "deepseek-chat",
    });
    await prisma.apiKey.delete({ where: { id: key.id } });
    await markByokConnectionDisconnected({ userId, provider: "deepseek" });
    const resolution = await resolveBusinessAIConfig({
      userId,
      purpose: "RESUME",
    });
    expect(resolution.status).toBe("INVALID_ASSIGNMENT");
    if (resolution.status !== "INVALID_ASSIGNMENT") return;
    expect(resolution.code).toBe("CONNECTION_DISCONNECTED");
    expect(resolution.connectionId).toBe(connection.id);
  });

  it("coexists with account-login and managed connections", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-byok-test-1234");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const byok = await byokConnectionRow();
    const account = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        authType: "ACCOUNT_LOGIN",
        displayName: "ChatGPT via Codex",
        status: "CONNECTED",
        runtimeProfileRef: `rp_${randomUUID()}`,
      },
    });
    const managed = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        authType: "MANAGED",
        displayName: "Vocatrya Managed AI",
        status: "CONNECTED",
      },
    });
    expect(classifyAIConnection(byok)).toBe("BYOK");
    expect(classifyAIConnection(account)).toBe("ACCOUNT_LOGIN");
    expect(classifyAIConnection(managed)).toBe("MANAGED");
  });
});

describe("executeAIConnectionText — BYOK branch", () => {
  it("executes through the AI SDK, never the desktop channel", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-exec-key-0001");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    const fetchImpl = vi.fn();
    const generateTextImpl = vi.fn(async () => ({
      text: "byok reply",
      finishReason: "stop",
    })) as unknown as typeof generateText;
    const result = await executeAIConnectionText(
      {
        userId,
        connectionId: connection.id,
        model: "deepseek-chat",
        prompt: "hello",
        operationId: "op-byok-1",
      },
      { fetchImpl, generateTextImpl },
    );
    expect(result.text).toBe("byok reply");
    expect(result.provider).toBe("DEEPSEEK");
    expect(result.backendKind).toBe("LOCAL_BYOK");
    // No ticketed loopback call happened at all.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(generateTextImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the bound key is gone — no credential fallback", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-exec-key-0001");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    await prisma.apiKey.delete({ where: { id: key.id } });
    const fetchImpl = vi.fn();
    await expect(
      executeAIConnectionText(
        {
          userId,
          connectionId: connection.id,
          model: "deepseek-chat",
          prompt: "hello",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "BYOK_CREDENTIAL_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a DISCONNECTED BYOK connection fails CONNECTION_DISCONNECTED", async () => {
    const key = await saveApiKeyRow("deepseek", "sk-exec-key-0001");
    await upsertByokConnectionForApiKey({ userId, apiKey: key });
    const connection = await byokConnectionRow();
    await markByokConnectionDisconnected({ userId, provider: "deepseek" });
    await expect(
      executeAIConnectionText({
        userId,
        connectionId: connection.id,
        model: "deepseek-chat",
        prompt: "hello",
      }),
    ).rejects.toBeInstanceOf(AIBusinessError);
  });
});
