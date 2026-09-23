-- Phase B ACCOUNT_LOGIN foundation — SAFE handcrafted additive migration.
-- MIGRATION_CLASSIFICATION: ADDITIVE
--
-- Contents:
-- - T1: AIConnection (new table)
-- - T2: AIBusinessAssignment (new table)
-- - L1..L5: nullable resolved-connection lock columns on the five persistent
--   business entities that must be able to pin which AIConnection/model a run
--   resolved to (InterviewSession, MatchAnalysis, JobDescriptionParse,
--   ResumeVariantVersion, AutomationRun).
--
-- Deliberate schema decisions (Phase A corrections, locked):
-- - No SQLite CHECK on provider / backendKind / authType / status / purpose:
--   provider and runtime registries evolve and are validated at the service
--   layer (src/lib/ai/connections.ts); SQLite CHECKs are expensive to change.
-- - No @@unique([userId, provider, accountIdentity]): accountIdentity is a
--   display identity only (not immutable, not provider-wide unique, not
--   organization-independent). Duplicate-account detection is provider-aware
--   service work, not a constraint.
-- - authType default 'ACCOUNT_LOGIN' with 'API_KEY' already permitted by the
--   open String column (no CHECK), matching the confirmed seam.
-- - Every lock column is nullable and every connection FK is
--   ON DELETE RESTRICT: archive-not-delete for connections still referenced
--   by assignments or resolved locks.
--
-- NO_GUESS_BACKFILL guarantee: this file contains no UPDATE and derives no
-- resolvedConnectionId from existing provider/model provenance. All new
-- columns stay NULL on existing rows.
--
-- SQLite note: ALTER TABLE ... ADD COLUMN with a REFERENCES clause is legal
-- for nullable columns (default NULL), keeps every table in place, and is
-- already used by 20260918130000_add_campus_core_fields. No table rebuild,
-- no drop/rename, no data copy anywhere in this file.

-- ---------------------------------------------------------------------------
-- T1: AIConnection (new table).
-- ---------------------------------------------------------------------------
CREATE TABLE "AIConnection" (
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
    CONSTRAINT "AIConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "AIConnection_userId_idx" ON "AIConnection"("userId");
CREATE INDEX "AIConnection_userId_provider_idx" ON "AIConnection"("userId", "provider");
CREATE INDEX "AIConnection_userId_archivedAt_idx" ON "AIConnection"("userId", "archivedAt");

-- ---------------------------------------------------------------------------
-- T2: AIBusinessAssignment (new table). (userId, purpose) unique; connectionId
-- is a required FK (fail-closed — never an optional mapping).
-- ---------------------------------------------------------------------------
CREATE TABLE "AIBusinessAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AIBusinessAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AIBusinessAssignment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AIConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AIBusinessAssignment_userId_purpose_key" ON "AIBusinessAssignment"("userId", "purpose");
CREATE INDEX "AIBusinessAssignment_connectionId_idx" ON "AIBusinessAssignment"("connectionId");

-- ---------------------------------------------------------------------------
-- L1..L5: nullable resolved-connection lock columns (additive, no backfill).
-- MatchAnalysis and JobDescriptionParse already carry a `model` provenance
-- column, so they only gain resolvedConnectionId — no resolvedModel synonym.
-- ---------------------------------------------------------------------------
ALTER TABLE "InterviewSession" ADD COLUMN "resolvedConnectionId" TEXT REFERENCES "AIConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD COLUMN "resolvedModel" TEXT;

ALTER TABLE "MatchAnalysis" ADD COLUMN "resolvedConnectionId" TEXT REFERENCES "AIConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobDescriptionParse" ADD COLUMN "resolvedConnectionId" TEXT REFERENCES "AIConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResumeVariantVersion" ADD COLUMN "resolvedConnectionId" TEXT REFERENCES "AIConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResumeVariantVersion" ADD COLUMN "resolvedModel" TEXT;

ALTER TABLE "AutomationRun" ADD COLUMN "resolvedConnectionId" TEXT REFERENCES "AIConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD COLUMN "resolvedModel" TEXT;
