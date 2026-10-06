// @vitest-environment node
// ChatConversation AI-lock backup semantics:
//   - the lock columns export and restore with the row
//   - a connection that IS in the ZIP remaps (fresh id, lock follows it)
//   - a lock pointing at a connection NOT in the ZIP keeps the raw id —
//     it reports unavailable at run time instead of silently going legacy
import { PrismaClient } from "@prisma/client";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { buildCreateData, IdMap } from "@/lib/backup/idmap";
import { BackupDataSchema } from "@/lib/backup/schema";
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
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let connectionId: string;
const messages = JSON.stringify([
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
]);

beforeAll(async () => {
  userId = await seedAccount(
    prisma,
    `chat-lock-backup-${Date.now()}@example.com`,
  );
  const connection = await prisma.aIConnection.create({
    data: {
      userId,
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
      displayName: "Devin runtime",
      status: "CONNECTED",
      runtimeProfileRef: `rp_${Date.now()}`,
    },
  });
  connectionId = connection.id;
  await prisma.chatConversation.create({
    data: {
      userId,
      messages,
      revision: 12, activeRequestId: "old-execution", activeRequestExpiresAt: new Date(Date.now() + 300000),
      resolvedConnectionId: connectionId,
      resolvedModel: "swe-2",
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ChatConversation lock backup", () => {
  it("restores the conversation with the lock remapped to the new connection id", async () => {
    const { buffer } = await buildBackupZip(userId, "owner@example.com");
    const result = await importBackup(buffer, userId, "owner@example.com", true);
    expect(result.counts.ChatConversation).toBe(1);

    const restored = await prisma.chatConversation.findFirstOrThrow({
      where: { userId },
    });
    expect(restored.messages).toBe(messages);
    expect(restored).toMatchObject({ revision: 0, activeRequestId: null, activeRequestExpiresAt: null });
    const { admitConversationRequest, cancelConversationRequest } = await import("@/lib/agent/conversationRequest");
    const admitted = await admitConversationRequest({ userId, conversationId: restored.id, expectedRevision: 0, requestId: "after-restore", operation: "send", newMessage: { id: "fresh", role: "user", parts: [{ type: "text", text: "hello" }] } }, prisma);
    expect(admitted.revision).toBe(1);
    await cancelConversationRequest(userId, restored.id, "after-restore", prisma);
    expect(restored.resolvedModel).toBe("swe-2");
    // Remapped, not copied verbatim — the restored AIConnection has a fresh
    // id, and the lock followed it.
    const connection = await prisma.aIConnection.findFirstOrThrow({
      where: { userId },
    });
    expect(connection.id).not.toBe(connectionId);
    expect(restored.resolvedConnectionId).toBe(connection.id);
  }, 120_000);

  it("a legacy backup without the group still parses (group defaults to [])", async () => {
    // Backups taken before this change carry no ChatConversation key at all.
    const parsed = BackupDataSchema.safeParse({
      Company: [],
      AIConnection: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ChatConversation).toEqual([]);
    }
  });

  it("buildCreateData keeps a dangling lock pointer raw", () => {
    const idMap = new IdMap();
    idMap.set("conv-old", "conv-new");
    const data = buildCreateData(
      "ChatConversation",
      {
        id: "conv-old",
        userId: "anyone", // server supplies the owner
        messages: "[]",
        resolvedConnectionId: "ghost-conn",
        resolvedModel: "m",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      idMap,
      "user-1",
    );
    expect(data.id).toBe("conv-new");
    expect(data.userId).toBe("user-1");
    // Not nulled, not remapped — the raw provenance survives so the run-time
    // check can say ASSIGNED_CONNECTION_UNAVAILABLE.
    expect(data.resolvedConnectionId).toBe("ghost-conn");
  });
});
