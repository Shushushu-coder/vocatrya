import "server-only";

import { Prisma, type InterviewPrepGoal, type PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "@/lib/career/errors";
import { VocatryaInterviewQueries } from "@/lib/interview/services/hostQueries";
import {
  PREP_HANDOFF_SCHEMA_VERSION,
  parsePrepHandoff,
  type PrepBlockerCode,
  type PrepGoalDTO,
  type PrepHandoffSnapshot,
  type PrepLinkableSessionDTO,
  type PrepNextAction,
  type PrepPendingCode,
  type PrepProgressCode,
  type PrepSessionState,
} from "./contract";

/**
 * Interview prep goal service — server-authoritative business state.
 *
 * Boundaries:
 * - The goal row is long-lived user state (backed up). It pins the job + JD
 *   version, binds at most one InterviewSession (via the session's
 *   interviewPrepGoalId column) and stores a deterministic handoff snapshot.
 * - InterviewSession stays the practice carrier; progress is recomputed from
 *   the real question/attempt/feedback/summary rows on every read — never
 *   trusted from the snapshot or the client.
 * - No runtime/lease state lives here; restore cannot resurrect execution.
 *
 * `revision` is the CAS counter for every lifecycle mutation. `liveSlot`
 * (= jobOpportunityId while ACTIVE|PAUSED) enforces one live goal per job.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const LIVE_STATUSES = ["ACTIVE", "PAUSED"] as const;
const LINKABLE_SESSION_STATUSES = ["DRAFT", "IN_PROGRESS", "COACHING", "COMPLETED"];

function prepError(code: string, message: string): never {
  throw new CareerRuntimeError(code, message);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export async function loadGoalForUser(
  db: Db,
  userId: string,
  goalId: string,
): Promise<InterviewPrepGoal> {
  const goal = nonEmpty(goalId)
    ? await db.interviewPrepGoal.findUnique({ where: { id: goalId } })
    : null;
  if (!goal || goal.userId !== userId) {
    prepError("PREP_GOAL_NOT_FOUND", "Interview prep goal not found.");
  }
  return goal;
}

// ---------------------------------------------------------------------------
// Verified state — recomputed from business records on every read.
// ---------------------------------------------------------------------------

type VerifiedFacts = {
  jobTitle: string | null;
  jobArchived: boolean;
  pinnedJd: { versionId: string; versionNumber: number | null; contentHash: string };
  currentJd: { versionId: string; versionNumber: number } | null;
  jdDrift: boolean;
  session: PrepSessionState | null;
  progress: { completed: PrepProgressCode[]; pending: PrepPendingCode[] };
  blockers: PrepBlockerCode[];
  nextAction: { kind: PrepNextAction; sessionId: string | null };
  /** The verified facts justify flipping an ACTIVE goal to COMPLETED. */
  shouldComplete: boolean;
};

