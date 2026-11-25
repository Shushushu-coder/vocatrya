// @vitest-environment node
/**
 * TODAY-PLAN across export -> wipe -> import: both models travel, ids are
 * re-minted and the conversation/task FKs are remapped.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { applyTodayPlanWrite, undoTodayPlanOperation } from "@/lib/todayPlan/service";
import { BACKUP_FORMAT_VERSION, ManifestSchema } from "@/lib/backup/schema";
import { BackupDataSchema } from "@/lib/backup/schema";
import { backupCoverageStatus } from "@/lib/backup/coverage";
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

it("classifies both models as BACKED_UP", () => {
  expect(backupCoverageStatus("TodayPlanItem")).toBe("BACKED_UP");
  expect(backupCoverageStatus("TodayPlanOperation")).toBe("BACKED_UP");
});

it("round-trips plan rows and the operation ledger with remapped FKs", async () => {
  const userId = await seedAccount(prisma, `bk-tp-${randomUUID()}@x.com`);
  const convo = await prisma.chatConversation.create({
    data: { userId, messages: "[]", agentRole: "pilot" },
  });
  const task = await prisma.task.create({ data: { userId, title: "跟进" } });
  const item = await prisma.todayPlanItem.create({
    data: {
      userId,
      conversationId: convo.id,
      taskId: task.id,
      plannedOn: "2026-11-24",
      position: 0,
    },
  });
  await prisma.todayPlanOperation.create({
    data: {
      userId,
      conversationId: convo.id,
      operationKey: "op-rt-1",
      kind: "add",
      undoJson: "[]",
      resultJson: "{}",
    },
  });

  const data = await collectBackupData(userId);
  expect(data.TodayPlanItem).toHaveLength(1);
  expect(data.TodayPlanOperation).toHaveLength(1);
  expect(BackupDataSchema.parse(data)).toBeTruthy();

  // Per-user wipe + restore into the same account: ids re-minted, FKs
  // remapped onto the fresh conversation/task rows.
  const { buffer } = await buildBackupZip(userId, "bk-tp@example.com");
  const result = await importBackup(buffer, userId, "bk-tp@example.com", true);
  expect(result.counts.TodayPlanItem).toBe(1);
  expect(result.counts.TodayPlanOperation).toBe(1);

  const items = await prisma.todayPlanItem.findMany({ where: { userId } });
  const ops = await prisma.todayPlanOperation.findMany({ where: { userId } });
  expect(items).toHaveLength(1);
  expect(ops).toHaveLength(1);

  const convo2 = await prisma.chatConversation.findFirst({
    where: { userId },
  });
  const task2 = await prisma.task.findFirst({ where: { userId } });
  expect(items[0].conversationId).toBe(convo2!.id);
  expect(items[0].taskId).toBe(task2!.id);
  expect(items[0].id).not.toBe(item.id); // re-minted ids
  expect(ops[0].conversationId).toBe(convo2!.id);
  expect(ops[0].operationKey).toBe(`restored:${ops[0].id}`);
});


it("gates new user state with v13 and rejects invalid plan dates", () => {
  expect(BACKUP_FORMAT_VERSION).toBe(13);
  const base = { appVersion: "1", exportedAt: new Date().toISOString(), sourceEmail: "x", counts: {} };
  expect(ManifestSchema.safeParse({ ...base, formatVersion: 12 }).success).toBe(true);
  expect(ManifestSchema.safeParse({ ...base, formatVersion: 13 }).success).toBe(true);
  expect(ManifestSchema.safeParse({ ...base, formatVersion: 14 }).success).toBe(false);
  for (const plannedOn of ["not-a-date", "2026-02-30", "2026-13-01"]) {
    expect(BackupDataSchema.safeParse({ TodayPlanItem: [{ id: "i", conversationId: "c", taskId: "t", plannedOn, position: 0, createdAt: new Date(), updatedAt: new Date() }] }).success).toBe(false);
  }
});

it("restores embedded ledger ids across users and safely undoes restored state", async () => {
  const source = await seedAccount(prisma, `source-${randomUUID()}@x.com`);
  const target = await seedAccount(prisma, `target-${randomUUID()}@x.com`);
  const conversation = await prisma.chatConversation.create({ data: { userId: source, messages: "[]", agentRole: "pilot" } });
  const added = await applyTodayPlanWrite({ userId: source, conversationId: conversation.id, timeZone: "Asia/Shanghai" }, { operationKey: "same-backup-key", input: { action: "add", titles: ["跨用户恢复"], target: "today" } });
  if (added.status !== "ok") throw new Error("setup");
  const { buffer } = await buildBackupZip(source, "source@x.com");
  await importBackup(buffer, target, "target@x.com", true);
  const ledger = await prisma.todayPlanOperation.findFirstOrThrow({ where: { userId: target } });
  const item = await prisma.todayPlanItem.findFirstOrThrow({ where: { userId: target } });
  expect(JSON.parse(ledger.undoJson!)[0]).toMatchObject({ taskId: item.taskId, planItemId: item.id });
  expect(JSON.parse(ledger.resultJson!)).toMatchObject({ operationId: ledger.id, changed: [{ id: item.id, taskId: item.taskId }] });
  const undo = await undoTodayPlanOperation({ userId: target, conversationId: ledger.conversationId }, ledger.id);
  expect(undo).toMatchObject({ status: "ok", reverted: 1, skipped: [] });
  expect(await prisma.todayPlanItem.count({ where: { userId: target } })).toBe(0);
  expect(await prisma.todayPlanItem.count({ where: { userId: source } })).toBe(1);
});
