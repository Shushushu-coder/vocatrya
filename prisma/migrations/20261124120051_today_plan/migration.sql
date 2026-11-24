-- CreateTable
CREATE TABLE "TodayPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "plannedOn" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TodayPlanItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TodayPlanItem_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TodayPlanItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TodayPlanOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "undoJson" TEXT,
    "resultJson" TEXT,
    "undoneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TodayPlanOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TodayPlanOperation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TodayPlanItem_userId_conversationId_plannedOn_idx" ON "TodayPlanItem"("userId", "conversationId", "plannedOn");

-- CreateIndex
CREATE INDEX "TodayPlanItem_userId_taskId_idx" ON "TodayPlanItem"("userId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TodayPlanItem_conversationId_taskId_key" ON "TodayPlanItem"("conversationId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TodayPlanOperation_operationKey_key" ON "TodayPlanOperation"("operationKey");

-- CreateIndex
CREATE INDEX "TodayPlanOperation_userId_conversationId_idx" ON "TodayPlanOperation"("userId", "conversationId");
