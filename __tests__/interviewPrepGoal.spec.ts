// @vitest-environment node
/**
 * Interview prep goal — service-level invariants against an isolated
 * SQLite/Prisma database, no persistence mocks:
 *
 *   ownership gates, requestKey dedupe, one live goal per job
 *   pinned JD source, JD drift detection, archived/missing material
 *   session link validation + one-session binding
 *   verified progress from real attempt/feedback/summary rows
 *   ACTIVE → COMPLETED only after a persisted summary
 *   CAS revision conflicts, pause/resume/end/new-round lifecycle
 *   deterministic handoff rebuild on missing/corrupt snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BackupDataSchema } from "@/lib/backup/schema";
import { sha256Utf8 } from "@/lib/career";
import {
  createPrepGoal,
  endPrepGoal,
  getPrepGoalForJob,
  linkPrepSession,
  listLinkablePrepSessions,
  pausePrepGoal,
  resumePrepGoal,
  startNewPrepRound,
  validatePrepSessionCreation,
  verifyAndSyncGoal,
} from "@/lib/interviewPrep/service";
import { parsePrepHandoff } from "@/lib/interviewPrep/contract";
import { VocatryaInterviewPersistence } from "@/lib/interview/persistence/vocatryaInterviewPersistence";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

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

// Never start the cron in a test run.
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

let userId: string;
let otherUserId: string;
let companyId: string;

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeAll(() => {
  const uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `prep-${Date.now()}@example.com`);
  otherUserId = await seedAccount(prisma, `prep-other-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-prep-${randomUUID()}`,
        createdBy: userId,
      },
    })
  ).id;
});

async function createJob(opts?: { archived?: boolean }) {
  return prisma.jobOpportunity.create({
    data: {
      userId,
      companyId,
      title: "Staff Engineer",
      archivedAt: opts?.archived ? new Date() : null,
    },
  });
}

async function setJd(jobId: string, content = "JD v1 text") {
  const latest = await prisma.jobDescriptionVersion.findFirst({
    where: { jobOpportunityId: jobId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: jobId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      rawContent: content,
      rawContentFormat: "PLAIN_TEXT",
      capturedAt: new Date(),
      contentHash: sha256Utf8(content),
    },
  });
  await prisma.jobOpportunity.update({
    where: { id: jobId },
    data: { currentJdVersionId: jd.id },
  });
  return jd;
}

async function createSession(opts: {
  jobId?: string | null;
  jdId?: string | null;
  userId?: string;
  status?: string;
  coachingMode?: string;
}) {
  return prisma.interviewSession.create({
    data: {
      userId: opts.userId ?? userId,
      coachingMode: opts.coachingMode ?? "PRACTICE",
      feedbackReleasePolicy: "IMMEDIATE",
      knowledgeBaseVersion: "v1.0",
      status: opts.status ?? "DRAFT",
      jobOpportunityId: opts.jobId ?? null,
      jobDescriptionVersionId: opts.jdId ?? null,
    },
  });
}

/** One question answered; withFeedback=false leaves the feedback step undone. */
async function seedAnsweredInstance(
  sessionId: string,
  displayOrder: number,
  opts?: { withFeedback?: boolean },
) {
  const instance = await prisma.questionInstance.create({
    data: {
      sessionId,
      displayOrder,
      displayedText: `Question ${displayOrder}`,
      sourceKind: "AI_GENERATED",
      status: "ANSWERED",
    },
  });
  const attempt = await prisma.answerAttempt.create({
    data: {
      questionInstanceId: instance.id,
      sessionId,
      attemptNumber: 1,
      inputType: "TEXT",
      status: "COMPLETED",
      submittedAt: new Date(),
      completedAt: new Date(),
    },
  });
  const transcript = await prisma.transcript.create({
    data: {
      sessionId,
      answerAttemptId: attempt.id,
      fullText: "answer text",
      segments: "[]",
    },
  });
  const revision = await prisma.transcriptRevision.create({
    data: {
      transcriptId: transcript.id,
      answerAttemptId: attempt.id,
      revisionNumber: 1,
      revisionKind: "ORIGINAL_TEXT",
      fullText: "answer text",
      alignmentStatus: "NOT_APPLICABLE",
      contentHash: `hash-${instance.id}`,
    },
  });
  await prisma.answerAttempt.update({
    where: { id: attempt.id },
    data: { activeRevisionId: revision.id },
  });
  if (opts?.withFeedback === false) return { instance, attempt, revision };
  await prisma.feedbackGeneration.create({
    data: {
      answerAttemptId: attempt.id,
      questionInstanceId: instance.id,
      sessionId,
      versionNumber: 1,
      isCurrent: true,
      status: "SUCCEEDED",
      inputRevisionId: revision.id,
      inputContentHash: `hash-${instance.id}`,
      completedAt: new Date(),
    },
  });
  return { instance, attempt, revision };
}