async function computeVerifiedFacts(
  db: Db,
  queries: VocatryaInterviewQueries,
  goal: InterviewPrepGoal,
  storedSnapshot: PrepHandoffSnapshot | null,
): Promise<VerifiedFacts> {
  const job = await db.jobOpportunity.findUnique({
    where: { id: goal.jobOpportunityId },
  });
  const jobMissing = !job || job.userId !== goal.userId;
  const pinnedJdRow = await db.jobDescriptionVersion.findUnique({
    where: { id: goal.pinnedJobDescriptionVersionId },
  });
  const pinnedJdValid =
    !!pinnedJdRow && !!job && pinnedJdRow.jobOpportunityId === job.id;
  const currentJdRow =
    job?.currentJdVersionId != null
      ? await db.jobDescriptionVersion.findUnique({
          where: { id: job.currentJdVersionId },
        })
      : null;
  const jobArchived = !jobMissing && job.archivedAt != null;
  const jdDrift =
    !jobMissing && job.currentJdVersionId !== goal.pinnedJobDescriptionVersionId;

  const blockers: PrepBlockerCode[] = [];
  if (jobMissing) blockers.push("JOB_MISSING");
  else if (jobArchived) blockers.push("JOB_ARCHIVED");
  if (!pinnedJdValid) blockers.push("PINNED_JD_MISSING");

  // The session binding lives on the session row; a goal owns at most one.
  const sessionRow = await db.interviewSession.findUnique({
    where: { interviewPrepGoalId: goal.id },
  });
  const boundSession =
    sessionRow && sessionRow.userId === goal.userId ? sessionRow : null;

  let session: PrepSessionState | null = null;
  let attemptWithoutFeedback = 0;
  if (boundSession) {
    if (boundSession.status === "ARCHIVED") blockers.push("SESSION_ARCHIVED");
    const instances = await db.questionInstance.findMany({
      where: { sessionId: boundSession.id },
      orderBy: { displayOrder: "asc" },
    });
    const required = instances.filter((row) => row.status !== "SKIPPED");
    let answeredCount = 0;
    let feedbackReadyCount = 0;
    attemptWithoutFeedback = 0;
    for (const instance of required) {
      const attempt = await queries.findLatestCompletedAttempt(instance.id);
      if (!attempt) continue;
      answeredCount += 1;
      const feedback = await queries.findCurrentSucceededFeedback(attempt.id);
      if (feedback) feedbackReadyCount += 1;
      else attemptWithoutFeedback += 1;
    }
    const currentSummary = await queries.getCurrentSummaryGeneration(
      boundSession.id,
    );
    const latestSummary = await db.sessionSummaryGeneration.findFirst({
      where: { sessionId: boundSession.id },
      orderBy: [{ versionNumber: "desc" }, { id: "desc" }],
    });
    const currentInstance =
      instances.find((row) => row.id === boundSession.currentQuestionInstanceId) ??
      null;
    session = {
      id: boundSession.id,
      status: boundSession.status,
      coachingMode: boundSession.coachingMode,
      questionsTotal: required.length,
      answeredCount,
      feedbackReadyCount,
      summaryReady: currentSummary != null,
      summaryGenerationId: currentSummary?.id ?? null,
      summaryCompletedAt: currentSummary?.completedAt?.toISOString() ?? null,
      summaryFailed:
        currentSummary == null && latestSummary?.status === "FAILED",
      currentQuestionDisplayOrder: currentInstance?.displayOrder ?? null,
    };
  } else if (storedSnapshot?.session?.id) {
    // A previous verification recorded a bound session that no longer
    // points at this goal — a lost association, surfaced truthfully.
    blockers.push("SESSION_MISSING");
  }

  const evidenceReady =
    session != null &&
    session.questionsTotal > 0 &&
    session.feedbackReadyCount >= 1 &&
    attemptWithoutFeedback === 0 &&
    (session.coachingMode !== "MOCK" ||
      session.answeredCount === session.questionsTotal);

  const completed: PrepProgressCode[] = ["GOAL_CREATED"];
  if (session && session.answeredCount > 0) completed.push("PRACTICE_STARTED");
  if (evidenceReady) completed.push("PRACTICE_EVIDENCE_READY");
  if (session?.summaryReady) completed.push("SUMMARY_READY");

  const pending: PrepPendingCode[] = [];
  if (!session) {
    pending.push("START_PRACTICE");
  } else if (!evidenceReady) {
    pending.push("ANSWER_QUESTIONS");
  } else if (!session.summaryReady) {
    pending.push(session.summaryFailed ? "RETRY_SUMMARY" : "GENERATE_SUMMARY");
  }

  const canUsePinnedMaterial =
    !jobMissing && !jobArchived && pinnedJdValid && !blockers.includes("SESSION_ARCHIVED") && !blockers.includes("SESSION_MISSING");
  const canStartNewRound =
    !jobMissing && !jobArchived && job?.currentJdVersionId != null;

  let nextAction: { kind: PrepNextAction; sessionId: string | null };
  if (goal.status === "ENDED") {
    nextAction = { kind: "NONE", sessionId: null };
  } else if (goal.status === "PAUSED") {
    nextAction = { kind: "RESUME_GOAL", sessionId: null };
  } else if (goal.status === "COMPLETED") {
    nextAction = session?.summaryReady
      ? { kind: "VIEW_SUMMARY", sessionId: session.id }
      : { kind: "NONE", sessionId: null };
  } else if (session?.summaryReady) {
    nextAction = { kind: "VIEW_SUMMARY", sessionId: session.id };
  } else if (session && boundSession?.status !== "ARCHIVED") {
    // Existing session stays openable even on an archived job — existing
    // interview rules govern what the session page itself allows.
    nextAction = { kind: "OPEN_SESSION", sessionId: session.id };
  } else if (!session && canUsePinnedMaterial) {
    nextAction = { kind: "START_PRACTICE", sessionId: null };
  } else if (canStartNewRound) {
    nextAction = { kind: "NEW_ROUND", sessionId: null };
  } else {
    nextAction = { kind: "BLOCKED", sessionId: null };
  }

  return {
    jobTitle: job?.title ?? null,
    jobArchived,
    pinnedJd: {
      versionId: goal.pinnedJobDescriptionVersionId,
      versionNumber: pinnedJdValid ? pinnedJdRow.versionNumber : null,
      contentHash: goal.pinnedJdContentHash,
    },
    currentJd:
      currentJdRow && !jobMissing
        ? { versionId: currentJdRow.id, versionNumber: currentJdRow.versionNumber }
        : null,
    jdDrift,
    session,
    progress: { completed, pending },
    blockers,
    nextAction,
    shouldComplete:
      goal.status === "ACTIVE" && session?.summaryReady === true,
  };
}

