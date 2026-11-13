-- UI-RC-JOB-ORDER: custom ordering + pin for the My Jobs list.
-- NULL sortOrder = unpositioned (front of the normal section, createdAt desc);
-- pinnedAt non-null = pinned section, ordered by sortOrder within it.
ALTER TABLE "Job" ADD COLUMN "sortOrder" INTEGER;
ALTER TABLE "Job" ADD COLUMN "pinnedAt" DATETIME;
ALTER TABLE "JobOpportunity" ADD COLUMN "sortOrder" INTEGER;
ALTER TABLE "JobOpportunity" ADD COLUMN "pinnedAt" DATETIME;
