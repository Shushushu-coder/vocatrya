-- CreateTable
CREATE TABLE "InterviewPrepGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobOpportunityId" TEXT NOT NULL,
    "pinnedJobDescriptionVersionId" TEXT NOT NULL,
    "pinnedJdContentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestKey" TEXT NOT NULL,
    "liveSlot" TEXT,
    "handoffJson" TEXT,
    "handoffGoalRevision" INTEGER,
    "handoffVerifiedAt" DATETIME,
    "pausedAt" DATETIME,
    "completedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewPrepGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewPrepGoal_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewPrepGoal_pinnedJobDescriptionVersionId_fkey" FOREIGN KEY ("pinnedJobDescriptionVersionId") REFERENCES "JobDescriptionVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN "interviewPrepGoalId" TEXT REFERENCES "InterviewPrepGoal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "InterviewPrepGoal_userId_requestKey_key" ON "InterviewPrepGoal"("userId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewPrepGoal_userId_liveSlot_key" ON "InterviewPrepGoal"("userId", "liveSlot");

-- CreateIndex
CREATE INDEX "InterviewPrepGoal_userId_jobOpportunityId_idx" ON "InterviewPrepGoal"("userId", "jobOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewSession_interviewPrepGoalId_key" ON "InterviewSession"("interviewPrepGoalId");