function toDTO(goal: InterviewPrepGoal, facts: VerifiedFacts): PrepGoalDTO {
  return {
    id: goal.id,
    status: goal.status as PrepGoalDTO["status"],
    revision: goal.revision,
    jobOpportunityId: goal.jobOpportunityId,
    jobTitle: facts.jobTitle,
    jobArchived: facts.jobArchived,
    pinnedJd: facts.pinnedJd,
    currentJd: facts.currentJd,
    jdDrift: facts.jdDrift,
    session: facts.session,
    progress: facts.progress,
    blockers: facts.blockers,
    nextAction: facts.nextAction,
    handoffVerifiedAt: goal.handoffVerifiedAt?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(),
    pausedAt: goal.pausedAt?.toISOString() ?? null,
    completedAt: goal.completedAt?.toISOString() ?? null,
    endedAt: goal.endedAt?.toISOString() ?? null,
  };
}

function buildSnapshot(
  goal: InterviewPrepGoal,
  facts: VerifiedFacts,
  verifiedAt: Date,
): PrepHandoffSnapshot {
  return {
    schemaVersion: PREP_HANDOFF_SCHEMA_VERSION,
    goalId: goal.id,
    goalRevision: goal.revision,
    job: {
      id: goal.jobOpportunityId,
      archived: facts.jobArchived,
      pinnedJdVersionId: facts.pinnedJd.versionId,
      pinnedJdVersionNumber: facts.pinnedJd.versionNumber,
      pinnedJdContentHash: facts.pinnedJd.contentHash,
      currentJdVersionId: facts.currentJd?.versionId ?? null,
      currentJdVersionNumber: facts.currentJd?.versionNumber ?? null,
      jdDrift: facts.jdDrift,
    },
    session: facts.session,
    progress: facts.progress,
    blockers: facts.blockers,
    nextAction: facts.nextAction,
    verifiedAt: verifiedAt.toISOString(),
  };
}

/**
 * Verify the goal against live business records and persist the outcome:
 * lifecycle transition (ACTIVE → COMPLETED when the summary is genuinely
 * persisted) plus the structured handoff snapshot. The snapshot is written
 * only when the verified content changed, so plain reloads do not churn
 * revisions. CAS on (id, userId, seenRevision) keeps two writers honest.
 */
