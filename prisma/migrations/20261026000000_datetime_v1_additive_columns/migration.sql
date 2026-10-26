-- Additive only. Existing rows stay NULL. No UPDATE. No backfill.
-- Do not infer DateOnly from UTC midnight or from local midnight.

-- AlterTable
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "scheduledAtPrecision" TEXT;
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "scheduledAtZone" TEXT;
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "deadlineOn" TEXT;
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "deadlinePrecision" TEXT;
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "deadlineZone" TEXT;
ALTER TABLE "ApplicationProcessStep" ADD COLUMN "completedAtPrecision" TEXT;

-- AlterTable
ALTER TABLE "JobOpportunity" ADD COLUMN "deadlineOn" TEXT;
ALTER TABLE "JobOpportunity" ADD COLUMN "deadlinePrecision" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "dueOn" TEXT;
ALTER TABLE "Task" ADD COLUMN "duePrecision" TEXT;
