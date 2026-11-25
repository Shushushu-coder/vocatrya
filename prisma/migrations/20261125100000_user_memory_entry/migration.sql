ALTER TABLE "ChatConversation" ADD COLUMN "nativeMemoryBlock" TEXT;
CREATE TABLE "UserMemoryEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sourceConversationId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserMemoryEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserMemoryEntry_userId_category_key_key" ON "UserMemoryEntry"("userId", "category", "key");
CREATE INDEX "UserMemoryEntry_userId_updatedAt_idx" ON "UserMemoryEntry"("userId", "updatedAt");
