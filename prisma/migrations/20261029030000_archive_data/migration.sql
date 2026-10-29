-- Reversible archive for Career Dialogue conversations (BD-ARCHIVE).
ALTER TABLE "ChatConversation" ADD COLUMN "archivedAt" DATETIME;

-- Archive-center listing: per-user scans by archivedAt.
CREATE INDEX "ChatConversation_userId_archivedAt_idx" ON "ChatConversation"("userId", "archivedAt");
CREATE INDEX "JobOpportunity_userId_archivedAt_idx" ON "JobOpportunity"("userId", "archivedAt");
