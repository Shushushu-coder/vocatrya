-- Preserve HarnessTaskEvent children while rebuilding their parent table.
PRAGMA foreign_keys=OFF;

-- CreateTable
CREATE TABLE "AgentOperationProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "toolCallId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "turnKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "materialJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" DATETIME,
    "decisionReason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "harnessTaskId" TEXT,
    "dispatchKey" TEXT,
    "dispatchedAt" DATETIME,
    "outcomeStatus" TEXT,
    "outcomeJson" TEXT,
    "manualResolution" TEXT,
    "resolvedAt" DATETIME,
    "supersedesId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentOperationProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentOperationProposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- jobOpportunityId becomes nullable for non-job task kinds
-- (AGENT_TOOL_WRITE). SQLite cannot alter a column in place: rebuild the
-- table and copy every row, preserving ids/epochs for the runtime ledger.
CREATE TABLE "new_HarnessTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "pinnedJson" TEXT,
    "currentStep" TEXT,
    "jobOpportunityId" TEXT,
    "claimEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "startedAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" DATETIME,
    "failureCode" TEXT,
    "failureDetail" TEXT,
    "resultAnalysisId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "HarnessTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HarnessTask_resultAnalysisId_fkey" FOREIGN KEY ("resultAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_HarnessTask" ("id", "userId", "kind", "status", "requestKey", "inputHash", "inputJson", "pinnedJson", "currentStep", "jobOpportunityId", "claimEpoch", "leaseOwner", "leaseUntil", "startedAt", "lastHeartbeatAt", "attemptCount", "cancelRequestedAt", "failureCode", "failureDetail", "resultAnalysisId", "createdAt", "updatedAt", "completedAt") SELECT "id", "userId", "kind", "status", "requestKey", "inputHash", "inputJson", "pinnedJson", "currentStep", "jobOpportunityId", "claimEpoch", "leaseOwner", "leaseUntil", "startedAt", "lastHeartbeatAt", "attemptCount", "cancelRequestedAt", "failureCode", "failureDetail", "resultAnalysisId", "createdAt", "updatedAt", "completedAt" FROM "HarnessTask";
DROP TABLE "HarnessTask";
ALTER TABLE "new_HarnessTask" RENAME TO "HarnessTask";

-- CreateIndex
CREATE UNIQUE INDEX "HarnessTask_resultAnalysisId_key" ON "HarnessTask"("resultAnalysisId");

-- CreateIndex
CREATE UNIQUE INDEX "HarnessTask_userId_kind_requestKey_key" ON "HarnessTask"("userId", "kind", "requestKey");

-- CreateIndex
CREATE INDEX "HarnessTask_status_leaseUntil_idx" ON "HarnessTask"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "HarnessTask_userId_kind_status_idx" ON "HarnessTask"("userId", "kind", "status");

-- CreateIndex
CREATE INDEX "HarnessTask_userId_jobOpportunityId_idx" ON "HarnessTask"("userId", "jobOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOperationProposal_toolCallId_key" ON "AgentOperationProposal"("toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOperationProposal_approvalId_key" ON "AgentOperationProposal"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOperationProposal_harnessTaskId_key" ON "AgentOperationProposal"("harnessTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOperationProposal_dispatchKey_key" ON "AgentOperationProposal"("dispatchKey");

-- CreateIndex
CREATE INDEX "AgentOperationProposal_conversationId_idx" ON "AgentOperationProposal"("conversationId");

-- CreateIndex
CREATE INDEX "AgentOperationProposal_userId_status_idx" ON "AgentOperationProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "AgentOperationProposal_status_expiresAt_idx" ON "AgentOperationProposal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentOperationProposal_userId_toolName_inputHash_idx" ON "AgentOperationProposal"("userId", "toolName", "inputHash");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
