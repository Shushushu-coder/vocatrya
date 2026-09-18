-- Additive only: Interview reflection root field + ordered Q&A child rows.
-- Existing InterviewDetail rows stay reflectionText NULL with no items.
-- No backfill from notes, roundLabel, or structuredData.

-- AlterTable
ALTER TABLE "ApplicationInterviewDetail" ADD COLUMN "reflectionText" TEXT;

-- CreateTable
CREATE TABLE "ApplicationInterviewReflectionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationInterviewDetailId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerNotes" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationInterviewReflectionItem_applicationInterviewDetailId_fkey" FOREIGN KEY ("applicationInterviewDetailId") REFERENCES "ApplicationInterviewDetail" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ApplicationInterviewReflectionItem_applicationInterviewDetailId_sortOrder_idx" ON "ApplicationInterviewReflectionItem"("applicationInterviewDetailId", "sortOrder");
