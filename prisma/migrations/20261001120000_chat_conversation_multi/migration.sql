-- One user may own many Career Dialogue conversations.
-- Table rebuild is required to drop ChatConversation_userId_key on SQLite.
-- Existing rows are copied verbatim. title and context stay NULL.
-- resolvedConnectionId / resolvedModel are not backfilled.
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "context" TEXT,
    "messages" TEXT NOT NULL,
    "resolvedConnectionId" TEXT,
    "resolvedModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatConversation" ("id", "userId", "messages", "resolvedConnectionId", "resolvedModel", "createdAt", "updatedAt")
SELECT "id", "userId", "messages", "resolvedConnectionId", "resolvedModel", "createdAt", "updatedAt" FROM "ChatConversation";
DROP TABLE "ChatConversation";
ALTER TABLE "new_ChatConversation" RENAME TO "ChatConversation";
CREATE INDEX "ChatConversation_userId_updatedAt_idx" ON "ChatConversation"("userId", "updatedAt");
PRAGMA foreign_key_check("ChatConversation");
PRAGMA foreign_keys=ON;
