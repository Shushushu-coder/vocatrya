-- Additive only: ApplicationProcessStep.deadlineAt.
-- Existing rows stay NULL. No backfill from scheduledAt or notes.

-- AlterTable
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "deadlineAt" DATETIME;
