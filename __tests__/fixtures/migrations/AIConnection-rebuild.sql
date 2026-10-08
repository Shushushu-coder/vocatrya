PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AIConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'ACCOUNT_LOGIN',
    "backendKind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "accountIdentity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "credentialRef" TEXT,
    "runtimeProfileRef" TEXT,
    "providerMetadata" TEXT,
    "lastVerifiedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "futureNote" TEXT,
    CONSTRAINT "AIConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_AIConnection" ("id", "userId", "provider", "authType", "backendKind", "displayName", "accountIdentity", "status", "credentialRef", "runtimeProfileRef", "providerMetadata", "lastVerifiedAt", "archivedAt", "createdAt", "updatedAt") SELECT "id", "userId", "provider", "authType", "backendKind", "displayName", "accountIdentity", "status", "credentialRef", "runtimeProfileRef", "providerMetadata", "lastVerifiedAt", "archivedAt", "createdAt", "updatedAt" FROM "AIConnection";
DROP TABLE "AIConnection";
ALTER TABLE "new_AIConnection" RENAME TO "AIConnection";
CREATE INDEX "AIConnection_userId_idx" ON "AIConnection"("userId");
CREATE INDEX "AIConnection_userId_provider_idx" ON "AIConnection"("userId", "provider");
CREATE INDEX "AIConnection_userId_archivedAt_idx" ON "AIConnection"("userId", "archivedAt");
CREATE UNIQUE INDEX "AIConnection_userId_active_managed_key"
ON "AIConnection"("userId")
WHERE "provider" = 'VOCATRYA'
  AND "backendKind" = 'MANAGED_GATEWAY'
  AND "authType" = 'MANAGED'
  AND "archivedAt" IS NULL;

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
