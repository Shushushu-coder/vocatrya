export type SubmittedResumeDTO = {
  id: string;
  title: string;
  versionNumber: number;
  resumeVariantId: string;
  resumeVariantVersionId: string;
} | null;

export type ApplicationProcessStepDTO = {
  id: string;
  category: string;
  label: string;
  status: string;
  source: string;
  scheduledAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
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
  submittedAt: string | null;
  createdAt: string;
  currentStageCategory: string;
  outcome: string;
  transferredFromAttemptId: string | null;
  transferredFrom: TransferredFromDTO | null;
  submittedResume: SubmittedResumeDTO;
  steps: ApplicationProcessStepDTO[];
};

export type ApplicationTimelineDTO = {
  opportunityId: string;
  attempts: ApplicationAttemptTimelineDTO[];
};

export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
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