export async function verifyAndSyncGoal(
  db: PrismaClient,
  userId: string,
  goalId: string,
): Promise<PrepGoalDTO> {
  const queries = new VocatryaInterviewQueries(db);
  // Converges in one retry: a lost CAS race only means someone else wrote a
  // newer revision, which a re-read then verifies.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const goal = await loadGoalForUser(db, userId, goalId);
    const stored = parsePrepHandoff(goal.handoffJson);
    const facts = await computeVerifiedFacts(db, queries, goal, stored);
    const now = new Date();
    const nextRevision = goal.revision + (facts.shouldComplete ? 1 : 0);
    const snapshot = buildSnapshot(
      { ...goal, revision: nextRevision },
      facts,
      now,
    );
    const snapshotJson = JSON.stringify(snapshot);

    const storedComparable = stored
      ? JSON.stringify({ ...stored, verifiedAt: "" })
      : null;
    const snapshotComparable = JSON.stringify({ ...snapshot, verifiedAt: "" });
    const snapshotStale = storedComparable !== snapshotComparable;

    if (!facts.shouldComplete && !snapshotStale) {
      return toDTO(goal, facts);
    }

    const patch: Prisma.InterviewPrepGoalUpdateManyMutationInput = facts.shouldComplete
      ? {
          status: "COMPLETED",
          completedAt: now,
          liveSlot: null,
          revision: { increment: 1 },
          handoffJson: snapshotJson,
          handoffGoalRevision: nextRevision,
          handoffVerifiedAt: now,
        }
      : {
          handoffJson: snapshotJson,
          handoffGoalRevision: goal.revision,
          handoffVerifiedAt: now,
        };
    const result = await db.interviewPrepGoal.updateMany({
      where: { id: goal.id, userId, revision: goal.revision },
      data: patch,
    });
    if (result.count === 1) {
      const fresh = await loadGoalForUser(db, userId, goalId);
      return toDTO(fresh, facts);
    }
  }
  const fresh = await loadGoalForUser(db, userId, goalId);
  const stored = parsePrepHandoff(fresh.handoffJson);
  const facts = await computeVerifiedFacts(db, queries, fresh, stored);
  return toDTO(fresh, facts);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function assertLinkableSession(
  db: Db,
  userId: string,
  sessionId: string,
  jobId: string,
  jdId: string,
) {
  const session = await db.interviewSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.userId !== userId) {
    prepError("PREP_GOAL_SESSION_NOT_FOUND", "Interview session not found.");
  }
  if (session.status === "ARCHIVED") {
    prepError("PREP_GOAL_SESSION_ARCHIVED", "That session is archived.");
  }
  if (session.interviewPrepGoalId) {
    prepError(
      "PREP_GOAL_SESSION_BOUND",
      "That session is already bound to a prep goal.",
    );
  }
  if (
    session.jobOpportunityId !== jobId ||
    session.jobDescriptionVersionId !== jdId
  ) {
    prepError(
      "PREP_GOAL_SESSION_MATERIAL_MISMATCH",
      "That session was created against a different job or JD version.",
    );
  }
}

export async function createPrepGoal(
  db: PrismaClient,
  userId: string,
  input: {
    jobOpportunityId: string;
    requestKey: string;
    linkSessionId?: string | null;
  },
): Promise<{ goal: InterviewPrepGoal; created: boolean }> {
  if (!nonEmpty(input?.jobOpportunityId) || !nonEmpty(input?.requestKey)) {
    prepError(
      "PREP_GOAL_REQUEST_INVALID",
      "A job and a request key are required.",
    );
  }
  // requestKey is the create identity: retransmits return the same goal.
  const byKey = await db.interviewPrepGoal.findUnique({
    where: { userId_requestKey: { userId, requestKey: input.requestKey } },
  });
  if (byKey) return { goal: byKey, created: false };

  const job = await db.jobOpportunity.findUnique({
    where: { id: input.jobOpportunityId },
  });
  if (!job || job.userId !== userId) {
    prepError("PREP_GOAL_JOB_NOT_FOUND", "Job opportunity not found.");
  }
  if (job.archivedAt) {
    prepError(
      "PREP_GOAL_JOB_ARCHIVED",
      "Archived jobs cannot start a new prep goal.",
    );
  }
  if (!nonEmpty(job.currentJdVersionId)) {
    prepError(
      "PREP_GOAL_JD_REQUIRED",
      "This job has no JD version to prepare against.",
    );
  }
  const jd = await db.jobDescriptionVersion.findUnique({
    where: { id: job.currentJdVersionId },
  });
  if (!jd || jd.jobOpportunityId !== job.id) {
    prepError("PREP_GOAL_JD_NOT_FOUND", "Job description version not found.");
  }

  // One live goal per job: a second create returns the existing goal.
  const live = await db.interviewPrepGoal.findUnique({
    where: { userId_liveSlot: { userId, liveSlot: job.id } },
  });
  if (live) return { goal: live, created: false };

  const linkSessionId = nonEmpty(input.linkSessionId)
    ? input.linkSessionId
    : null;
  if (linkSessionId) {
    await assertLinkableSession(db, userId, linkSessionId, job.id, jd.id);
  }

  try {
    const goal = await db.$transaction(async (tx) => {
      const created = await tx.interviewPrepGoal.create({
        data: {
          userId,
          jobOpportunityId: job.id,
          pinnedJobDescriptionVersionId: jd.id,
          pinnedJdContentHash: jd.contentHash,
          requestKey: input.requestKey,
          liveSlot: job.id,
          status: "ACTIVE",
        },
      });
      if (linkSessionId) {
        const linked = await tx.interviewSession.updateMany({
          where: { id: linkSessionId, interviewPrepGoalId: null },
          data: { interviewPrepGoalId: created.id },
        });
        if (linked.count !== 1) {
          prepError(
            "PREP_GOAL_SESSION_BOUND",
            "That session is already bound to a prep goal.",
          );
        }
      }
      return created;
    });
    return { goal, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Concurrent create raced the unique indexes — the other writer won;
      // return whichever goal now owns the key or the live slot.
      const existing =
        (await db.interviewPrepGoal.findUnique({
          where: {
            userId_requestKey: { userId, requestKey: input.requestKey },
          },
        })) ??
        (await db.interviewPrepGoal.findUnique({
          where: { userId_liveSlot: { userId, liveSlot: job.id } },
        }));
      if (existing) return { goal: existing, created: false };
    }
    throw error;
  }
}

