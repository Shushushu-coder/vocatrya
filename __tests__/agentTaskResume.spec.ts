// @vitest-environment node
/**
 * resumeAgentTask: claim a Pilot session, run grounding, return the verified
 * line. Single-active-session claim CAS is respected, never bypassed.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { resumeAgentTaskSession } from "@/lib/agent/task/agentTaskResume";
import {
  AGENT_TASK_STATUS,
  getAgentTask,
  transitionAgentTaskStatus,
} from "@/lib/agent/task/agentTaskStore";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
import { APP_CONSTANTS } from "@/lib/constants";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { seedSprint, type Sprint } from "./helpers/agentTaskHandoffFixtures";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let sprint: Sprint;
let created: string[];

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
  sprint = await seedSprint(prisma);
  created = [];
});

/** Stand-in for createChatConversationRecord (lock resolution lives there). */
const createConversation = async ({ task }: { task: { id: string } }) => {
  const row = await prisma.chatConversation.create({
    data: { userId: sprint.userId, messages: "[]", agentRole: "pilot", agentTaskId: task.id },
  });
  created.push(row.id);
  return { id: row.id };
};

const resume = (extra: Partial<Parameters<typeof resumeAgentTaskSession>[1]> = {}) =>
  resumeAgentTaskSession(prisma, {
    userId: sprint.userId,
    taskId: sprint.task.id,
    createConversation,
    ...extra,
  });

