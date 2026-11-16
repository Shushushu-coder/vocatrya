-- CreateTable
CREATE TABLE "HarnessTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "pinnedJson" TEXT,
    "currentStep" TEXT,
    "jobOpportunityId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "HarnessTaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HarnessTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HarnessTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
CREATE UNIQUE INDEX "HarnessTaskEvent_taskId_seq_key" ON "HarnessTaskEvent"("taskId", "seq");

-- CreateIndex
CREATE INDEX "HarnessTaskEvent_taskId_type_idx" ON "HarnessTaskEvent"("taskId", "type");
