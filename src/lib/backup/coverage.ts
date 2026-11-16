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
// []), and new backups carry the full 14-model Interview graph plus the
// user-owned InterviewPrepGoal (long-lived business state — the bound
// session, not the goal, holds runtime-progress truth).
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
  // Harness deep-match tasks and their trace events: runtime execution
  // ownership (leases, claim epochs, cancel state), not user state. The
  // settled artifact is the bound MatchAnalysis (backed up). Restoring
  // task rows would resurrect leases as if they were still live; a
  // restored install simply re-starts a deep match from the UI.
  "HarnessTask",
  "HarnessTaskEvent",
  // EXT-NOTION connection state carries a sealed OAuth credential bundle and
  // an in-flight OAuth flow bound to this install's safeStorage — neither
  // can travel. A restored install starts DISCONNECTED and the user
  // re-authorizes the workspace in place.
  "NotionConnection",
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