async function seedUnansweredInstance(sessionId: string, displayOrder: number) {
  return prisma.questionInstance.create({
    data: {
      sessionId,
      displayOrder,
      displayedText: `Question ${displayOrder}`,
      sourceKind: "AI_GENERATED",
      status: "PENDING",
    },
  });
}

async function seedSummary(sessionId: string, status = "SUCCEEDED") {
  return prisma.sessionSummaryGeneration.create({
    data: {
      sessionId,
      versionNumber: 1,
      status,
      isCurrent: status === "SUCCEEDED",
      bodyText: status === "SUCCEEDED" ? "Summary body." : null,
      inputHash: `sum-${sessionId}`,
      completedAt: status === "SUCCEEDED" ? new Date() : null,
    },
  });
}

describe("createPrepGoal", () => {
  it("creates a goal pinned to the job's current JD version", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal, created } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    expect(created).toBe(true);
    expect(goal.status).toBe("ACTIVE");
    expect(goal.pinnedJobDescriptionVersionId).toBe(jd.id);
    expect(goal.pinnedJdContentHash).toBe(jd.contentHash);
    expect(goal.liveSlot).toBe(job.id);

    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.nextAction.kind).toBe("START_PRACTICE");
    expect(dto.progress.completed).toContain("GOAL_CREATED");
    expect(dto.progress.pending).toContain("START_PRACTICE");
    expect(dto.pinnedJd.versionNumber).toBe(1);
    expect(dto.jdDrift).toBe(false);
    expect(dto.handoffVerifiedAt).not.toBeNull();
  });

  it("dedupes requestKey retransmits and enforces one live goal per job", async () => {
    const job = await createJob();
    await setJd(job.id);
    const key = `req-${randomUUID()}`;
    const first = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: key,
    });
    const retry = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: key,
    });
    expect(retry.created).toBe(false);
    expect(retry.goal.id).toBe(first.goal.id);

    const second = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    expect(second.created).toBe(false);
    expect(second.goal.id).toBe(first.goal.id);
  });

  it("rejects cross-user, archived and JD-less jobs", async () => {
    const job = await createJob();
    await expect(
      createPrepGoal(prisma, otherUserId, {
        jobOpportunityId: job.id,
        requestKey: `req-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_JOB_NOT_FOUND" });

    const archived = await createJob({ archived: true });
    await setJd(archived.id);
    await expect(
      createPrepGoal(prisma, userId, {
        jobOpportunityId: archived.id,
        requestKey: `req-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_JOB_ARCHIVED" });

    const noJd = await createJob();
    await expect(
      createPrepGoal(prisma, userId, {
        jobOpportunityId: noJd.id,
        requestKey: `req-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_JD_REQUIRED" });
  });
});

describe("session binding", () => {
  it("links a compatible unbound session and lists candidates", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const session = await createSession({ jobId: job.id, jdId: jd.id });
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });

    const linkables = await listLinkablePrepSessions(prisma, userId, goal.id);
    expect(linkables.map((s) => s.id)).toContain(session.id);

    const dto = await linkPrepSession(prisma, userId, {
      goalId: goal.id,
      expectedRevision: goal.revision,
      sessionId: session.id,
    });
    expect(dto.session?.id).toBe(session.id);
    expect(dto.nextAction.kind).toBe("OPEN_SESSION");

    const bound = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(bound.interviewPrepGoalId).toBe(goal.id);
  });

  it("rejects sessions with a different job/JD pair or ownership", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    // Goal pins v1; a session frozen to the newer v2 on the SAME job is
    // FK-valid but is not the pair the goal pinned — the link gate must
    // reject it.
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const otherJd = await setJd(job.id, "JD v2 text");
    const mismatched = await createSession({ jobId: job.id, jdId: otherJd.id });
    const foreign = await createSession({
      jobId: job.id,
      jdId: jd.id,
      userId: otherUserId,
    });

    await expect(
      linkPrepSession(prisma, userId, {
        goalId: goal.id,
        expectedRevision: goal.revision,
        sessionId: mismatched.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_SESSION_MATERIAL_MISMATCH" });
    await expect(
      linkPrepSession(prisma, userId, {
        goalId: goal.id,
        expectedRevision: goal.revision,
        sessionId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_SESSION_NOT_FOUND" });
  });

  it("rejects a second bound session for the same goal", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const first = await createSession({ jobId: job.id, jdId: jd.id });
    const second = await createSession({ jobId: job.id, jdId: jd.id });
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
      linkSessionId: first.id,
    });
    await expect(
      linkPrepSession(prisma, userId, {
        goalId: goal.id,
        expectedRevision: goal.revision,
        sessionId: second.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_ALREADY_HAS_SESSION" });
  });
});

describe("verified progress and completion", () => {
  async function goalWithBoundSession(opts?: { answered?: number; total?: number }) {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const session = await createSession({
      jobId: job.id,
      jdId: jd.id,
      status: "IN_PROGRESS",
    });
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { interviewPrepGoalId: goal.id },
    });
    const total = opts?.total ?? 2;
    const answered = opts?.answered ?? 1;
    for (let i = 0; i < answered; i += 1) {
      await seedAnsweredInstance(session.id, i);
    }
    for (let i = answered; i < total; i += 1) {
      await seedUnansweredInstance(session.id, i);
    }
    return { job, jd, goal, session };
  }

  it("derives real progress and completion only after a persisted summary", async () => {
    const { goal, session } = await goalWithBoundSession({ answered: 0, total: 0 });
    // Question 1 answered but feedback not yet generated; question 2 pending
    // → PRACTICE evidence is not ready and ANSWER_QUESTIONS is pending.
    const q1 = await seedAnsweredInstance(session.id, 0, { withFeedback: false });
    await seedUnansweredInstance(session.id, 1);

    let dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.session?.answeredCount).toBe(1);
    expect(dto.session?.questionsTotal).toBe(2);
    expect(dto.progress.completed).toContain("PRACTICE_STARTED");
    expect(dto.progress.pending).toContain("ANSWER_QUESTIONS");
    expect(dto.nextAction.kind).toBe("OPEN_SESSION");
    expect(dto.status).toBe("ACTIVE");

    // Feedback lands on the answered question → evidence ready (PRACTICE
    // may skip the unanswered instance) → summary is the pending step.
    await prisma.feedbackGeneration.create({
      data: {
        answerAttemptId: q1.attempt.id,
        questionInstanceId: q1.instance.id,
        sessionId: session.id,
        versionNumber: 1,
        isCurrent: true,
        status: "SUCCEEDED",
        inputRevisionId: q1.revision.id,
        inputContentHash: `hash-${q1.instance.id}`,
        completedAt: new Date(),
      },
    });
    dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.progress.completed).toContain("PRACTICE_EVIDENCE_READY");
    expect(dto.progress.pending).toContain("GENERATE_SUMMARY");
    expect(dto.status).toBe("ACTIVE");

    // Persisted summary → goal completes and frees the live slot.
    await seedSummary(session.id);
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.status).toBe("COMPLETED");
    expect(dto.nextAction.kind).toBe("VIEW_SUMMARY");
    expect(dto.session?.summaryReady).toBe(true);

    const stored = await prisma.interviewPrepGoal.findUniqueOrThrow({
      where: { id: goal.id },
    });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.liveSlot).toBeNull();
    expect(stored.completedAt).not.toBeNull();
    const snapshot = parsePrepHandoff(stored.handoffJson);
    expect(snapshot?.session?.summaryReady).toBe(true);
    expect(snapshot?.goalRevision).toBe(stored.revision);
  });

  it("surfaces a failed latest summary as a retry pending item", async () => {
    const { goal, session } = await goalWithBoundSession({ answered: 1, total: 1 });
    await seedSummary(session.id, "FAILED");
    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.session?.summaryFailed).toBe(true);
    expect(dto.progress.pending).toContain("RETRY_SUMMARY");
    expect(dto.status).toBe("ACTIVE");
  });

  it("rebuilds deterministically when the handoff snapshot is missing or corrupt", async () => {
    const { goal, session } = await goalWithBoundSession({ answered: 1, total: 1 });
    await prisma.interviewPrepGoal.update({
      where: { id: goal.id },
      data: { handoffJson: "not-json{{{" },
    });
    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.session?.id).toBe(session.id);
    expect(dto.nextAction.kind).toBe("OPEN_SESSION");
    const stored = await prisma.interviewPrepGoal.findUniqueOrThrow({
      where: { id: goal.id },
    });
    expect(parsePrepHandoff(stored.handoffJson)?.session?.id).toBe(session.id);
  });

  it("flags SESSION_MISSING when a recorded binding disappears", async () => {
    const { goal, session } = await goalWithBoundSession({ answered: 1, total: 1 });
    await verifyAndSyncGoal(prisma, userId, goal.id); // snapshot now references the session
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { interviewPrepGoalId: null },
    });
    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.blockers).toContain("SESSION_MISSING");
  });
});

describe("material drift and blockers", () => {
  it("reports JD drift without rewriting the pinned source", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    await setJd(job.id, "JD v2 text");
    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.jdDrift).toBe(true);
    expect(dto.pinnedJd.versionId).toBe(jd.id);
    expect(dto.pinnedJd.versionNumber).toBe(1);
    expect(dto.currentJd?.versionNumber).toBe(2);
    // History stays intact — the goal still points at the pinned version.
  });

  it("blocks new practice on an archived job while keeping history readable", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    await prisma.jobOpportunity.update({
      where: { id: job.id },
      data: { archivedAt: new Date() },
    });
    const dto = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(dto.blockers).toContain("JOB_ARCHIVED");
    expect(dto.nextAction.kind).toBe("BLOCKED");

    await expect(
      validatePrepSessionCreation(prisma, userId, {
        goalId: goal.id,
        jobOpportunityId: job.id,
        jobDescriptionVersionId: jd.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_JOB_ARCHIVED" });
  });
});

describe("lifecycle and CAS", () => {
  async function liveGoal() {
    const job = await createJob();
    await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    return { job, goal };
  }

  it("pauses, resumes and ends with revision CAS", async () => {
    const { goal } = await liveGoal();

    const paused = await pausePrepGoal(prisma, userId, {
      goalId: goal.id,
      expectedRevision: goal.revision,
    });
    expect(paused.status).toBe("PAUSED");
    expect(paused.nextAction.kind).toBe("RESUME_GOAL");
    expect(paused.revision).toBe(goal.revision + 1);

    // Paused still occupies the live slot: a second create returns it.
    const dup = await createPrepGoal(prisma, userId, {
      jobOpportunityId: goal.jobOpportunityId,
      requestKey: `req-${randomUUID()}`,
    });
    expect(dup.created).toBe(false);
    expect(dup.goal.id).toBe(goal.id);

    // Stale revision loses the CAS race.
    await expect(
      resumePrepGoal(prisma, userId, {
        goalId: goal.id,
        expectedRevision: goal.revision,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_CONFLICT" });

    const resumed = await resumePrepGoal(prisma, userId, {
      goalId: goal.id,
      expectedRevision: paused.revision,
    });
    expect(resumed.status).toBe("ACTIVE");

    const ended = await endPrepGoal(prisma, userId, {
      goalId: goal.id,
      expectedRevision: resumed.revision,
    });
    expect(ended.status).toBe("ENDED");

    // End frees the live slot for a fresh goal.
    const fresh = await createPrepGoal(prisma, userId, {
      jobOpportunityId: goal.jobOpportunityId,
      requestKey: `req-${randomUUID()}`,
    });
    expect(fresh.created).toBe(true);
    expect(fresh.goal.id).not.toBe(goal.id);
  });

  it("new round ends the old goal and pins the current JD", async () => {
    const { job, goal } = await liveGoal();
    const jd2 = await setJd(job.id, "JD v2 text");
    const { goal: next, created } = await startNewPrepRound(prisma, userId, {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestKey: `req-${randomUUID()}`,
    });
    expect(created).toBe(true);
    const old = await prisma.interviewPrepGoal.findUniqueOrThrow({
      where: { id: goal.id },
    });
    expect(old.status).toBe("ENDED");
    expect(old.liveSlot).toBeNull();
    expect(next.pinnedJobDescriptionVersionId).toBe(jd2.id);
    expect(next.pinnedJobDescriptionVersionId).not.toBe(
      goal.pinnedJobDescriptionVersionId,
    );
  });
});

describe("validatePrepSessionCreation", () => {
  it("enforces the frozen pair, ACTIVE status and one-session rule", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const otherJob = await createJob();
    const otherJd = await setJd(otherJob.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });

    await expect(
      validatePrepSessionCreation(prisma, userId, {
        goalId: goal.id,
        jobOpportunityId: job.id,
        jobDescriptionVersionId: otherJd.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_MATERIAL_MISMATCH" });

    const gate = await validatePrepSessionCreation(prisma, userId, {
      goalId: goal.id,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(gate.alreadyBoundSessionId).toBeNull();
    expect(gate.goalRevision).toBe(goal.revision);

    const session = await createSession({ jobId: job.id, jdId: jd.id });
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { interviewPrepGoalId: goal.id },
    });
    const again = await validatePrepSessionCreation(prisma, userId, {
      goalId: goal.id,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(again.alreadyBoundSessionId).toBe(session.id);
  });

  it("rejects creation while paused", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const paused = await pausePrepGoal(prisma, userId, {
      goalId: goal.id,
      expectedRevision: goal.revision,
    });
    await expect(
      validatePrepSessionCreation(prisma, userId, {
        goalId: goal.id,
        jobOpportunityId: job.id,
        jobDescriptionVersionId: jd.id,
      }),
    ).rejects.toMatchObject({ code: "PREP_GOAL_PAUSED" });
    expect(paused.status).toBe("PAUSED");
  });
});

/**
 * The pre-flight validation runs outside the creation transaction, so the
 * transaction itself must re-claim the goal — a pause/end/new-round landing
 * between the two must abort the bind, not strand a session on a dead goal.
 */
describe("goal-bound session creation CAS", () => {
  const persistence = () => new VocatryaInterviewPersistence(prisma);
  const sessionInput = (
    job: { id: string },
    jd: { id: string },
    goal: { id: string },
    revision: number | null,
  ) => ({
    actorUserId: userId,
    coachingMode: "PRACTICE",
    knowledgeBaseVersion: "v1.0",
    jobOpportunityId: job.id,
    jobDescriptionVersionId: jd.id,
    interviewPrepGoalId: goal.id,
    expectedInterviewPrepGoalRevision: revision,
    questions: [{ displayedText: "First question?" }],
  });

  it("claims the bind inside the creation transaction and bumps revision", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const gate = await validatePrepSessionCreation(prisma, userId, {
      goalId: goal.id,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });

    const { session } = await persistence().createSession(
      sessionInput(job, jd, goal, gate.goalRevision),
    );
    const bound = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(bound.interviewPrepGoalId).toBe(goal.id);
    const after = await prisma.interviewPrepGoal.findUniqueOrThrow({
      where: { id: goal.id },
    });
    expect(after.revision).toBe(goal.revision + 1);

    // A retransmit carrying the now-stale revision cannot claim again.
    await expect(
      persistence().createSession(sessionInput(job, jd, goal, gate.goalRevision)),
    ).rejects.toMatchObject({ code: "PREP_GOAL_STATE_CHANGED" });
    expect(
      await prisma.interviewSession.count({
        where: { interviewPrepGoalId: goal.id },
      }),
    ).toBe(1);
  });

  it("aborts when the goal was paused after validation passed", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const gate = await validatePrepSessionCreation(prisma, userId, {
      goalId: goal.id,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    // Another window pauses the goal between validation and creation.
    await pausePrepGoal(prisma, userId, {
      goalId: goal.id,
      expectedRevision: gate.goalRevision,
    });

    await expect(
      persistence().createSession(sessionInput(job, jd, goal, gate.goalRevision)),
    ).rejects.toMatchObject({ code: "PREP_GOAL_STATE_CHANGED" });
    expect(
      await prisma.interviewSession.count({
        where: { interviewPrepGoalId: goal.id },
      }),
    ).toBe(0);
  });

  it("aborts when a new round ended the goal after validation passed", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const gate = await validatePrepSessionCreation(prisma, userId, {
      goalId: goal.id,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    // Another window ends this goal and starts a fresh round.
    await startNewPrepRound(prisma, userId, {
      goalId: goal.id,
      expectedRevision: gate.goalRevision,
      requestKey: `req-${randomUUID()}`,
    });

    await expect(
      persistence().createSession(sessionInput(job, jd, goal, gate.goalRevision)),
    ).rejects.toMatchObject({ code: "PREP_GOAL_STATE_CHANGED" });
    expect(
      await prisma.interviewSession.count({
        where: { interviewPrepGoalId: goal.id },
      }),
    ).toBe(0);
  });

  it("fails closed when the caller supplies no expected revision", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    await expect(
      persistence().createSession(sessionInput(job, jd, goal, null)),
    ).rejects.toMatchObject({ code: "PREP_GOAL_STATE_CHANGED" });
  });
});

describe("backup round trip", () => {
  it("restores goal, session binding and remapped handoff; completion survives", async () => {
    const job = await createJob();
    const jd = await setJd(job.id);
    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const session = await createSession({
      jobId: job.id,
      jdId: jd.id,
      status: "COMPLETED",
    });
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { interviewPrepGoalId: goal.id },
    });
    await seedAnsweredInstance(session.id, 0);
    await seedSummary(session.id);
    const before = await verifyAndSyncGoal(prisma, userId, goal.id);
    expect(before.status).toBe("COMPLETED");

    const data = await collectBackupData(userId);
    expect(data.InterviewPrepGoal).toHaveLength(1);
    expect(data.InterviewPrepGoal[0].id).toBe(goal.id);
    expect(data.InterviewSession[0].interviewPrepGoalId).toBe(goal.id);

    const { buffer } = await buildBackupZip(userId, "prep@example.com");
    const result = await importBackup(buffer, userId, "prep@example.com", true);
    expect(result.counts.InterviewPrepGoal).toBe(1);

    const restoredGoal = await prisma.interviewPrepGoal.findFirstOrThrow({
      where: { userId },
    });
    expect(restoredGoal.id).not.toBe(goal.id);
    expect(restoredGoal.status).toBe("COMPLETED");
    expect(restoredGoal.liveSlot).toBeNull();

    const restoredSession = await prisma.interviewSession.findFirstOrThrow({
      where: { userId },
    });
    expect(restoredSession.interviewPrepGoalId).toBe(restoredGoal.id);
    expect(restoredSession.id).not.toBe(session.id);

    // Embedded entity ids inside the snapshot were remapped too.
    const snapshot = parsePrepHandoff(restoredGoal.handoffJson);
    expect(snapshot?.goalId).toBe(restoredGoal.id);
    expect(snapshot?.session?.id).toBe(restoredSession.id);
    expect(snapshot?.job.pinnedJdVersionId).not.toBe(jd.id);

    // The restored business state still verifies to the same completion —
    // nothing about runtime execution was restored because none is stored.
    const after = await verifyAndSyncGoal(prisma, userId, restoredGoal.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.session?.summaryReady).toBe(true);
    expect(after.nextAction.kind).toBe("VIEW_SUMMARY");
  }, 120_000);

  it("defaults the group for pre-v9 backups and keeps the FK optional", () => {
    const parsed = BackupDataSchema.parse({});
    expect(parsed.InterviewPrepGoal).toEqual([]);
    // A v8 session row without the new column still parses.
    const parsedSession = BackupDataSchema.parse({
      InterviewSession: [
        {
          id: "s1",
          status: "DRAFT",
          coachingMode: "PRACTICE",
          feedbackReleasePolicy: "IMMEDIATE",
          feedbackReleasedAt: null,
          startedAt: null,
          completedAt: null,
          archivedAt: null,
          statusBeforeArchive: null,
          knowledgeBaseVersion: "v1",
          currentQuestionInstanceId: null,
          jobOpportunityId: null,
          jobDescriptionVersionId: null,
          createdVia: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(
      parsedSession.InterviewSession[0].interviewPrepGoalId,
    ).toBeUndefined();
  });
});

describe("getPrepGoalForJob", () => {
  it("finds the live goal, falls back to the latest finished goal, ignores other users", async () => {
    const job = await createJob();
    await setJd(job.id);
    expect(await getPrepGoalForJob(prisma, userId, job.id)).toBeNull();

    const { goal } = await createPrepGoal(prisma, userId, {
      jobOpportunityId: job.id,
      requestKey: `req-${randomUUID()}`,
    });
    const dto = await getPrepGoalForJob(prisma, userId, job.id);
    expect(dto?.id).toBe(goal.id);

    // Another user's goal on their own job is invisible here.
    await expect(
      getPrepGoalForJob(prisma, otherUserId, job.id),
    ).resolves.toBeNull();
  });
});

