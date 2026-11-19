-- Agent long-task harness, card A: task ledger + handoff chain + event log.
-- Purely additive: three new tables and one nullable column. No existing row
-- is rewritten and no existing migration is touched.

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "jobOpportunityId" TEXT,
    "interviewPrepGoalId" TEXT,
    "milestone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "acceptanceItems" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "liveSlot" TEXT,
    "activeSessionId" TEXT,
    "activeSessionClaimedAt" DATETIME,
    "blockedReason" TEXT,
    "blockedInputKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "AgentTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentTask_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentTask_interviewPrepGoalId_fkey" FOREIGN KEY ("interviewPrepGoalId") REFERENCES "InterviewPrepGoal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentTaskHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "sessionId" TEXT,
    "generationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTaskHandoff_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentTaskHandoff_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatConversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentTaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
-- Additive nullable column with an inline SetNull FK, written as ADD COLUMN
-- instead of the generated table rebuild so no ChatConversation row is copied
-- or dropped. NULL = ordinary chat; a task session is a Pilot-role
-- conversation (agentRole 'pilot') linked here.
ALTER TABLE "ChatConversation" ADD COLUMN "agentTaskId" TEXT REFERENCES "AgentTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ChatConversation_agentTaskId_idx" ON "ChatConversation"("agentTaskId");

-- CreateIndex
CREATE INDEX "AgentTask_userId_status_idx" ON "AgentTask"("userId", "status");

-- CreateIndex
CREATE INDEX "AgentTask_jobOpportunityId_idx" ON "AgentTask"("jobOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTask_userId_liveSlot_key" ON "AgentTask"("userId", "liveSlot");

-- CreateIndex
CREATE INDEX "AgentTaskHandoff_taskId_createdAt_idx" ON "AgentTaskHandoff"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTaskHandoff_taskId_revision_key" ON "AgentTaskHandoff"("taskId", "revision");

-- CreateIndex
CREATE INDEX "AgentTaskEvent_taskId_createdAt_idx" ON "AgentTaskEvent"("taskId", "createdAt");
