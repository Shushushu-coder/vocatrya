-- CreateTable
CREATE TABLE "AutoApplyExtensionPairing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "allowedSections" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutoApplyExtensionPairing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoApplyExtensionConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clientName" TEXT,
    "tokenHash" TEXT NOT NULL,
    "allowedSections" TEXT NOT NULL,
    "pairedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    "lastSyncAt" DATETIME,
    "lastProfileUpdatedAt" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoApplyExtensionConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoApplyExtensionPairing_secretHash_key" ON "AutoApplyExtensionPairing"("secretHash");

-- CreateIndex
CREATE INDEX "AutoApplyExtensionPairing_userId_idx" ON "AutoApplyExtensionPairing"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoApplyExtensionConnection_tokenHash_key" ON "AutoApplyExtensionConnection"("tokenHash");

-- CreateIndex
CREATE INDEX "AutoApplyExtensionConnection_userId_idx" ON "AutoApplyExtensionConnection"("userId");
