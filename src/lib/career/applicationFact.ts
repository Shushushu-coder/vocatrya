import { Prisma } from "@prisma/client";
import { ATTEMPT_STAGE } from "./identities";

// The single "ever applied" fact contract for the A+B read family. A
// JobOpportunity counts as applied when at least one non-archived
// ApplicationAttempt either carries a real submittedAt or has already moved
// past DRAFT — stage-aware, any-attempt, position-level dedup. Stage-only
// history (e.g. migrated attempts whose submission timestamp was never
// recorded) is still applied; a live draft is not.
//
// appliedDate is a separate dimension: always MIN(submittedAt) over live
// attempts, null when no real submission timestamp exists. The fact must
// never be re-derived from createdAt, the latest attempt, or a stage alone,
// and the date must never be inferred from the fact.
//
// All three shapes below express the identical predicate. New consumers —
// including the R1B-02B dictionary-statistics branch — must reuse this module
// instead of re-declaring the rule.

// Row-level predicate for already-loaded live attempts (e.g. DTO mapping).
// Callers must pass non-archived attempts only, matching the list include.
export function isAppliedAttempt(attempt: {
  submittedAt: Date | null;
  currentStageCategory: string;
}): boolean {
  return (
    attempt.submittedAt !== null ||
    attempt.currentStageCategory !== ATTEMPT_STAGE.DRAFT
  );
}

// Prisma relation-filter fragment for `applicationAttempts` some/none — the
// same predicate as isAppliedAttempt plus the live (non-archived) guard.
export const APPLIED_ATTEMPT_WHERE = {
  archivedAt: null,
  OR: [
    { submittedAt: { not: null } },
    { currentStageCategory: { not: ATTEMPT_STAGE.DRAFT } },
  ],
} satisfies Prisma.ApplicationAttemptWhereInput;

// Raw-SQL EXISTS equivalent correlated to the "o" JobOpportunity alias used
// by the opportunity list queries. Mirrors APPLIED_ATTEMPT_WHERE exactly.
export function appliedAttemptExistsSql() {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ApplicationAttempt" s
    WHERE s.jobOpportunityId = o.id
      AND s.archivedAt IS NULL
      AND (
        s.submittedAt IS NOT NULL
        OR s.currentStageCategory <> ${ATTEMPT_STAGE.DRAFT}
      )
  )`;
}

// The appliedDate aggregate: first real submission over live attempts,
// correlated to the "o" alias. Returns NULL for stage-only applied history —
// never a fabricated date. Pure date query, deliberately NOT stage-aware.
export function firstSubmittedAtSql() {
  return Prisma.sql`(
    SELECT MIN(s.submittedAt) FROM "ApplicationAttempt" s
    WHERE s.jobOpportunityId = o.id
      AND s.archivedAt IS NULL
      AND s.submittedAt IS NOT NULL
  )`;
}
