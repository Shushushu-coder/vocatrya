// @vitest-environment node
/**
 * Milestone + acceptance derivation against an isolated database: pure
 * derivation from domain entities, default-FAIL, evidence that disappears
 * falls back to not passed, only code writes passes/evidenceRef.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  deriveTaskMilestone,
  loadInterviewSprintFacts,
  syncAgentTaskDerivation,
  verifyAcceptanceEvidence,
  type InterviewSprintFacts,
} from "@/lib/agent/task/agentTaskMilestone";
import { getAgentTask, createAgentTask, AGENT_TASK_STATUS } from "@/lib/agent/task/agentTaskStore";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
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
});

const passes = (items: Array<{ key: string; passes: boolean }>) =>
  Object.fromEntries(items.map((item) => [item.key, item.passes]));

async function answerQuestion() {
  await prisma.questionInstance.create({
    data: {
      sessionId: sprint.interview.id,
      displayOrder: 1,
      displayedText: "Tell me about a hard bug.",
      sourceKind: "USER_PROVIDED",
      status: "ANSWERED",
    },
  });
}

async function currentSummary() {
  await prisma.sessionSummaryGeneration.create({
    data: {
      sessionId: sprint.interview.id,
      versionNumber: 1,
      status: "SUCCEEDED",
      isCurrent: true,
      inputHash: `h-${randomUUID()}`,
    },
  });
}

describe("deriveTaskMilestone (pure)", () => {
  const empty: InterviewSprintFacts = {
    job: null,
    goal: null,
    latestMatch: null,
    freshMatchId: null,
    answeredSessionId: null,
    summarizedSessionId: null,
  };

  it("is default-FAIL with no facts", () => {
    const derived = deriveTaskMilestone(empty);
    expect(derived.milestone).toBe("PREPARING");
    expect(derived.acceptanceItems.every((item) => !item.passes && item.evidenceRef === undefined)).toBe(true);
    expect(derived.acceptanceItems.map((item) => item.key)).toEqual([
      "prep-goal-active",
      "jd-fit-reviewed",
      "mock-session-1",
      "session-summary-reviewed",
    ]);
  });

  it("a goal with a missing pinned JD version does not prove prep-goal-active", () => {
    const derived = deriveTaskMilestone({
      ...empty,
      goal: { id: "g", status: "ACTIVE", pinnedJdVersionExists: false },
    });
    expect(passes(derived.acceptanceItems)["prep-goal-active"]).toBe(false);
  });

  it("an ENDED goal does not prove prep-goal-active", () => {
    const derived = deriveTaskMilestone({
      ...empty,
      goal: { id: "g", status: "ENDED", pinnedJdVersionExists: true },
    });
    expect(passes(derived.acceptanceItems)["prep-goal-active"]).toBe(false);
  });

  it("a stale-only analysis does not prove jd-fit-reviewed", () => {
    const derived = deriveTaskMilestone({
      ...empty,
      latestMatch: { id: "m", isStale: true, score: 80, verdict: null },
      freshMatchId: null,
    });
    expect(passes(derived.acceptanceItems)["jd-fit-reviewed"]).toBe(false);
  });
});

describe("loadInterviewSprintFacts + syncAgentTaskDerivation", () => {
  it("derives PRACTICING from the seeded goal + fresh analysis and persists it", async () => {
    const result = await syncAgentTaskDerivation(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
    });
    expect(result?.milestone).toBe("PRACTICING");
    expect(passes(result!.acceptanceItems)).toEqual({
      "prep-goal-active": true,
      "jd-fit-reviewed": true,
      "mock-session-1": false,
      "session-summary-reviewed": false,
    });
    const stored = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(stored?.milestone).toBe("PRACTICING");
    const byKey = Object.fromEntries(stored!.acceptanceItems.map((item) => [item.key, item]));
    expect(byKey["prep-goal-active"].evidenceRef).toBe(sprint.goal.id);
    expect(byKey["jd-fit-reviewed"].evidenceRef).toBe(sprint.match.id);
    expect(byKey["mock-session-1"].evidenceRef).toBeUndefined();
    const events = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(events.filter((event) => event.kind === "MILESTONE")).toHaveLength(1);

    // Idempotent: a second run changes and records nothing.
    const again = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(again).toMatchObject({ milestoneChanged: false, itemsChanged: false });
    const after = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(after.filter((event) => event.kind === "MILESTONE")).toHaveLength(1);
  });

  it("walks PRACTICING -> REVIEWING -> DONE as domain entities appear; DONE never closes the task", async () => {
    await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    await answerQuestion();
    let r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(r?.milestone).toBe("REVIEWING");
    expect(r!.acceptanceItems.find((item) => item.key === "mock-session-1")?.evidenceRef).toBe(
      sprint.interview.id,
    );
    await currentSummary();
    r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(r?.milestone).toBe("DONE");
    expect(r!.acceptanceItems.every((item) => item.passes)).toBe(true);
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.status).toBe(AGENT_TASK_STATUS.ACTIVE);
  });

  it("a stale analysis flips jd-fit-reviewed back to not passed and the milestone back", async () => {
    await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(passes(r!.acceptanceItems)["jd-fit-reviewed"]).toBe(false);
    expect(r?.milestone).toBe("PREPARING");
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.acceptanceItems.find((item) => item.key === "jd-fit-reviewed")).toMatchObject({
      passes: false,
    });
    expect(task?.acceptanceItems.find((item) => item.key === "jd-fit-reviewed")?.evidenceRef).toBeUndefined();
  });

  it("evidence pointing to a deleted entity falls back to not passed", async () => {
    await answerQuestion();
    await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    let task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.acceptanceItems.find((i) => i.key === "mock-session-1")?.passes).toBe(true);

    await prisma.questionInstance.deleteMany({ where: { sessionId: sprint.interview.id } });
    await prisma.interviewSession.delete({ where: { id: sprint.interview.id } });
    const r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(passes(r!.acceptanceItems)["mock-session-1"]).toBe(false);
    task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.acceptanceItems.find((i) => i.key === "mock-session-1")).toMatchObject({ passes: false });
    expect(task?.milestone).toBe("PRACTICING");
  });

  it("only code sets passes: a hand-edited passing item with no real evidence is overwritten", async () => {
    await prisma.agentTask.update({
      where: { id: sprint.task.id },
      data: {
        acceptanceItems: JSON.stringify([
          { key: "mock-session-1", label: "x", passes: true, evidenceRef: "forged-id" },
        ]),
      },
    });
    const r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(passes(r!.acceptanceItems)["mock-session-1"]).toBe(false);
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.acceptanceItems).toHaveLength(4);
    expect(task?.acceptanceItems.find((i) => i.key === "mock-session-1")?.evidenceRef).toBeUndefined();
  });

  it("links a prep goal created after the task", async () => {
    const other = await seedAccount(prisma, `late-${randomUUID()}@example.com`);
    const company = await prisma.company.create({
      data: { label: "Late", value: `late-${randomUUID()}`, createdBy: other },
    });
    const job = await prisma.jobOpportunity.create({
      data: { userId: other, companyId: company.id, title: "Eng" },
    });
    const { task } = await createAgentTask(prisma, { userId: other, jobOpportunityId: job.id });
    expect(task.interviewPrepGoalId).toBeNull();
    const jd = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: job.id,
        versionNumber: 1,
        rawContent: "t",
        capturedAt: new Date(),
        contentHash: `c-${randomUUID()}`,
      },
    });
    const goal = await prisma.interviewPrepGoal.create({
      data: {
        userId: other,
        jobOpportunityId: job.id,
        pinnedJobDescriptionVersionId: jd.id,
        pinnedJdContentHash: jd.contentHash,
        requestKey: `r-${randomUUID()}`,
        liveSlot: job.id,
      },
    });
    await syncAgentTaskDerivation(prisma, { userId: other, taskId: task.id });
    const stored = await getAgentTask(prisma, { userId: other, taskId: task.id });
    expect(stored?.interviewPrepGoalId).toBe(goal.id);
    expect(stored?.acceptanceItems.find((i) => i.key === "prep-goal-active")?.passes).toBe(true);
  });

  it("is ownership-scoped: another user entities and tasks yield nothing", async () => {
    const intruder = await seedAccount(prisma, `intruder-${randomUUID()}@example.com`);
    expect(await syncAgentTaskDerivation(prisma, { userId: intruder, taskId: sprint.task.id })).toBeNull();
    const facts = await loadInterviewSprintFacts(prisma, {
      userId: intruder,
      jobOpportunityId: sprint.job.id,
      interviewPrepGoalId: sprint.goal.id,
    });
    expect(facts.job).toBeNull();
    expect(facts.goal).toBeNull();
    expect(facts.latestMatch).toBeNull();
  });

  it("does not rewrite a terminal task", async () => {
    await answerQuestion();
    await currentSummary();
    await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    await prisma.agentTask.update({
      where: { id: sprint.task.id },
      data: { status: AGENT_TASK_STATUS.DONE, liveSlot: null },
    });
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const r = await syncAgentTaskDerivation(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(r).toMatchObject({ milestone: "DONE", itemsChanged: false, milestoneChanged: false });
    expect(passes(r!.acceptanceItems)["jd-fit-reviewed"]).toBe(true);
  });

  it("reports the real score when a deep match detail exists", async () => {
    await prisma.deepMatchDetail.create({
      data: { matchAnalysisId: sprint.match.id, overallSummary: "ok", overallScore: 88 },
    });
    const facts = await loadInterviewSprintFacts(prisma, {
      userId: sprint.userId,
      jobOpportunityId: sprint.job.id,
      interviewPrepGoalId: sprint.goal.id,
    });
    expect(facts.latestMatch).toMatchObject({ id: sprint.match.id, score: 88, isStale: false });
  });
});

describe("verifyAcceptanceEvidence", () => {
  const items = (ref: string, key = "mock-session-1") => [
    { key, label: "l", passes: true, evidenceRef: ref },
  ];

  it("keeps items whose evidence holds and revokes the rest", async () => {
    const ok = await verifyAcceptanceEvidence(prisma, {
      userId: sprint.userId,
      templateKey: "INTERVIEW_SPRINT",
      items: items(sprint.interview.id),
    });
    expect(ok.items[0]).toMatchObject({ passes: true, evidenceRef: sprint.interview.id });
    expect(ok.revoked).toEqual([]);

    const ghost = await verifyAcceptanceEvidence(prisma, {
      userId: sprint.userId,
      templateKey: "INTERVIEW_SPRINT",
      items: items("deleted-session"),
    });
    expect(ghost.items[0]).toEqual({ key: "mock-session-1", label: "l", passes: false });
    expect(ghost.revoked).toEqual(["mock-session-1"]);
  });

  it("revokes a match analysis that went stale, and a session of another user", async () => {
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const stale = await verifyAcceptanceEvidence(prisma, {
      userId: sprint.userId,
      templateKey: "INTERVIEW_SPRINT",
      items: items(sprint.match.id, "jd-fit-reviewed"),
    });
    expect(stale.items[0].passes).toBe(false);
    const foreign = await verifyAcceptanceEvidence(prisma, {
      userId: "someone-else",
      templateKey: "INTERVIEW_SPRINT",
      items: items(sprint.interview.id),
    });
    expect(foreign.items[0].passes).toBe(false);
  });

  it("an item without evidence stays failed", async () => {
    const r = await verifyAcceptanceEvidence(prisma, {
      userId: sprint.userId,
      templateKey: "INTERVIEW_SPRINT",
      items: [{ key: "mock-session-1", label: "l", passes: false }],
    });
    expect(r.items[0].passes).toBe(false);
    expect(r.revoked).toEqual([]);
  });
});
