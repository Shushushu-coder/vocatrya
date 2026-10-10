-- Durable pre-invocation identity for the canonical resume import (M4).
-- Additive only: no backfill, no guessing at historical import attempts.
-- CreateTable
CREATE TABLE "ResumeImportAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "executionSeq" INTEGER NOT NULL DEFAULT 0,
    "requestSha" TEXT NOT NULL,
    "resolvedConnectionId" TEXT,
    "resolvedModel" TEXT,
    "managedAiProvenance" TEXT,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResumeImportAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ResumeImportAttempt_userId_createdAt_idx" ON "ResumeImportAttempt"("userId", "createdAt");
