-- Additive only: China campus recruitment core fields.
-- Existing rows stay NULL. No backfill from dates, titles, or companies.

-- AlterTable
ALTER TABLE "JobOpportunity" ADD COLUMN "recruitmentCohort" TEXT;
ALTER TABLE "JobOpportunity" ADD COLUMN "recruitmentBatch" TEXT;

-- AlterTable
ALTER TABLE "ApplicationAttempt" ADD COLUMN "transferredFromAttemptId" TEXT REFERENCES "ApplicationAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ApplicationAttempt_transferredFromAttemptId_idx" ON "ApplicationAttempt"("transferredFromAttemptId");
