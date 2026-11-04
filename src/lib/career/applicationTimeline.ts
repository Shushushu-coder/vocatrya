export type SubmittedResumeDTO = {
  id: string;
  title: string;
  versionNumber: number;
  resumeVariantId: string;
  resumeVariantVersionId: string;
} | null;

/**
 * Structured time input for process-step fields (frozen DateTime consumer
 * contract): `scheduledAt` accepts only a wall time (a bare date is not a
 * schedule), `deadlineAt` accepts a calendar day or a wall time. The server
 * resolves both against the account time zone. `null` clears the field;
 * `undefined` (update inputs only) leaves every stored column untouched so
 * historical unknown precision is never rewritten silently.
 */
export type StepTimeInput =
  | { kind: "dateOnly"; date: string }
  | { kind: "wallTime"; date: string; hour: number; minute: number }
  | null;

export type ApplicationProcessStepDTO = {
  id: string;
  category: string;
  label: string;
  status: string;
  source: string;
  scheduledAt: string | null;
  scheduledAtPrecision: "minute" | "unknown" | null;
  scheduledAtZone: string | null;
  deadlineOn: string | null;
  deadlineAt: string | null;
  deadlinePrecision: "dateOnly" | "minute" | "fullInstant" | "unknown" | null;
  deadlineZone: string | null;
  completedAt: string | null;
  completedAtPrecision: "fullInstant" | "unknown" | null;
  result: string | null;
  notes: string | null;
};

export type TransferredFromDTO = {
  attemptId: string;
  opportunityId: string;
  title: string;
  company: string;
};

export type ApplicationAttemptTimelineDTO = {
  id: string;
  channelLabel: string;
  submittedAt: string | null;
  createdAt: string;
  archivedAt: string | null;
  currentStageCategory: string;
  outcome: string;
  transferredFromAttemptId: string | null;
  transferredFrom: TransferredFromDTO | null;
  submittedResume: SubmittedResumeDTO;
  steps: ApplicationProcessStepDTO[];
};

export type ApplicationTimelineDTO = {
  opportunityId: string;
  /** Account time zone resolved at request time; consumers display and
   *  backfill wall times in this zone, never the host zone. */
  timeZone: string;
  attempts: ApplicationAttemptTimelineDTO[];
};

/**
 * P-B JOB-CONNECTIONS: the immutable first-bound artifact actually sent with
 * an attempt. Bytes may be missing after backup restore (re-exportable); the
 * row itself is the submission fact.
 */
export type SubmittedArtifactDTO = {
  id: string;
  kind: string;
  format: string;
  fileName: string;
  sha256: string;
  byteSize: number | null;
} | null;

/**
 * P-B JOB-CONNECTIONS: the JD version the attempt was submitted against.
 * Immutable first binding; the opportunity's currentJdVersion may move on.
 */
export type SubmittedJdVersionDTO = {
  id: string;
  versionNumber: number;
  capturedAt: string;
} | null;

/**
 * Per-attempt actual-submission materials for the "planned vs actual"
 * comparison. The submitted resume version row itself rides the existing
 * `ApplicationAttemptTimelineDTO.submittedResume`; this DTO carries the two
 * remaining immutable `submitted*` references.
 */
export type AttemptSubmissionMaterialsDTO = {
  attemptId: string;
  submittedArtifact: SubmittedArtifactDTO;
  submittedAgainstJdVersion: SubmittedJdVersionDTO;
};

/**
 * A ResumeVariant whose `targetJobOpportunityId` points at this job — the
 * mutable "planned to use" binding (contract §4.2). `currentVersion` is the
 * variant's live pointer, NOT a submission fact; it drifts with editing.
 */
export type PlannedResumeVariantDTO = {
  id: string;
  name: string;
  archivedAt: string | null;
  currentVersion: {
    id: string;
    versionNumber: number;
    status: string;
  } | null;
};

/**
 * Job-level aggregation for the job-details "planned vs actual submission"
 * view (contract §14.1 P-B). Read-only projection over existing columns.
 *
 * `practiceSessions` counts InterviewSession rows linked to this job by the
 * validated (jobOpportunityId, jobDescriptionVersionId) pair — practice/mock
 * sessions only, never real interview rounds (contract §8/D11); real rounds
 * are the INTERVIEW process steps in `ApplicationTimelineDTO.attempts[].steps`.
 * All linked sessions count regardless of status; the session archive path
 * exists in schema only and has no productized writer today.
 */
export type JobConnectionsDTO = {
  opportunityId: string;
  currentJdVersion: { id: string; versionNumber: number } | null;
  plannedResumeVariants: PlannedResumeVariantDTO[];
  practiceSessions: {
    total: number;
    byJdVersion: Array<{
      jdVersionId: string;
      versionNumber: number;
      count: number;
    }>;
  };
  attemptMaterials: AttemptSubmissionMaterialsDTO[];
};

export type TransferTargetOpportunityDTO = {
  id: string;
  title: string;
  company: string;
};

export type TransferTargetPageDTO = {
  items: TransferTargetOpportunityDTO[];
  nextOffset: number | null;
};

export type SubmittedResumeBindingAttemptDTO = {
  id: string;
  channelLabel: string;
  createdAt: string;
  submittedAt: string | null;
  submittedResume: SubmittedResumeDTO;
};

export type SubmittedResumeBindingsDTO = {
  opportunityId: string | null;
  attempts: SubmittedResumeBindingAttemptDTO[];
};

export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Maps a stored precision sidecar onto the DTO vocabulary: NULL when the
 * value itself is absent, the declared precision when it is one of the
 * field's legal values, "unknown" for anything else (hand-edited rows,
 * pre-contract writes). Never inferred from the value.
 */
export function declaredStepPrecision<T extends string>(
  stored: string | null,
  hasValue: boolean,
  allowed: readonly T[],
): T | "unknown" | null {
  if (!hasValue) return null;
  return stored !== null && (allowed as readonly string[]).includes(stored)
    ? (stored as T)
    : "unknown";
}

export function attemptSortKey(attempt: {
  submittedAt: Date | null;
  createdAt: Date;
}): number {
  return (attempt.submittedAt ?? attempt.createdAt).getTime();
}

export function compareProcessSteps(
  a: { sortOrder: number; scheduledAt: Date | null; createdAt: Date },
  b: { sortOrder: number; scheduledAt: Date | null; createdAt: Date },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const aScheduled = a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bScheduled = b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aScheduled !== bScheduled) return aScheduled - bScheduled;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