export async function getPrepGoalForJob(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
): Promise<PrepGoalDTO | null> {
  if (!nonEmpty(jobOpportunityId)) return null;
  const live = await db.interviewPrepGoal.findUnique({
    where: { userId_liveSlot: { userId, liveSlot: jobOpportunityId } },
  });
  const goal =
    live ??
    (await db.interviewPrepGoal.findFirst({
      where: { userId, jobOpportunityId },
      orderBy: { createdAt: "desc" },
    }));
  if (!goal) return null;
  return verifyAndSyncGoal(db, userId, goal.id);
}

export async function getPrepGoal(
  db: PrismaClient,
  userId: string,
  goalId: string,
): Promise<PrepGoalDTO> {
  const goal = await loadGoalForUser(db, userId, goalId);
  return verifyAndSyncGoal(db, userId, goal.id);
}

async function transitionGoal(
  db: PrismaClient,
  userId: string,
  input: {
    goalId: string;
    expectedRevision: number;
    allowedFrom: readonly string[];
    patch: Prisma.InterviewPrepGoalUpdateManyMutationInput;
  },
): Promise<InterviewPrepGoal> {
  const goal = await loadGoalForUser(db, userId, input.goalId);
  // Idempotent retransmit: the goal already sits in the target state.
  if (!input.allowedFrom.includes(goal.status)) {
    return goal;
  }
  const result = await db.interviewPrepGoal.updateMany({
    where: {
      id: goal.id,
      userId,
      revision: input.expectedRevision,
      status: { in: [...input.allowedFrom] },
    },
    data: { ...input.patch, revision: { increment: 1 } },
  });
  if (result.count !== 1) {
    const fresh = await loadGoalForUser(db, userId, goal.id);
    if (!input.allowedFrom.includes(fresh.status)) return fresh;
    prepError(
      "PREP_GOAL_CONFLICT",
      "The goal changed since you loaded it. Reload and try again.",
    );
  }
  return loadGoalForUser(db, userId, goal.id);
}

export async function pausePrepGoal(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; expectedRevision: number },
): Promise<PrepGoalDTO> {
  const goal = await transitionGoal(db, userId, {
    goalId: input.goalId,
    expectedRevision: input.expectedRevision,
    allowedFrom: ["ACTIVE"],
    patch: { status: "PAUSED", pausedAt: new Date() },
  });
  return verifyAndSyncGoal(db, userId, goal.id);
}

export async function resumePrepGoal(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; expectedRevision: number },
): Promise<PrepGoalDTO> {
  const goal = await transitionGoal(db, userId, {
    goalId: input.goalId,
    expectedRevision: input.expectedRevision,
    allowedFrom: ["PAUSED"],
    patch: { status: "ACTIVE", pausedAt: null },
  });
  return verifyAndSyncGoal(db, userId, goal.id);
}

