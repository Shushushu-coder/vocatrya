import { INSERT_ORDER, type BackupModel } from "./ordering";

export const BACKUP_COVERAGE_STATUS = {
  BACKED_UP: "BACKED_UP",
  INTENTIONALLY_EXCLUDED: "INTENTIONALLY_EXCLUDED",
} as const;

export type BackupCoverageStatus =
  (typeof BACKUP_COVERAGE_STATUS)[keyof typeof BACKUP_COVERAGE_STATUS];

// Prisma models that are not user-state ZIP groups. A missing classification
// for any other schema model fails the coverage guard test.
// Interview models are included in product backup starting from this change:
// legacy backups without Interview sections still restore (groups default to
// []), and new backups carry the full 14-model Interview graph.
// Dataset axis (spec v1 §20, frozen; payload shape unchanged, no format bump):
// QuestionBank = COVERED REFERENCE_DATA (REFERENCE_DATA_SNAPSHOT, present in
// export, used during restore, never user-wiped) — not INTENTIONALLY_EXCLUDED
// and not USER_DATA. QuestionBankItem = COVERED USER_DATA membership
// (user-scoped via Question.createdBy). Remaining Interview models keep their
// existing user-closure semantics.
export const INTENTIONALLY_EXCLUDED_PRISMA_MODELS = [
  "User",
  "ApiKey",
  "McpAccessToken",
  "JobStatus",
  "DataMigrationRun",
  // Derived from ChatConversation messages and rebuilt on eligible turns.
  "ConversationSummary",
  // Transient pre-invocation state for one canonical resume import. Its
  // durable identity is the client request id (resource/operation keys are
  // derived from it), and the settled output lands in ResumeVariantVersion.
  "ResumeImportAttempt",
  // Durable per-turn Agent tool-execution reservation (match_job): a
  // runtime recovery ledger, not user state. The settled outcome lands in
  // MatchAnalysis (backed up); restoring executions would resurrect
  // reservations whose persisted turn semantics no longer hold. Rows still
  // present on the same install keep dedupe/replay working.
  "AgentToolExecution",
] as const;

export const BACKED_UP_PRISMA_MODELS: readonly BackupModel[] = INSERT_ORDER;

export function backupCoverageStatus(
  prismaModel: string,
): BackupCoverageStatus | undefined {
  if ((INTENTIONALLY_EXCLUDED_PRISMA_MODELS as readonly string[]).includes(prismaModel)) {
    return BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED;
  }
  if ((BACKED_UP_PRISMA_MODELS as readonly string[]).includes(prismaModel)) {
    return BACKUP_COVERAGE_STATUS.BACKED_UP;
  }
  return undefined;
}
