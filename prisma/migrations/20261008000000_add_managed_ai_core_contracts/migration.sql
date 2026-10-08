ALTER TABLE "InterviewSession" ADD COLUMN "managedAiProvenance" TEXT;
ALTER TABLE "ChatConversation" ADD COLUMN "managedAiProvenance" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "managedAiProvenance" TEXT;
ALTER TABLE "ResumeVariantVersion" ADD COLUMN "managedAiProvenance" TEXT;
ALTER TABLE "MatchAnalysis" ADD COLUMN "managedAiProvenance" TEXT;
ALTER TABLE "JobDescriptionParse" ADD COLUMN "managedAiProvenance" TEXT;

-- SQLite partial index, like AutomationRun's active singleton. Prisma 6's
-- schema DSL cannot express the predicate; migrate deploy preserves it.
CREATE UNIQUE INDEX "AIConnection_userId_active_managed_key"
ON "AIConnection"("userId")
WHERE "provider" = 'VOCATRYA'
  AND "backendKind" = 'MANAGED_GATEWAY'
  AND "authType" = 'MANAGED'
  AND "archivedAt" IS NULL;
