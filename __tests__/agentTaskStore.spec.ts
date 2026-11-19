// @vitest-environment node
/**
 * Agent task ledger store against an isolated SQLite/Prisma database:
 * ownership scoping, one live task per opportunity, status transitions,
 * single-active-session claim CAS (incl. concurrent claimers), stale-claim
 * recovery, Pilot-only sessions and the handoff revision CAS.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_TASK_STATUS,
  AgentTaskError,
  claimAgentTaskSession,
  commitAgentTaskRevision,
  createAgentTask,
  getAgentTask,
  listAgentTasks,
  releaseAgentTaskSession,
  transitionAgentTaskStatus,
  updateAgentTaskMilestone,
} from "@/lib/agent/task/agentTaskStore";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
import {
  INTERVIEW_SPRINT_MILESTONE,
  INTERVIEW_SPRINT_TEMPLATE,
} from "@/lib/agent/task/agentTaskTemplates";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;

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
  userId = await seedAccount(prisma, `task-${randomUUID()}@example.com`);
  otherUserId = await seedAccount(prisma, `task-other-${randomUUID()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: userId },
    })
  ).id;
});

async function job(opts?: { owner?: string; archived?: boolean }) {
  return prisma.jobOpportunity.create({
    data: {
      userId: opts?.owner ?? userId,
      companyId,
      title: "Staff Engineer",
      archivedAt: opts?.archived ? new Date() : null,
    },
  });
}

async function session(opts?: { owner?: string; agentRole?: string | null }) {
  return prisma.chatConversation.create({
    data: {
      userId: opts?.owner ?? userId,
      messages: "[]",
      agentRole: opts && "agentRole" in opts ? opts.agentRole : "pilot",
    },
  });
}

async function newTask() {
  const j = await job();
  const { task } = await createAgentTask(prisma, { userId, jobOpportunityId: j.id });
  return { job: j, task };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "AgentTaskError", code });
}

describe("createAgentTask", () => {
  it("creates a default-FAIL interview sprint bound to an owned opportunity", async () => {
    const j = await job();
    const { task, created } = await createAgentTask(prisma, {
      userId,
      jobOpportunityId: j.id,
    });
    expect(created).toBe(true);
    expect(task.templateKey).toBe("INTERVIEW_SPRINT");
    expect(task.status).toBe("ACTIVE");
    expect(task.milestone).toBe(INTERVIEW_SPRINT_TEMPLATE.milestones[0]);
    expect(task.title).toContain("Staff Engineer");
    expect(task.revision).toBe(0);
    expect(task.acceptanceItems.map((i) => i.key)).toEqual(
      INTERVIEW_SPRINT_TEMPLATE.acceptanceItems.map((i) => i.key),
    );
    expect(task.acceptanceItems.every((i) => i.passes === false && !i.evidenceRef)).toBe(true);
    const events = await listTaskEvents(prisma, { userId, taskId: task.id });
    expect(events.map((e) => e.kind)).toEqual(["CREATED"]);
  });

  it("rejects another user's, archived and unknown opportunities", async () => {
    const foreign = await job({ owner: otherUserId });
    await expectCode(createAgentTask(prisma, { userId, jobOpportunityId: foreign.id }), "JOB_NOT_FOUND");
    const archived = await job({ archived: true });
    await expectCode(createAgentTask(prisma, { userId, jobOpportunityId: archived.id }), "JOB_NOT_FOUND");
    await expectCode(createAgentTask(prisma, { userId, jobOpportunityId: "missing" }), "JOB_NOT_FOUND");
    expect(await prisma.agentTask.count()).toBe(0);
  });

  it("keeps one live task per opportunity, even for concurrent creates", async () => {
    const j = await job();
    const results = await Promise.all([
      createAgentTask(prisma, { userId, jobOpportunityId: j.id }),
      createAgentTask(prisma, { userId, jobOpportunityId: j.id }),
      createAgentTask(prisma, { userId, jobOpportunityId: j.id }),
    ]);
    expect(new Set(results.map((r) => r.task.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.agentTask.count()).toBe(1);
  });

  it("allows a new task once the previous one is abandoned", async () => {
    const { job: j, task } = await newTask();
    await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "ABANDONED" });
    const again = await createAgentTask(prisma, { userId, jobOpportunityId: j.id });
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(task.id);
  });

  it("links the live InterviewPrepGoal for the opportunity as a pointer", async () => {
    const j = await job();
    const jd = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: j.id,
        versionNumber: 1,
        rawContent: "jd",
        rawContentFormat: "PLAIN_TEXT",
        capturedAt: new Date(),
        contentHash: "h",
      },
    });
    const goal = await prisma.interviewPrepGoal.create({
      data: {
        userId,
        jobOpportunityId: j.id,
        pinnedJobDescriptionVersionId: jd.id,
        pinnedJdContentHash: "h",
        requestKey: `rk-${randomUUID()}`,
        liveSlot: j.id,
      },
    });
    const { task } = await createAgentTask(prisma, { userId, jobOpportunityId: j.id });
    expect(task.interviewPrepGoalId).toBe(goal.id);
  });
});

describe("read scoping", () => {
  it("get/list never expose another user's task", async () => {
    const { task } = await newTask();
    expect(await getAgentTask(prisma, { userId: otherUserId, taskId: task.id })).toBeNull();
    expect(await listAgentTasks(prisma, { userId: otherUserId })).toEqual([]);
    expect((await listAgentTasks(prisma, { userId })).map((t) => t.id)).toEqual([task.id]);
    expect(await listAgentTasks(prisma, { userId, status: "PAUSED" })).toEqual([]);
  });

  it("mutations on another user's task behave as not found", async () => {
    const { task } = await newTask();
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId: otherUserId, taskId: task.id, to: "PAUSED" }),
      "TASK_NOT_FOUND",
    );
    expect(
      await commitAgentTaskRevision(prisma, { userId: otherUserId, taskId: task.id, expectedRevision: 0 }),
    ).toBeNull();
    const foreignSession = await session({ owner: otherUserId });
    const claim = await claimAgentTaskSession(prisma, {
      userId: otherUserId,
      taskId: task.id,
      sessionId: foreignSession.id,
    });
    expect(claim).toEqual({ ok: false, reason: "TASK_NOT_FOUND" });
    expect(await releaseAgentTaskSession(prisma, { userId: otherUserId, taskId: task.id, sessionId: "x" })).toBe(false);
  });
});

describe("status transitions", () => {
  it("follows the transition table and records events", async () => {
    const { task } = await newTask();
    const paused = await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "PAUSED" });
    expect(paused.status).toBe("PAUSED");
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "BLOCKED", blockedReason: "MISSING_FACTS" }),
      "INVALID_TRANSITION",
    );
    const resumed = await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "ACTIVE" });
    expect(resumed.status).toBe("ACTIVE");
    const events = await listTaskEvents(prisma, { userId, taskId: task.id });
    expect(events.map((e) => e.kind)).toEqual(["CREATED", "STATUS", "STATUS"]);
    expect(events[1].payload).toMatchObject({ from: "ACTIVE", to: "PAUSED" });
  });

  it("BLOCKED needs a reason, stores it and clears it on resume", async () => {
    const { task } = await newTask();
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "BLOCKED" }),
      "INVALID_INPUT",
    );
    const blocked = await transitionAgentTaskStatus(prisma, {
      userId,
      taskId: task.id,
      to: "BLOCKED",
      blockedReason: "MISSING_FACTS",
      blockedInputKey: "targetSalary",
    });
    expect(blocked).toMatchObject({ status: "BLOCKED", blockedReason: "MISSING_FACTS", blockedInputKey: "targetSalary" });
    const active = await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "ACTIVE" });
    expect(active.blockedReason).toBeNull();
    expect(active.blockedInputKey).toBeNull();
    const events = await listTaskEvents(prisma, { userId, taskId: task.id });
    expect(events.some((e) => e.kind === "BLOCKED")).toBe(true);
  });

  it("DONE is refused until every acceptance item holds evidence", async () => {
    const { task } = await newTask();
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "DONE" }),
      "ACCEPTANCE_INCOMPLETE",
    );
    // passes:true without evidenceRef still reads as failing (default-FAIL).
    const items = task.acceptanceItems.map((i) => ({ ...i, passes: true }));
    await prisma.agentTask.update({ where: { id: task.id }, data: { acceptanceItems: JSON.stringify(items) } });
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "DONE" }),
      "ACCEPTANCE_INCOMPLETE",
    );
    const proven = items.map((i) => ({ ...i, evidenceRef: `ev-${i.key}` }));
    await prisma.agentTask.update({ where: { id: task.id }, data: { acceptanceItems: JSON.stringify(proven) } });
    const done = await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "DONE" });
    expect(done.status).toBe("DONE");
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.liveSlot).toBeNull();
    await expectCode(
      transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "ACTIVE" }),
      "INVALID_TRANSITION",
    );
  });

  it("leaving ACTIVE drops the session claim", async () => {
    const { task } = await newTask();
    const s = await session();
    expect((await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: s.id })).ok).toBe(true);
    const paused = await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "PAUSED" });
    expect(paused.activeSessionId).toBeNull();
    expect(paused.activeSessionClaimedAt).toBeNull();
  });

  it("milestone update is a CAS restricted to the template milestones", async () => {
    const { task } = await newTask();
    const to = INTERVIEW_SPRINT_MILESTONE.PRACTICING;
    await expectCode(
      updateAgentTaskMilestone(prisma, { userId, taskId: task.id, from: task.milestone, to: "NOPE" }),
      "INVALID_MILESTONE",
    );
    await expectCode(
      updateAgentTaskMilestone(prisma, { userId, taskId: task.id, from: "STALE", to }),
      "MILESTONE_CONFLICT",
    );
    const moved = await updateAgentTaskMilestone(prisma, { userId, taskId: task.id, from: task.milestone, to });
    expect(moved.milestone).toBe(to);
  });
});

describe("session claim", () => {
  it("claims once, binds the Pilot session and refuses a second session", async () => {
    const { task } = await newTask();
    const a = await session();
    const b = await session();
    const first = await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id });
    expect(first).toMatchObject({ ok: true, recoveredStale: false, renewed: false });
    expect((await prisma.chatConversation.findUniqueOrThrow({ where: { id: a.id } })).agentTaskId).toBe(task.id);
    const second = await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: b.id });
    expect(second).toEqual({ ok: false, reason: "HELD" });
    expect((await prisma.chatConversation.findUniqueOrThrow({ where: { id: b.id } })).agentTaskId).toBeNull();
  });

  it("same session may renew its own claim without a new event", async () => {
    const { task } = await newTask();
    const a = await session();
    const t0 = new Date("2026-11-19T10:00:00Z");
    const t1 = new Date("2026-11-19T10:30:00Z");
    await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id, now: t0 });
    const renewed = await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id, now: t1 });
    expect(renewed).toMatchObject({ ok: true, renewed: true });
    if (renewed.ok) expect(renewed.task.activeSessionClaimedAt?.getTime()).toBe(t1.getTime());
    const events = await listTaskEvents(prisma, { userId, taskId: task.id });
    expect(events.filter((e) => e.kind === "SESSION_START")).toHaveLength(1);
  });

  it("only one of several concurrent claimers wins", async () => {
    const { task } = await newTask();
    const sessions = await Promise.all([session(), session(), session(), session()]);
    const results = await Promise.all(
      sessions.map((s) => claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: s.id })),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const winnerSession = sessions[results.findIndex((r) => r.ok)];
    expect(row.activeSessionId).toBe(winnerSession.id);
    expect(await prisma.chatConversation.count({ where: { agentTaskId: task.id } })).toBe(1);
  });

  it("recovers a stale claim and records the takeover", async () => {
    const { task } = await newTask();
    const a = await session();
    const b = await session();
    const t0 = new Date("2026-11-19T00:00:00Z");
    await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id, now: t0 });
    const justBefore = new Date(t0.getTime() + APP_CONSTANTS.AGENT_TASK_SESSION_STALE_MS - 1);
    expect(
      await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: b.id, now: justBefore }),
    ).toEqual({ ok: false, reason: "HELD" });
    const stale = new Date(t0.getTime() + APP_CONSTANTS.AGENT_TASK_SESSION_STALE_MS);
    const takeover = await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: b.id, now: stale });
    expect(takeover).toMatchObject({ ok: true, recoveredStale: true });
    const events = await listTaskEvents(prisma, { userId, taskId: task.id });
    expect(events.find((e) => e.kind === "SESSION_END")?.payload).toMatchObject({ sessionId: a.id, reason: "stale" });
    // The evicted session cannot release its successor's claim.
    expect(await releaseAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id })).toBe(false);
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.activeSessionId).toBe(b.id);
  });

  it("release frees the slot only for the holder", async () => {
    const { task } = await newTask();
    const a = await session();
    const b = await session();
    await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id });
    expect(await releaseAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: b.id })).toBe(false);
    expect(await releaseAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: a.id })).toBe(true);
    expect((await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: b.id })).ok).toBe(true);
  });

  it("only Pilot-role, owned, unarchived sessions can be claimed", async () => {
    const { task } = await newTask();
    const nullRole = await session({ agentRole: null });
    const insight = await session({ agentRole: "insight" });
    const foreign = await session({ owner: otherUserId });
    const archived = await prisma.chatConversation.create({
      data: { userId, messages: "[]", agentRole: "pilot", archivedAt: new Date() },
    });
    for (const s of [nullRole, insight, foreign, archived]) {
      expect(await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: s.id })).toEqual({
        ok: false,
        reason: "SESSION_INVALID",
      });
    }
    // A pilot session already bound to a different task is not stealable.
    const other = await createAgentTask(prisma, { userId, jobOpportunityId: (await job()).id });
    const bound = await session();
    await claimAgentTaskSession(prisma, { userId, taskId: other.task.id, sessionId: bound.id });
    expect(await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: bound.id })).toEqual({
      ok: false,
      reason: "SESSION_INVALID",
    });
  });

  it("refuses claims on non-ACTIVE tasks", async () => {
    const { task } = await newTask();
    const s = await session();
    await transitionAgentTaskStatus(prisma, { userId, taskId: task.id, to: "PAUSED" });
    expect(await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: s.id })).toEqual({
      ok: false,
      reason: "NOT_ACTIVE",
    });
  });

  it("deleting the task keeps the transcript as an ordinary chat", async () => {
    const { task } = await newTask();
    const s = await session();
    await claimAgentTaskSession(prisma, { userId, taskId: task.id, sessionId: s.id });
    await prisma.agentTask.delete({ where: { id: task.id } });
    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.agentTaskId).toBeNull();
    expect(row.agentRole).toBe("pilot");
  });
});

describe("handoff revision CAS", () => {
  it("advances exactly once per expected revision", async () => {
    const { task } = await newTask();
    const results = await Promise.all([
      commitAgentTaskRevision(prisma, { userId, taskId: task.id, expectedRevision: 0 }),
      commitAgentTaskRevision(prisma, { userId, taskId: task.id, expectedRevision: 0 }),
    ]);
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await commitAgentTaskRevision(prisma, { userId, taskId: task.id, expectedRevision: 1 })).toBe(2);
    expect((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(2);
  });

  it("the (taskId, revision) unique index is the second gate", async () => {
    const { task } = await newTask();
    const data = { taskId: task.id, revision: 1, state: "{}", stateHash: "h" };
    await prisma.agentTaskHandoff.create({ data });
    await expect(prisma.agentTaskHandoff.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});

it("AgentTaskError carries its code", () => {
  const error = new AgentTaskError("TASK_NOT_FOUND");
  expect(error.code).toBe("TASK_NOT_FOUND");
  expect(AGENT_TASK_STATUS.ACTIVE).toBe("ACTIVE");
});
