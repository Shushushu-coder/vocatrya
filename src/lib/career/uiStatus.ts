import { ATTEMPT_OUTCOME, ATTEMPT_STAGE, OPPORTUNITY_STATUS } from "./identities";
import { attemptSortKey } from "./applicationTimeline";

export type UiStatusAttempt = {
  id?: string;
  currentStageCategory: string;
  outcome: string;
  submittedAt: Date | null;
  createdAt: Date;
};

export type UiStatusWritePlan =
  | { kind: "noop" }
  | { kind: "expire-opportunity" }
  | { kind: "archive-opportunity" }
  | {
      kind: "attempt";
      currentStageCategory: string;
      outcome: string;
      markSubmitted: boolean;
    };

export function deriveUiStatus(input: {
  archivedAt: Date | null;
  opportunityStatus: string;
  attempt: UiStatusAttempt | null;
}): string {
  if (input.archivedAt) return "archived";
  if (input.opportunityStatus === OPPORTUNITY_STATUS.EXPIRED) return "expired";
  const attempt = input.attempt;
  if (!attempt) return "draft";
  if (attempt.outcome === ATTEMPT_OUTCOME.HIRED) return "offer-accepted";
  if (attempt.outcome === ATTEMPT_OUTCOME.WITHDRAWN) return "offer-declined";
  if (attempt.outcome === ATTEMPT_OUTCOME.REJECTED) return "rejected";
  if (attempt.outcome === ATTEMPT_OUTCOME.TRANSFERRED) return "transferred";
  if (attempt.outcome === ATTEMPT_OUTCOME.OFFER) return "offer";
  const stage = attempt.currentStageCategory;
  if (
    stage === ATTEMPT_STAGE.INTERVIEW ||
    stage === ATTEMPT_STAGE.SCREENING ||
    stage === ATTEMPT_STAGE.ASSESSMENT
  ) {
    return "interview";
  }
  if (stage === ATTEMPT_STAGE.OFFER) return "offer";
  if (stage === ATTEMPT_STAGE.SUBMITTED || attempt.submittedAt) return "applied";
  return "draft";
}

/**
 * A+B job views carry `abCompat.uiStatus`; "archived" there is the canonical
 * reversible archive — AI paths must treat it as absent. A Legacy Job's
 * archived status value stays list-visible and readable (D1 boundary), so
 * this check intentionally looks at abCompat only, not Status.value.
 */
export function isArchivedCanonicalJobView(job: {
  abCompat?: { uiStatus?: string | null } | null;
  [key: string]: unknown;
}): boolean {
  return job.abCompat?.uiStatus === "archived";
}

export function planUiStatusWrite(uiStatus: string): UiStatusWritePlan {
  switch (uiStatus.toLowerCase()) {
    case "expired":
      return { kind: "expire-opportunity" };
    case "archived":
      return { kind: "archive-opportunity" };
    case "applied":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
        markSubmitted: true,
      };
    case "interview":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.INTERVIEW,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
        markSubmitted: false,
      };
    case "offer":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.OFFER,
        outcome: ATTEMPT_OUTCOME.OFFER,
        markSubmitted: false,
      };
    case "rejected":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.CLOSED,
        outcome: ATTEMPT_OUTCOME.REJECTED,
        markSubmitted: false,
      };
    case "offer-accepted":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.CLOSED,
        outcome: ATTEMPT_OUTCOME.HIRED,
        markSubmitted: false,
      };
    case "offer-declined":
      return {
        kind: "attempt",
        currentStageCategory: ATTEMPT_STAGE.CLOSED,
        outcome: ATTEMPT_OUTCOME.WITHDRAWN,
        markSubmitted: false,
      };
    default:
      return { kind: "noop" };
  }
}

export function isOfferUiStatus(uiStatus: string): boolean {
  return uiStatus === "offer" || uiStatus === "offer-accepted";
}

export function compareAttemptsByLatest(
  a: UiStatusAttempt,
  b: UiStatusAttempt,
): number {
  const byKey = attemptSortKey(b) - attemptSortKey(a);
  if (byKey !== 0) return byKey;
  const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return (b.id ?? "").localeCompare(a.id ?? "");
}

export function pickLatestAttempt<T extends UiStatusAttempt>(
  attempts: T[],
): T | null {
  if (attempts.length === 0) return null;
  return [...attempts].sort(compareAttemptsByLatest)[0] ?? null;
}
