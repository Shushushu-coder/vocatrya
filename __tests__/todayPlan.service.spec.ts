// @vitest-environment node
/**
 * TODAY-PLAN service over an isolated SQLite db: conversation isolation,
 * Task status sync, operationKey idempotency, safe undo, ambiguity, date
 * buckets and cross-user rejection.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  applyTodayPlanWrite,
  readTodayPlan,
  undoTodayPlanOperation,
} from "@/lib/todayPlan/service";
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

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const TZ = "Asia/Shanghai";

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

let userId = "";
let convA = "";
let convB = "";

async function conv() {
  const c = await prisma.chatConversation.create({
    data: { userId, messages: "[]", agentRole: "pilot" },
  });
  return c.id;
}
const ctxA = () => ({ userId, conversationId: convA, timeZone: TZ });
const today = async () => (await readTodayPlan(ctxA()))!;

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `tp-${randomUUID()}@example.com`);
  convA = await conv();
  convB = await conv();
});

it("adds items for today and isolates conversations", async () => {
  const res = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-add-1",
    input: { action: "add", titles: ["投递字节", "准备面试"], target: "today" },
  });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") return;
  expect(res.changed).toHaveLength(2);

  const view = await today();
  expect(view.buckets.today.map((i) => i.title)).toEqual([
    "投递字节",
    "准备面试",
  ]);
  // Two real Task rows carry the titles — no duplicated title column.
  expect(await prisma.task.count({ where: { userId } })).toBe(2);

  const other = await readTodayPlan({
    userId,
    conversationId: convB,
    timeZone: TZ,
  });
  expect(other!.buckets.today).toHaveLength(0);
});

it("rejects a conversation owned by another user", async () => {
  const otherUser = await seedAccount(prisma, `tp2-${randomUUID()}@x.com`);
  await expect(
    readTodayPlan({ userId: otherUser, conversationId: convA, timeZone: TZ }),
  ).resolves.toBeNull();
});

it("replays the same operationKey instead of double-writing", async () => {
  const op = { action: "add" as const, titles: ["A"], target: "today" as const };
  const first = await applyTodayPlanWrite(ctxA(), {
    operationKey: "dup-key",
    input: op,
  });
  const second = await applyTodayPlanWrite(ctxA(), {
    operationKey: "dup-key",
    input: op,
  });
  expect(first.status).toBe("ok");
  expect(second.status).toBe("ok");
  if (second.status === "ok") expect(second.replayed).toBe(true);
  expect((await today()).buckets.today).toHaveLength(1);
  expect(await prisma.task.count({ where: { userId } })).toBe(1);
});

it("toggles completion onto Task.status and flips back", async () => {
  const add = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-t",
    input: { action: "add", titles: ["跟进 HR"], target: "today" },
  });
  if (add.status !== "ok") throw new Error("setup");
  const item = add.changed[0];

  const done = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-t2",
    input: { action: "toggle", selector: { itemId: item.id }, completed: true },
  });
  expect(done.status).toBe("ok");
  expect(
    (await prisma.task.findUniqueOrThrow({ where: { id: item.taskId } }))
      .status,
  ).toBe("complete");

  const back = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-t3",
    input: {
      action: "toggle",
      selector: { itemId: item.id },
      completed: "flip",
    },
  });
  expect(back.status).toBe("ok");
  expect(
    (await prisma.task.findUniqueOrThrow({ where: { id: item.taskId } }))
      .status,
  ).toBe("in-progress");
});

it("flags a title matching more than one item as ambiguous", async () => {
  // Two DIFFERENT tasks carrying the same title — an add of a repeated
  // title reuses the first task (already_planned), so ambiguity can only
  // come from distinct tasks sharing a title.
  const t1 = await prisma.task.create({ data: { userId, title: "改简历" } });
  const t2 = await prisma.task.create({ data: { userId, title: "改简历" } });
  const view = await today();
  await prisma.todayPlanItem.createMany({
    data: [
      { userId, conversationId: convA, taskId: t1.id, plannedOn: view.today, position: 0 },
      { userId, conversationId: convA, taskId: t2.id, plannedOn: view.tomorrow, position: 0 },
    ],
  });
  const res = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-a3",
    input: {
      action: "remove",
      selector: { itemTitle: "改简历" },
    },
  });
  expect(res.status).toBe("ambiguous");
  if (res.status === "ambiguous") expect(res.candidates).toHaveLength(2);
  expect((await today()).buckets.today).toHaveLength(1);
});

it("re-adding a title already planned reports already_planned", async () => {
  const first = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-p1",
    input: { action: "add", titles: ["改简历"], target: "today" },
  });
  expect(first.status).toBe("ok");
  const second = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-p2",
    input: { action: "add", titles: ["改简历"], target: "tomorrow" },
  });
  expect(second.status).toBe("already_planned");
  const view = await today();
  expect(view.buckets.today).toHaveLength(1);
  expect(view.buckets.tomorrow).toHaveLength(0);
});

it("moves an item to tomorrow then carries it back today", async () => {
  const add = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-m1",
    input: { action: "add", titles: ["X"], target: "today" },
  });
  if (add.status !== "ok") throw new Error("setup");
  const item = add.changed[0];

  const moved = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-m2",
    input: { action: "move", selector: { itemId: item.id }, target: "tomorrow" },
  });
  expect(moved.status).toBe("ok");
  const view = await today();
  expect(view.buckets.today).toHaveLength(0);
  expect(view.buckets.tomorrow).toHaveLength(1);

  // carry_over only pulls OVERDUE items — with none present it reports
  // empty and tomorrow stays put.
  const carry = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-m3",
    input: { action: "carry_over" },
  });
  expect(carry.status).toBe("empty");
  expect((await today()).buckets.tomorrow).toHaveLength(1);
});

it("removes the association while keeping the Task", async () => {
  const add = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-r1",
    input: { action: "add", titles: ["保留任务"], target: "today" },
  });
  if (add.status !== "ok") throw new Error("setup");
  const taskId = add.changed[0].taskId;

  const res = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-r2",
    input: { action: "remove", selector: { itemId: add.changed[0].id } },
  });
  expect(res.status).toBe("ok");
  expect((await today()).buckets.today).toHaveLength(0);
  expect(await prisma.task.findUnique({ where: { id: taskId } })).not.toBeNull();
});

it("keeps history buckets separated and never auto-rolls overdue", async () => {
  const yesterday = "2026-01-01";
  const task = await prisma.task.create({ data: { userId, title: "旧事项" } });
  await prisma.todayPlanItem.create({
    data: { userId, conversationId: convA, taskId: task.id, plannedOn: yesterday, position: 0 },
  });
  const done = await prisma.task.create({
    data: { userId, title: "旧完成", status: "complete" },
  });
  await prisma.todayPlanItem.create({
    data: { userId, conversationId: convA, taskId: done.id, plannedOn: yesterday, position: 1 },
  });

  const view = await today();
  expect(view.buckets.overdue.map((i) => i.title)).toEqual(["旧事项"]);
  expect(view.buckets.history.map((i) => i.title)).toEqual(["旧完成"]);
  expect(view.buckets.today).toHaveLength(0);

  const carry = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-c1",
    input: { action: "carry_over" },
  });
  expect(carry.status).toBe("ok");
  const after = await today();
  expect(after.buckets.today.map((i) => i.title)).toEqual(["旧事项"]);
  expect(after.buckets.overdue).toHaveLength(0);
  expect(after.buckets.history).toHaveLength(1);
});

it("undoes an add but never clobbers a later rename", async () => {
  const add = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-u1",
    input: { action: "add", titles: ["原始标题"], target: "today" },
  });
  if (add.status !== "ok") throw new Error("setup");
  const item = add.changed[0];

  // A later modification must survive the undo of the earlier write.
  const rename = await applyTodayPlanWrite(ctxA(), {
    operationKey: "op-u2",
    input: {
      action: "rename",
      selector: { itemId: item.id },
      newTitle: "改过的标题",
    },
  });
  expect(rename.status).toBe("ok");

  const undo = await undoTodayPlanOperation(
    { userId, conversationId: convA },
    add.operationId,
  );
  // Add-undo removes the row — but only if untouched. A renamed row is
  // skipped, not reverted.
  expect(undo.status).toBe("ok");
  const view = await today();
  expect(view.buckets.today).toHaveLength(1);
  expect(view.buckets.today[0].title).toBe("改过的标题");

  const again = await undoTodayPlanOperation(
    { userId, conversationId: convA },
    add.operationId,
  );
  expect(again.status).toBe("already_undone");
});


it("never reuses a same-title Task from another conversation", async () => {
  const first = await applyTodayPlanWrite(ctxA(), { operationKey: "scope-a", input: { action: "add", titles: ["独立事项"], target: "today" } });
  const second = await applyTodayPlanWrite({ ...ctxA(), conversationId: convB }, { operationKey: "scope-b", input: { action: "add", titles: ["独立事项"], target: "today" } });
  if (first.status !== "ok" || second.status !== "ok") throw new Error("setup");
  expect(first.changed[0].taskId).not.toBe(second.changed[0].taskId);
  await applyTodayPlanWrite(ctxA(), { operationKey: "complete-a", input: { action: "toggle", selector: { itemId: first.changed[0].id }, completed: true } });
  expect((await readTodayPlan({ ...ctxA(), conversationId: convB }))!.buckets.today[0].completed).toBe(false);
});

it("rejects operationKey replay across conversations and users", async () => {
  await applyTodayPlanWrite(ctxA(), { operationKey: "private-key", input: { action: "add", titles: ["秘密"], target: "today" } });
  const input = { operationKey: "private-key", input: { action: "add" as const, titles: ["其他"], target: "today" as const } };
  const other = await seedAccount(prisma, `scope-${randomUUID()}@x.com`);
  const c = await prisma.chatConversation.create({ data: { userId: other, messages: "[]" } });
  for (const context of [{ ...ctxA(), conversationId: convB }, { userId: other, conversationId: c.id, timeZone: TZ }]) {
    expect(await applyTodayPlanWrite(context, input)).toMatchObject({ status: "failed" });
  }
  expect(await prisma.task.count({ where: { userId: other } })).toBe(0);
});

it("undoing an add preserves an explicitly linked other conversation Task", async () => {
  const added = await applyTodayPlanWrite(ctxA(), { operationKey: "shared-add", input: { action: "add", titles: ["共享"], target: "today" } });
  if (added.status !== "ok") throw new Error("setup");
  await prisma.todayPlanItem.create({ data: { userId, conversationId: convB, taskId: added.changed[0].taskId, plannedOn: (await today()).today, position: 0 } });
  await undoTodayPlanOperation({ userId, conversationId: convA }, added.operationId);
  expect((await readTodayPlan({ ...ctxA(), conversationId: convB }))!.buckets.today).toHaveLength(1);
});

it("rolls back business writes if recording the ledger fails with P2002", async () => {
  const db = prisma.$extends({ query: { todayPlanOperation: { async create() { throw Object.assign(new Error("collision"), { code: "P2002" }); } } } });
  await expect(applyTodayPlanWrite(ctxA(), { operationKey: "rollback", input: { action: "add", titles: ["应回滚"], target: "today" } }, db as unknown as PrismaClient)).rejects.toThrow();
  expect(await prisma.task.count({ where: { userId } })).toBe(0);
  expect(await prisma.todayPlanItem.count({ where: { userId } })).toBe(0);
});
