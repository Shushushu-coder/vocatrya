-- REM-V1 additive table only. targetId is polymorphic (sourceType selects
-- the referenced table), so it is intentionally not a declared foreign key.
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "anchorAt" DATETIME NOT NULL,
    "fireAt" DATETIME NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "deepLink" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "firedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Natural key: one schedule record per (user, source, target).
CREATE UNIQUE INDEX "Reminder_userId_sourceType_targetId_key" ON "Reminder"("userId", "sourceType", "targetId");

-- Claim path: pending rows due for a user, ordered by fireAt.
CREATE INDEX "Reminder_userId_status_fireAt_idx" ON "Reminder"("userId", "status", "fireAt");
