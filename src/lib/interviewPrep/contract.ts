/**
 * Interview prep goal contract (client-safe — no server-only imports).
 *
 * One goal = "prepare for interviews for one job". The goal pins the JD
 * version it prepares against, binds at most one InterviewSession
 * (InterviewSession.interviewPrepGoalId) and carries a deterministic
 * structured handoff snapshot. Everything user-visible is recomputed by the
 * server from business records on every read; the persisted snapshot is a
 * resume aid, never the source of truth.
 */

export const PREP_GOAL_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "ENDED",
] as const;
export type PrepGoalStatus = (typeof PREP_GOAL_STATUSES)[number];

export const PREP_NEXT_ACTIONS = [
  // No session yet and the job/JD context is usable → enter the existing
  // session creation flow with the pinned job/JD + goal id.
  "START_PRACTICE",
  // Session bound and not summary-complete → open the same session page.
  "OPEN_SESSION",
  // Summary persisted → open the session page (summary is rendered there).
  "VIEW_SUMMARY",
  // Goal is PAUSED → resume it first.
  "RESUME_GOAL",
  // Live goal exists but cannot continue on the pinned material → user may
  // explicitly end it and start a new round on the current JD.
  "NEW_ROUND",
  // No allowed action (blocked with no in-place repair, or ENDED).
  "BLOCKED",
  "NONE",
] as const;
export type PrepNextAction = (typeof PREP_NEXT_ACTIONS)[number];

export const PREP_BLOCKER_CODES = [
  "JOB_ARCHIVED",
  "JOB_MISSING",
  "PINNED_JD_MISSING",
  "SESSION_MISSING",
  "SESSION_ARCHIVED",
] as const;
export type PrepBlockerCode = (typeof PREP_BLOCKER_CODES)[number];

// Deterministic progress item codes. `completed` items are backed by
// persisted business records; `pending` items are what remains before the
// goal can complete. UI localizes each code.
export const PREP_PROGRESS_CODES = [
  "GOAL_CREATED",
  "PRACTICE_STARTED",
  "PRACTICE_EVIDENCE_READY",
  "SUMMARY_READY",
] as const;
export type PrepProgressCode = (typeof PREP_PROGRESS_CODES)[number];

export const PREP_PENDING_CODES = [
  "START_PRACTICE",
  "ANSWER_QUESTIONS",
  "GENERATE_SUMMARY",
  "RETRY_SUMMARY",
] as const;
export type PrepPendingCode = (typeof PREP_PENDING_CODES)[number];

export type PrepSessionState = {
  id: string;
  status: string;
  coachingMode: string;
  /** Non-skipped question instances. */
  questionsTotal: number;
  /** Instances with a completed answer attempt. */
  answeredCount: number;
  /** Instances with completed attempt + current succeeded feedback. */
  feedbackReadyCount: number;
  summaryReady: boolean;
  summaryGenerationId: string | null;
  summaryCompletedAt: string | null;
  /** Latest summary generation failed → retry is the pending action. */
  summaryFailed: boolean;
  currentQuestionDisplayOrder: number | null;
};

export type PrepGoalDTO = {
  id: string;
  status: PrepGoalStatus;
  revision: number;
  jobOpportunityId: string;
  jobTitle: string | null;
  jobArchived: boolean;
  pinnedJd: {
    versionId: string;
    versionNumber: number | null;
    contentHash: string;
  };
  currentJd: { versionId: string; versionNumber: number } | null;
  /** Pinned version is not the job's current version (or current is gone). */
  jdDrift: boolean;
  session: PrepSessionState | null;
  progress: {
    completed: PrepProgressCode[];
    pending: PrepPendingCode[];
  };
  blockers: PrepBlockerCode[];
  nextAction: { kind: PrepNextAction; sessionId: string | null };
  handoffVerifiedAt: string | null;
  createdAt: string;
  pausedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
};

export type PrepLinkableSessionDTO = {
  id: string;
  status: string;
  coachingMode: string;
  createdAt: string;
  answeredCount: number;
  questionsTotal: number;
};

/** Persisted structured handoff (handoffJson), schemaVersion'd. */
export const PREP_HANDOFF_SCHEMA_VERSION = 1;

export type PrepHandoffSnapshot = {
  schemaVersion: number;
  goalId: string;
  goalRevision: number;
  job: {
    id: string;
    archived: boolean;
    pinnedJdVersionId: string;
    pinnedJdVersionNumber: number | null;
    pinnedJdContentHash: string;
    currentJdVersionId: string | null;
    currentJdVersionNumber: number | null;
    jdDrift: boolean;
  };
  session: PrepSessionState | null;
  progress: { completed: PrepProgressCode[]; pending: PrepPendingCode[] };
  blockers: PrepBlockerCode[];
  nextAction: { kind: PrepNextAction; sessionId: string | null };
  verifiedAt: string;
};

export function parsePrepHandoff(
  json: string | null | undefined,
): PrepHandoffSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as PrepHandoffSnapshot;
    if (
      !parsed ||
      parsed.schemaVersion !== PREP_HANDOFF_SCHEMA_VERSION ||
      typeof parsed.goalId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
