-- AlterTable
ALTER TABLE "CandidateProfile" ADD COLUMN "countryOrRegion" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "currentCity" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "homeAddress" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "homeCity" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "qqNumber" TEXT;
ALTER TABLE "CandidateProfile" ADD COLUMN "wechatId" TEXT;

-- AlterTable
ALTER TABLE "CandidateSensitiveInfo" ADD COLUMN "idType" TEXT;

-- AlterTable
ALTER TABLE "CareerAwardDetail" ADD COLUMN "awardLevel" TEXT;
ALTER TABLE "CareerAwardDetail" ADD COLUMN "awardScope" TEXT;
ALTER TABLE "CareerAwardDetail" ADD COLUMN "awardType" TEXT;

-- AlterTable
ALTER TABLE "CareerCertificationDetail" ADD COLUMN "credentialId" TEXT;

-- AlterTable
ALTER TABLE "CareerInternshipDetail" ADD COLUMN "department" TEXT;

-- AlterTable
ALTER TABLE "CareerProjectDetail" ADD COLUMN "projectType" TEXT;
ALTER TABLE "CareerProjectDetail" ADD COLUMN "techStack" TEXT;

-- AlterTable
ALTER TABLE "CareerPublicationDetail" ADD COLUMN "authorRole" TEXT;
ALTER TABLE "CareerPublicationDetail" ADD COLUMN "venueLevel" TEXT;

-- CreateTable
CREATE TABLE "CareerLanguageDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "language" TEXT,
    "examOrLevel" TEXT,
    "score" TEXT,
    "obtainedOn" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerLanguageDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateReferee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sensitiveInfoId" TEXT NOT NULL,
    "name" TEXT,
    "organization" TEXT,
    "position" TEXT,
    "relationship" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateReferee_sensitiveInfoId_fkey" FOREIGN KEY ("sensitiveInfoId") REFERENCES "CandidateSensitiveInfo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "materialItemId" TEXT,
    "category" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "storageKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'USER',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CandidateAttachment_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable (additive only; no table rebuild. SQLite stores BOOLEAN as 0/1,
-- so NOT NULL boolean defaults are written as numeric literals.)
ALTER TABLE "CareerEducationDetail" ADD COLUMN "currentStudyLocation" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "department" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "majorCategory" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "studyMode" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "isExchange" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "graduationOn" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "graduationExpected" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "rankClassText" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "rankMajorText" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "hasNationalScholarship" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "advisorName" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "labName" TEXT;
ALTER TABLE "CareerEducationDetail" ADD COLUMN "researchDirection" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CareerLanguageDetail_materialItemId_key" ON "CareerLanguageDetail"("materialItemId");

-- CreateIndex
CREATE INDEX "CandidateReferee_sensitiveInfoId_sortOrder_idx" ON "CandidateReferee"("sensitiveInfoId", "sortOrder");

-- CreateIndex
CREATE INDEX "CandidateAttachment_userId_materialItemId_idx" ON "CandidateAttachment"("userId", "materialItemId");
