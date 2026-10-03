-- Disposable Career Dialogue transcript-compression cache.
-- Existing ChatConversation rows are left untouched. No backfill.
-- CreateTable
CREATE TABLE "ConversationSummary" (
    "conversationId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "text" TEXT,
    "throughMessageId" TEXT,
    "coverageHash" TEXT,
    "coveredCount" INTEGER,
    "promptVersion" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER,
    "generationMs" INTEGER,
    "generatedAt" DATETIME,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" DATETIME,
    CONSTRAINT "ConversationSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ConversationSummary_userId_idx" ON "ConversationSummary"("userId");
