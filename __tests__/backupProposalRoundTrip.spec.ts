// @vitest-environment node
/**
 * Durable operation proposals across a real export → wipe → import cycle:
 * the proposal and its evidence travel with the backup, the runtime
 * HarnessTask pointer is nulled (HarnessTask is never backed up, so a
 * stale task id must never impersonate a live execution), and no restored
 * proposal auto-replays an authorization.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
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

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {}
});

it("proposals round-trip; task pointer is cleared, evidence is kept", async () => {
  const userId = await seedAccount(prisma, "prop@example.com");
  const conv = await prisma.chatConversation.create({
    data: { userId, messages: "[]" },
  });
  const task = await prisma.harnessTask.create({
    data: {
      userId,
      kind: "AGENT_TOOL_WRITE",
      status: "QUEUED",
      requestKey: `rk-${randomUUID()}`,
      inputHash: "h",
      inputJson: "{}",
    },
  });
  const old = await prisma.agentOperationProposal.create({
    data: {
      userId,
      conversationId: conv.id,
      toolCallId: `tc-${randomUUID()}`,
      approvalId: `ap-${randomUUID()}`,
      turnKey: "turn-1",
      toolName: "notion_create_page",
      inputJson: JSON.stringify({ title: "Offer log" }),
      inputHash: "h1",
      status: "APPROVED",
      expiresAt: new Date(Date.now() + 3600_000),
      dispatchedAt: new Date(),
      dispatchKey: `dk-${randomUUID()}`,
      outcomeStatus: "UNCERTAIN",
      outcomeJson: JSON.stringify({ saved: false, status: "unknown" }),
      manualResolution: "STILL_UNCERTAIN",
      resolvedAt: new Date(),
      harnessTaskId: task.id,
    },
  });
  await prisma.agentOperationProposal.create({
    data: {
      userId,
      conversationId: conv.id,
      toolCallId: `tc-${randomUUID()}`,
      approvalId: `ap-${randomUUID()}`,
      turnKey: "turn-2",
      toolName: "notion_create_page",
      inputJson: JSON.stringify({ title: "Offer log" }),
      inputHash: "h1",
      status: "PROPOSED",
      expiresAt: new Date(Date.now() + 3600_000),
      supersedesId: old.id,
    },
  });

  const { buffer } = await buildBackupZip(userId, "prop@example.com");
  const before = await prisma.agentOperationProposal.count();

  const result = await importBackup(buffer, userId, "prop@example.com", true);
  expect(result.counts.AgentOperationProposal ?? 0).toBeGreaterThan(0);

  const rows = await prisma.agentOperationProposal.findMany({
    orderBy: { createdAt: "asc" },
  });
  expect(rows).toHaveLength(before);
  const uncertain = rows.find((r) => r.outcomeStatus === "UNCERTAIN")!;
  // The runtime pointer is cleared — a stale task id never impersonates a
  // live execution after restore; the execution evidence itself survives.
  expect(uncertain.harnessTaskId).toBeNull();
  expect(uncertain.dispatchedAt).not.toBeNull();
  expect(uncertain.dispatchKey).not.toBeNull();
  expect(uncertain.manualResolution).toBe("STILL_UNCERTAIN");
  expect(uncertain.outcomeJson).toContain("unknown");
  // The conversation link survives (remapped through the idmap, not dropped).
  expect(uncertain.conversationId).not.toBeNull();
  const pending = rows.find((r) => r.status === "PROPOSED")!;
  expect(pending.supersedesId).toBe(uncertain.id);
  // Restored conversations start inactive — a backup never re-arms auth.
  const restoredConv = await prisma.chatConversation.findFirstOrThrow();
  expect(restoredConv.activeRequestId).toBeNull();
  expect(restoredConv.revision).toBe(0);
});
