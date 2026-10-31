-- CreateTable
CREATE TABLE "AgentToolExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "turnKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "matchAnalysisId" TEXT,
    "failureCode" TEXT,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "AgentToolExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentToolExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentToolExecution_matchAnalysisId_fkey" FOREIGN KEY ("matchAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolExecution_operationKey_key" ON "AgentToolExecution"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolExecution_matchAnalysisId_key" ON "AgentToolExecution"("matchAnalysisId");

-- CreateIndex
CREATE INDEX "AgentToolExecution_userId_status_idx" ON "AgentToolExecution"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolExecution_conversationId_toolName_turnKey_key" ON "AgentToolExecution"("conversationId", "toolName", "turnKey");
