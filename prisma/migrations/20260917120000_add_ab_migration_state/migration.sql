-- Vocatrya A+B Phase 5. Additive only: instance-level migration-state marker.
-- No legacy backfill, DROP, or column rewrite.

-- CreateTable
CREATE TABLE "AbMigrationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL DEFAULT 'instance',
    "migrationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "completedAt" DATETIME,
    "verifiedAt" DATETIME,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AbMigrationState_scopeKey_key" ON "AbMigrationState"("scopeKey");