export async function endPrepGoal(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; expectedRevision: number },
): Promise<PrepGoalDTO> {
  const goal = await transitionGoal(db, userId, {
    goalId: input.goalId,
    expectedRevision: input.expectedRevision,
    allowedFrom: [...LIVE_STATUSES],
    patch: { status: "ENDED", endedAt: new Date(), liveSlot: null },
  });
  return verifyAndSyncGoal(db, userId, goal.id);
}

/**
 * Explicit new round: the current live goal is ended in the same
 * transaction that creates its replacement pinned to the job's *current*
 * JD. History stays bound to the old goal — nothing is retitled.
 */
export async function startNewPrepRound(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; expectedRevision: number; requestKey: string },
): Promise<{ goal: InterviewPrepGoal; created: boolean }> {
  if (!nonEmpty(input?.requestKey)) {
    prepError("PREP_GOAL_REQUEST_INVALID", "A request key is required.");
  }
  const byKey = await db.interviewPrepGoal.findUnique({
    where: { userId_requestKey: { userId, requestKey: input.requestKey } },
  });
  if (byKey) return { goal: byKey, created: false };

  const old = await loadGoalForUser(db, userId, input.goalId);
  const job = await db.jobOpportunity.findUnique({
    where: { id: old.jobOpportunityId },
  });
  if (!job || job.userId !== userId) {
    prepError("PREP_GOAL_JOB_NOT_FOUND", "Job opportunity not found.");
  }
  if (job.archivedAt) {
    prepError(
      "PREP_GOAL_JOB_ARCHIVED",
      "Archived jobs cannot start a new prep goal.",
    );
  }
  if (!nonEmpty(job.currentJdVersionId)) {
    prepError(
      "PREP_GOAL_JD_REQUIRED",
      "This job has no JD version to prepare against.",
    );
  }
  const jd = await db.jobDescriptionVersion.findUnique({
    where: { id: job.currentJdVersionId },
  });
  if (!jd || jd.jobOpportunityId !== job.id) {
    prepError("PREP_GOAL_JD_NOT_FOUND", "Job description version not found.");
  }

  try {
    const goal = await db.$transaction(async (tx) => {
      if (LIVE_STATUSES.includes(old.status as (typeof LIVE_STATUSES)[number])) {
        const ended = await tx.interviewPrepGoal.updateMany({
          where: {
            id: old.id,
            userId,
            revision: input.expectedRevision,
            status: { in: [...LIVE_STATUSES] },
          },
          data: {
            status: "ENDED",
            endedAt: new Date(),
            liveSlot: null,
            revision: { increment: 1 },
          },
        });
        if (ended.count !== 1) {
          prepError(
            "PREP_GOAL_CONFLICT",
            "The goal changed since you loaded it. Reload and try again.",
          );
        }
      }
      return tx.interviewPrepGoal.create({
        data: {
          userId,
          jobOpportunityId: job.id,
          pinnedJobDescriptionVersionId: jd.id,
          pinnedJdContentHash: jd.contentHash,
          requestKey: input.requestKey,
          liveSlot: job.id,
          status: "ACTIVE",
        },
      });
    });
    return { goal, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing =
        (await db.interviewPrepGoal.findUnique({
          where: {
            userId_requestKey: { userId, requestKey: input.requestKey },
          },
        })) ??
        (await db.interviewPrepGoal.findUnique({
          where: { userId_liveSlot: { userId, liveSlot: job.id } },
        }));
      if (existing) return { goal: existing, created: false };
    }
    throw error;
  }
}

