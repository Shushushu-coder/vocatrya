-- CreateTable
CREATE TABLE "FeishuConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "appId" TEXT,
    "availableCapabilities" TEXT,
    "encryptedCredential" TEXT,
    "credentialIv" TEXT,
    "lastVerifiedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "connectedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeishuConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FeishuConnection_userId_key" ON "FeishuConnection"("userId");
