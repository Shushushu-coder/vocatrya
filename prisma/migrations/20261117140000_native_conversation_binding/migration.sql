ALTER TABLE "ChatConversation" ADD COLUMN "executionPath" TEXT NOT NULL DEFAULT 'APP_ORCHESTRATED';
ALTER TABLE "ChatConversation" ADD COLUMN "nativeInitializationState" TEXT NOT NULL DEFAULT 'NEVER_ATTEMPTED';
CREATE TABLE "NativeConversationBinding" (
  "conversationId" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "runtimeVersion" TEXT NOT NULL,
  "runtimeProfileRef" TEXT NOT NULL,
  "configHash" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "promptHash" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "NativeConversationBinding_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NativeConversationBinding_userId_connectionId_idx" ON "NativeConversationBinding"("userId", "connectionId");