describe("resumeAgentTaskSession", () => {
  it("creates a Pilot session bound to the task, claims it, and returns the verified line", async () => {
    const result = await resume();
    if (!result.ok) throw new Error(result.code);
    expect(result).toMatchObject({ created: true, reused: false, recoveredStale: false });
    expect(created).toEqual([result.conversationId]);
    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: result.conversationId } });
    expect(row).toMatchObject({ agentRole: "pilot", agentTaskId: sprint.task.id, userId: sprint.userId });
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.activeSessionId).toBe(result.conversationId);
    expect(result.handoffLine).toContain("Active task state");
    expect(result.handoffLine).toContain("milestone=PRACTICING");
    expect(result.milestone).toBe("PRACTICING");
    expect(result.acceptanceItems.find((i) => i.key === "jd-fit-reviewed")?.passes).toBe(true);
    expect(result.kickoffText).toBe("继续推进这个任务。");
    const kinds = (await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id })).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["SESSION_START", "RESUMED"]));
  });

  it("re-activates a paused task, and a blocked one", async () => {
    await transitionAgentTaskStatus(prisma, { userId: sprint.userId, taskId: sprint.task.id, to: AGENT_TASK_STATUS.PAUSED });
    const result = await resume({ locale: "en" });
    if (!result.ok) throw new Error(result.code);
    expect(result.task.status).toBe(AGENT_TASK_STATUS.ACTIVE);
    expect(result.kickoffText).toBe("Continue this task.");

    await transitionAgentTaskStatus(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      to: AGENT_TASK_STATUS.BLOCKED,
      blockedReason: "MISSING_FACTS",
    });
    const again = await resume();
    expect(again.ok).toBe(true);
    expect((await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id }))?.status).toBe("ACTIVE");
  });

  it("a second resume reopens the live session instead of creating another", async () => {
    const first = await resume();
    if (!first.ok) throw new Error(first.code);
    const second = await resume();
    if (!second.ok) throw new Error(second.code);
    expect(second).toMatchObject({ reused: true, created: false, conversationId: first.conversationId });
    expect(created).toHaveLength(1);
  });

  it("binds and claims an existing Pilot conversation when asked", async () => {
    const result = await resume({ conversationId: sprint.conversation.id });
    if (!result.ok) throw new Error(result.code);
    expect(result).toMatchObject({ created: false, conversationId: sprint.conversation.id });
    expect(created).toHaveLength(0);
    const loose = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "pilot" },
    });
    // Same session renews; an unbound pilot conversation is rejected while held.
    expect((await resume({ conversationId: sprint.conversation.id })).ok).toBe(true);
    const held = await resume({ conversationId: loose.id });
    expect(held).toMatchObject({ ok: false, code: "HELD", activeSessionId: sprint.conversation.id });
    expect((await prisma.chatConversation.findUniqueOrThrow({ where: { id: loose.id } })).agentTaskId).toBeNull();
  });

  it("rejects sessions that are not owned, unarchived Pilot conversations", async () => {
    const intruder = await seedAccount(prisma, `i-${randomUUID()}@example.com`);
    const foreign = await prisma.chatConversation.create({
      data: { userId: intruder, messages: "[]", agentRole: "pilot" },
    });
    const insight = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "insight" },
    });
    const general = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: null },
    });
    const archived = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "pilot", archivedAt: new Date() },
    });
    for (const id of [foreign.id, insight.id, general.id, archived.id, "missing"]) {
      expect(await resume({ conversationId: id })).toEqual({ ok: false, code: "SESSION_INVALID" });
    }
    expect((await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id }))?.activeSessionId).toBeNull();
  });

  it("recovers a stale claim and records the old session end", async () => {
    const first = await resume();
    if (!first.ok) throw new Error(first.code);
    const old = new Date(Date.now() - APP_CONSTANTS.AGENT_TASK_SESSION_STALE_MS - 60_000);
    await prisma.agentTask.update({ where: { id: sprint.task.id }, data: { activeSessionClaimedAt: old } });
    const second = await resume();
    if (!second.ok) throw new Error(second.code);
    expect(second).toMatchObject({ created: true, reused: false, recoveredStale: true });
    expect(second.conversationId).not.toBe(first.conversationId);
    const ends = (await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id })).filter(
      (e) => e.kind === "SESSION_END",
    );
    expect(ends.some((e) => e.payload.reason === "stale")).toBe(true);
  });

  it("frees a claim whose session was deleted and starts a fresh one", async () => {
    const first = await resume();
    if (!first.ok) throw new Error(first.code);
    await prisma.chatConversation.delete({ where: { id: first.conversationId } });
    const second = await resume();
    if (!second.ok) throw new Error(second.code);
    expect(second).toMatchObject({ created: true, reused: false });
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  it("concurrent resumes leave exactly one claimed session and no stray conversation", async () => {
    const results = await Promise.all([resume(), resume(), resume()]);
    const okResults = results.filter((r) => r.ok);
    expect(okResults.length).toBeGreaterThanOrEqual(1);
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    const bound = await prisma.chatConversation.findMany({
      where: { agentTaskId: sprint.task.id, id: { not: sprint.conversation.id } },
    });
    expect(bound.map((b) => b.id)).toEqual([task?.activeSessionId]);
    for (const r of results) {
      if (r.ok) expect(r.conversationId).toBe(task?.activeSessionId);
      else expect(r.code).toBe("HELD");
    }
  });

  it("done / abandoned tasks cannot be resumed; unknown or foreign tasks are not found", async () => {
    await transitionAgentTaskStatus(prisma, { userId: sprint.userId, taskId: sprint.task.id, to: AGENT_TASK_STATUS.ABANDONED });
    expect(await resume()).toEqual({ ok: false, code: "NOT_RESUMABLE" });
    expect(created).toHaveLength(0);
    expect(await resume({ taskId: "nope" })).toEqual({ ok: false, code: "TASK_NOT_FOUND" });
    const intruder = await seedAccount(prisma, `f-${randomUUID()}@example.com`);
    expect(await resume({ userId: intruder })).toEqual({ ok: false, code: "TASK_NOT_FOUND" });
  });

  it("grounding on resume audits discrepancies (stale analysis) and shows them in the line", async () => {
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const result = await resume();
    if (!result.ok) throw new Error(result.code);
    expect(result.discrepancies.map((d) => d.code)).toContain("analysis_stale");
    expect(result.handoffLine).toContain("已失效");
    const events = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(events.some((e) => e.kind === "GROUNDING" && e.payload.code === "analysis_stale")).toBe(true);
  });
});
