-- CreateTable
CREATE TABLE "NotionConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "workspaceId" TEXT,
    "workspaceName" TEXT,
    "workspaceIcon" TEXT,
    "notionUserId" TEXT,
    "botId" TEXT,
    "grantedScope" TEXT,
    "oauthClientId" TEXT,
    "availableTools" TEXT,
    "encryptedCredential" TEXT,
    "credentialIv" TEXT,
    "pendingCipher" TEXT,
    "pendingIv" TEXT,
    "pendingStateHash" TEXT,
    "lastVerifiedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "connectedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotionConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NotionConnection_userId_key" ON "NotionConnection"("userId");

-- CreateIndex
CREATE INDEX "NotionConnection_pendingStateHash_idx" ON "NotionConnection"("pendingStateHash");
