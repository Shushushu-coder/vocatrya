// @vitest-environment node
/**
 * Agent task ledger across a real export -> wipe -> import cycle: all three
 * new models travel (AgentTaskEvent included), ids are re-minted and every
 * new FK is remapped (ChatConversation.agentTaskId as a deferred FK), live
 * session claims are cleared, and pre-v11 backups still restore.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BACKUP_FORMAT_VERSION, BackupDataSchema } from "@/lib/backup/schema";
import { backupCoverageStatus } from "@/lib/backup/coverage";
import { createAgentTask, claimAgentTaskSession } from "@/lib/agent/task/agentTaskStore";
import { recordTaskEvent } from "@/lib/agent/task/agentTaskEvents";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

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
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
});

it("classifies every new model as BACKED_UP and bumps the format version", () => {
  for (const model of ["AgentTask", "AgentTaskHandoff", "AgentTaskEvent"]) {
    expect(backupCoverageStatus(model)).toBe("BACKED_UP");
  }
  expect(BACKUP_FORMAT_VERSION).toBe(13);
});

it("round-trips tasks, handoffs and events with remapped FKs and a cleared claim", async () => {
  const userId = await seedAccount(prisma, `bk-task-${randomUUID()}@example.com`);
  const company = await prisma.company.create({
    data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: userId },
  });
  const job = await prisma.jobOpportunity.create({
    data: { userId, companyId: company.id, title: "Staff Engineer" },
  });
  const session = await prisma.chatConversation.create({
    data: { userId, messages: "[]", agentRole: "pilot" },
  });
  const { task } = await createAgentTask(prisma, { userId, jobOpportunityId: job.id });
  const claim = await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: session.id });
  expect(claim.ok).toBe(true);
  await prisma.agentTask.update({
    where: { id: task.id },
    data: {
      acceptanceItems: JSON.stringify([
        { key: "prep-goal-active", label: "x", passes: true, evidenceRef: job.id },
      ]),
      revision: 1,
    },
  });
  await prisma.agentTaskHandoff.create({
    data: { taskId: task.id, revision: 1, state: '{"v":1}', stateHash: "hash", sessionId: session.id },
  });
  await recordTaskEvent(prisma, { userId, taskId: task.id, kind: "STEP", payload: { n: 1 } });

  const data = await collectBackupData(userId);
  expect(data.AgentTask).toHaveLength(1);
  expect(data.AgentTaskHandoff).toHaveLength(1);
  expect(data.AgentTaskEvent.length).toBeGreaterThanOrEqual(3);
  expect(data.ChatConversation[0].agentTaskId).toBe(task.id);

  const { buffer } = await buildBackupZip(userId, "bk-task@example.com");
  const result = await importBackup(buffer, userId, "bk-task@example.com", true);
  expect(result.counts.AgentTask).toBe(1);
  expect(result.counts.AgentTaskHandoff).toBe(1);
  expect(result.counts.AgentTaskEvent).toBe(data.AgentTaskEvent.length);

  const restored = await prisma.agentTask.findFirstOrThrow({ where: { userId } });
  const restoredJob = await prisma.jobOpportunity.findFirstOrThrow({ where: { userId } });
  const restoredSession = await prisma.chatConversation.findFirstOrThrow({ where: { userId } });
  expect(restored.id).not.toBe(task.id);
  expect(restoredJob.id).not.toBe(job.id);
  expect(restored.jobOpportunityId).toBe(restoredJob.id);
  expect(restoredSession.agentTaskId).toBe(restored.id);
  // Live claim is runtime state: never restored.
  expect(restored.activeSessionId).toBeNull();
  expect(restored.activeSessionClaimedAt).toBeNull();
  // liveSlot is rebuilt from the remapped opportunity id (one-live-task guard holds).
  expect(restored.liveSlot).toBe(`INTERVIEW_SPRINT:${restoredJob.id}`);
  expect(restored.revision).toBe(1);
  // Embedded evidence pointers are remapped with the same id map.
  expect(JSON.parse(restored.acceptanceItems)[0].evidenceRef).toBe(restoredJob.id);

  const handoff = await prisma.agentTaskHandoff.findFirstOrThrow({ where: { taskId: restored.id } });
  expect(handoff.sessionId).toBe(restoredSession.id);
  expect(handoff.state).toBe('{"v":1}');
  expect(handoff.stateHash).toBe("hash");

  const events = await prisma.agentTaskEvent.findMany({ where: { taskId: restored.id } });
  expect(events).toHaveLength(data.AgentTaskEvent.length);
  expect(events.some((e) => e.kind === "STEP")).toBe(true);
  expect(await prisma.agentTask.count()).toBe(1);

  // Wipe + re-import again: the restored ledger travels a second time intact.
  const second = await buildBackupZip(userId, "bk-task@example.com");
  await importBackup(second.buffer, userId, "bk-task@example.com", true);
  expect(await prisma.agentTask.count()).toBe(1);
  expect(await prisma.agentTaskEvent.count()).toBe(events.length);
}, 120_000);

it("defaults the new groups and keeps agentTaskId optional for pre-v11 backups", () => {
  const parsed = BackupDataSchema.parse({});
  expect(parsed.AgentTask).toEqual([]);
  expect(parsed.AgentTaskHandoff).toEqual([]);
  expect(parsed.AgentTaskEvent).toEqual([]);
  // A v10 conversation row has no agentTaskId key and still parses.
  const withoutKey = BackupDataSchema.parse({
    ChatConversation: [
      { id: "c1", messages: "[]", createdAt: new Date(), updatedAt: new Date() },
    ],
  });
  expect(withoutKey.ChatConversation[0].agentTaskId).toBeUndefined();
});
