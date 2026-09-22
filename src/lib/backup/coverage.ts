import { INSERT_ORDER, type BackupModel } from "./ordering";

export const BACKUP_COVERAGE_STATUS = {
  BACKED_UP: "BACKED_UP",
  INTENTIONALLY_EXCLUDED: "INTENTIONALLY_EXCLUDED",
} as const;

export type BackupCoverageStatus =
  (typeof BACKUP_COVERAGE_STATUS)[keyof typeof BACKUP_COVERAGE_STATUS];

// Prisma models that are not user-state ZIP groups. A missing classification
// for any other schema model fails the coverage guard test.
// Phase 3A Interview tables are intentionally excluded: the transplant is
// schema+migration only and no backup/restore path covers them yet.
// Backup coverage for Interview data belongs to the later wiring phase.
export const INTENTIONALLY_EXCLUDED_PRISMA_MODELS = [
  "User",
  "ApiKey",
  "McpAccessToken",
  "ChatConversation",
  "JobStatus",
  "DataMigrationRun",
  "QuestionBank",
  "QuestionBankItem",
  "InterviewSession",
  "QuestionInstance",
  "AnswerAttempt",
  "AnswerInputArtifact",
  "Transcript",
  "TranscriptRevision",
  "FeedbackGeneration",
  "FeedbackItem",
  "SessionSummaryGeneration",
  "SessionSummaryInput",
  "CoachingConversation",
  "DialogueTurn",
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
