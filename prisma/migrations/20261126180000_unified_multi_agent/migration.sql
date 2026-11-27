-- Unified multi-agent chat foundation (D08):
-- 1) ChatConversation additive columns: chatMode + activeRole.
-- 2) ChatTurn + ChatTurnStep lightweight turn/step provenance & handoff ledger.
-- 3) NativeConversationBinding evolved from 1:1 conversationId PK to
--    per-(conversationId, roleKey) unique binding while preserving existing rows.

ALTER TABLE "ChatConversation" ADD COLUMN "chatMode" TEXT NOT NULL DEFAULT 'LEGACY_ROLE_BOUND';
ALTER TABLE "ChatConversation" ADD COLUMN "activeRole" TEXT;

CREATE TABLE "ChatTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requestId" TEXT,
    "userMessageId" TEXT,
    "operation" TEXT NOT NULL DEFAULT 'send',
    "routeLayer" TEXT NOT NULL DEFAULT 'layer0',
    "routeReason" TEXT,
    "plannedStepCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ChatTurn_conversationId_createdAt_idx" ON "ChatTurn"("conversationId", "createdAt");
CREATE INDEX "ChatTurn_userId_createdAt_idx" ON "ChatTurn"("userId", "createdAt");

CREATE TABLE "ChatTurnStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "objective" TEXT,
    "resolvedConnectionId" TEXT,
    "resolvedModel" TEXT,
    "executionPath" TEXT NOT NULL DEFAULT 'APP_ORCHESTRATED',
    "configSource" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "handoffJson" TEXT,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatTurnStep_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatTurnStep_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatTurnStep_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "ChatTurn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChatTurnStep_turnId_stepIndex_key" ON "ChatTurnStep"("turnId", "stepIndex");
CREATE INDEX "ChatTurnStep_conversationId_createdAt_idx" ON "ChatTurnStep"("conversationId", "createdAt");
CREATE INDEX "ChatTurnStep_userId_conversationId_idx" ON "ChatTurnStep"("userId", "conversationId");

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NativeConversationBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL DEFAULT 'legacy_single',
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "runtimeProfileRef" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "initializationState" TEXT NOT NULL DEFAULT 'READY',
    "lastSyncedMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NativeConversationBinding_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NativeConversationBinding" (
    "id",
    "conversationId",
    "roleKey",
    "userId",
    "connectionId",
    "model",
    "runtimeVersion",
    "runtimeProfileRef",
    "configHash",
    "threadId",
    "promptHash",
    "initializationState",
    "lastSyncedMessageId",
    "createdAt",
    "updatedAt"
)
SELECT
    lower(hex(randomblob(16))),
    "conversationId",
    'legacy_single',
    "userId",
    "connectionId",
    "model",
    "runtimeVersion",
    "runtimeProfileRef",
    "configHash",
    "threadId",
    "promptHash",
    'READY',
    NULL,
    "createdAt",
    "updatedAt"
FROM "NativeConversationBinding";
DROP TABLE "NativeConversationBinding";
ALTER TABLE "new_NativeConversationBinding" RENAME TO "NativeConversationBinding";
CREATE UNIQUE INDEX "NativeConversationBinding_conversationId_roleKey_key" ON "NativeConversationBinding"("conversationId", "roleKey");
CREATE INDEX "NativeConversationBinding_userId_connectionId_idx" ON "NativeConversationBinding"("userId", "connectionId");
CREATE INDEX "NativeConversationBinding_conversationId_idx" ON "NativeConversationBinding"("conversationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