export async function linkPrepSession(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; expectedRevision: number; sessionId: string },
): Promise<PrepGoalDTO> {
  const goal = await loadGoalForUser(db, userId, input.goalId);
  if (goal.status !== "ACTIVE") {
    prepError(
      "PREP_GOAL_NOT_ACTIVE",
      "Only an active goal can bind a practice session.",
    );
  }
  const bound = await db.interviewSession.findUnique({
    where: { interviewPrepGoalId: goal.id },
  });
  if (bound) {
    prepError(
      "PREP_GOAL_ALREADY_HAS_SESSION",
      "This goal already has a practice session.",
    );
  }
  await assertLinkableSession(
    db,
    userId,
    input.sessionId,
    goal.jobOpportunityId,
    goal.pinnedJobDescriptionVersionId,
  );
  try {
    await db.$transaction(async (tx) => {
      const linked = await tx.interviewSession.updateMany({
        where: { id: input.sessionId, interviewPrepGoalId: null },
        data: { interviewPrepGoalId: goal.id },
      });
      if (linked.count !== 1) {
        prepError(
          "PREP_GOAL_SESSION_BOUND",
          "That session is already bound to a prep goal.",
        );
      }
      const bumped = await tx.interviewPrepGoal.updateMany({
        where: { id: goal.id, userId, revision: input.expectedRevision },
        data: { revision: { increment: 1 } },
      });
      if (bumped.count !== 1) {
        prepError(
          "PREP_GOAL_CONFLICT",
          "The goal changed since you loaded it. Reload and try again.",
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      prepError(
        "PREP_GOAL_SESSION_BOUND",
        "That session is already bound to a prep goal.",
      );
    }
    throw error;
  }
  return verifyAndSyncGoal(db, userId, goal.id);
}

export async function listLinkablePrepSessions(
  db: PrismaClient,
  userId: string,
  goalId: string,
): Promise<PrepLinkableSessionDTO[]> {
  const goal = await loadGoalForUser(db, userId, goalId);
  const sessions = await db.interviewSession.findMany({
    where: {
      userId,
      jobOpportunityId: goal.jobOpportunityId,
      jobDescriptionVersionId: goal.pinnedJobDescriptionVersionId,
      interviewPrepGoalId: null,
      status: { in: LINKABLE_SESSION_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const rows: PrepLinkableSessionDTO[] = [];
  for (const session of sessions) {
    const questionsTotal = await db.questionInstance.count({
      where: { sessionId: session.id, status: { not: "SKIPPED" } },
    });
    const answeredCount = await db.questionInstance.count({
      where: { sessionId: session.id, status: "ANSWERED" },
    });
    rows.push({
      id: session.id,
      status: session.status,
      coachingMode: session.coachingMode,
      createdAt: session.createdAt.toISOString(),
      answeredCount,
      questionsTotal,
    });
  }
  return rows;
}

/**
 * Gate for goal-bound session creation (called by
 * createInterviewSessionAction before any model/planning work). Validates
 * ownership, ACTIVE lifecycle, the frozen job/JD pair and the one-session
 * rule. Returns the already-bound session when the create is a retransmit.
 */
export async function validatePrepSessionCreation(
  db: PrismaClient,
  userId: string,
  input: { goalId: string; jobOpportunityId: string; jobDescriptionVersionId: string },
): Promise<{ alreadyBoundSessionId: string | null; goalRevision: number }> {
  const goal = await loadGoalForUser(db, userId, input.goalId);
  if (goal.status === "PAUSED") {
    prepError(
      "PREP_GOAL_PAUSED",
      "Resume this prep goal before starting practice.",
    );
  }
  if (goal.status !== "ACTIVE") {
    prepError(
      "PREP_GOAL_NOT_ACTIVE",
      "This prep goal is no longer active.",
    );
  }
  if (
    goal.jobOpportunityId !== input.jobOpportunityId ||
    goal.pinnedJobDescriptionVersionId !== input.jobDescriptionVersionId
  ) {
    prepError(
      "PREP_GOAL_MATERIAL_MISMATCH",
      "The session must use the goal's pinned job and JD version.",
    );
  }
  const job = await db.jobOpportunity.findUnique({
    where: { id: goal.jobOpportunityId },
  });
  if (!job || job.userId !== userId) {
    prepError("PREP_GOAL_JOB_NOT_FOUND", "Job opportunity not found.");
  }
  if (job.archivedAt) {
    prepError(
      "PREP_GOAL_JOB_ARCHIVED",
      "Archived jobs cannot start a new practice session.",
    );
  }
  const bound = await db.interviewSession.findUnique({
    where: { interviewPrepGoalId: goal.id },
  });
  // The caller forwards goalRevision into the creation transaction, which
  // re-checks it there — a pause/end/new-round after this read must abort
  // the bind, not strand a session on a stale validation.
  return { alreadyBoundSessionId: bound?.id ?? null, goalRevision: goal.revision };
}
