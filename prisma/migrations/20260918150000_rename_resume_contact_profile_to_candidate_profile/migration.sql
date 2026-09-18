-- Data-preserving evolution of ResumeContactProfile → CandidateProfile.
-- Do NOT DROP/recreate the profile table: existing rows and original
-- column values must survive. Sensitive tables and education GPA/rank
-- columns are additive.

-- RenameTable
ALTER TABLE "ResumeContactProfile" RENAME TO "CandidateProfile";

-- SQLite keeps the pre-rename unique index name; Prisma's schema expects
-- CandidateProfile_userId_key. Recreate the unique index only — not the table.
DROP INDEX IF EXISTS "ResumeContactProfile_userId_key";
CREATE UNIQUE INDEX "CandidateProfile_userId_key" ON "CandidateProfile"("userId");

-- AlterTable CandidateProfile (additive)
ALTER TABLE "CandidateProfile" ADD COLUMN "gender" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "birthDate" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "ethnicity" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "politicalStatus" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "nativePlace" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "householdRegistration" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "graduationCohort" TEXT;

-- AlterTable CareerEducationDetail (additive)
ALTER TABLE "CareerEducationDetail" ADD COLUMN "gpaValue" REAL;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "gpaScale" REAL;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "rankText" TEXT;

-- CreateTable
CREATE TABLE "CandidateSensitiveInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "idNumber" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactRelation" TEXT,
    "emergencyContactPhone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateSensitiveInfo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateFamilyMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sensitiveInfoId" TEXT NOT NULL,
    "name" TEXT,
    "relation" TEXT,
    "employer" TEXT,
    "position" TEXT,
    "phone" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateFamilyMember_sensitiveInfoId_fkey" FOREIGN KEY ("sensitiveInfoId") REFERENCES "CandidateSensitiveInfo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateSensitiveInfo_userId_key" ON "CandidateSensitiveInfo"("userId");

-- CreateIndex
CREATE INDEX "CandidateFamilyMember_sensitiveInfoId_sortOrder_idx" ON "CandidateFamilyMember"("sensitiveInfoId", "sortOrder");
