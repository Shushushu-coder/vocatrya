-- Vocatrya A+B foundation. Additive only: new tables, optional Company
-- columns, and indexes. No legacy backfill, DROP, or column rewrite.
-- Cross-user relation equality is a service-layer invariant.

-- AlterTable
ALTER TABLE "Company" ADD COLUMN "headquarters" TEXT;
ALTER TABLE "Company" ADD COLUMN "notes" TEXT;
ALTER TABLE "Company" ADD COLUMN "sizeLabel" TEXT;

-- CreateTable
CREATE TABLE "RecruitmentCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "recruitmentType" TEXT,
    "year" INTEGER,
    "season" TEXT,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "careersUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecruitmentCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecruitmentCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobOpportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT,
    "locationText" TEXT,
    "employmentType" TEXT,
    "recruitmentType" TEXT,
    "workplaceType" TEXT,
    "sourceSystem" TEXT,
    "sourceLabel" TEXT,
    "sourceUrl" TEXT,
    "externalSourceKey" TEXT,
    "deadline" DATETIME,
    "salaryText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "currentJdVersionId" TEXT,
    "sourceAutomationId" TEXT,
    "discoveredAt" DATETIME,
    "closedAt" DATETIME,
    "notes" TEXT,
    "archivedAt" DATETIME,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobOpportunity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JobOpportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JobOpportunity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "RecruitmentCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JobOpportunity_currentJdVersionId_fkey" FOREIGN KEY ("currentJdVersionId") REFERENCES "JobDescriptionVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JobOpportunity_sourceAutomationId_fkey" FOREIGN KEY ("sourceAutomationId") REFERENCES "Automation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobOpportunityNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobOpportunityId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobOpportunityNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JobOpportunityNote_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobDescriptionVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobOpportunityId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "rawContent" TEXT NOT NULL,
    "rawContentFormat" TEXT NOT NULL DEFAULT 'PLAIN_TEXT',
    "sourceUrl" TEXT,
    "capturedAt" DATETIME NOT NULL,
    "contentHash" TEXT NOT NULL,
    "currentParseId" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobDescriptionVersion_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JobDescriptionVersion_currentParseId_fkey" FOREIGN KEY ("currentParseId") REFERENCES "JobDescriptionParse" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobDescriptionParse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobDescriptionVersionId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "structuredData" TEXT NOT NULL,
    "parseStatus" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "inputHash" TEXT NOT NULL,
    "errorCode" TEXT,
    "parsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobDescriptionParse_jobDescriptionVersionId_fkey" FOREIGN KEY ("jobDescriptionVersionId") REFERENCES "JobDescriptionVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobOpportunityId" TEXT NOT NULL,
    "channelCategory" TEXT,
    "channelLabel" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "submittedAt" DATETIME,
    "currentStageCategory" TEXT NOT NULL DEFAULT 'DRAFT',
    "outcome" TEXT NOT NULL DEFAULT 'ACTIVE',
    "submittedResumeVersionId" TEXT,
    "submittedResumeArtifactId" TEXT,
    "submittedAgainstJdVersionId" TEXT,
    "notes" TEXT,
    "createdVia" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApplicationAttempt_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApplicationAttempt_submittedResumeVersionId_fkey" FOREIGN KEY ("submittedResumeVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApplicationAttempt_submittedResumeArtifactId_fkey" FOREIGN KEY ("submittedResumeArtifactId") REFERENCES "ResumeArtifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApplicationAttempt_submittedAgainstJdVersionId_fkey" FOREIGN KEY ("submittedAgainstJdVersionId") REFERENCES "JobDescriptionVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationProcessStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationAttemptId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sortOrder" INTEGER NOT NULL,
    "scheduledAt" DATETIME,
    "completedAt" DATETIME,
    "result" TEXT,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationProcessStep_applicationAttemptId_fkey" FOREIGN KEY ("applicationAttemptId") REFERENCES "ApplicationAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationInterviewDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationProcessStepId" TEXT NOT NULL,
    "interviewFormat" TEXT,
    "roundLabel" TEXT,
    "locationText" TEXT,
    "interviewerNames" TEXT,
    "durationMinutes" INTEGER,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationInterviewDetail_applicationProcessStepId_fkey" FOREIGN KEY ("applicationProcessStepId") REFERENCES "ApplicationProcessStep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationAssessmentDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationProcessStepId" TEXT NOT NULL,
    "assessmentKind" TEXT,
    "platform" TEXT,
    "durationMinutes" INTEGER,
    "scoreText" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationAssessmentDetail_applicationProcessStepId_fkey" FOREIGN KEY ("applicationProcessStepId") REFERENCES "ApplicationProcessStep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationOfferDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationProcessStepId" TEXT NOT NULL,
    "offerType" TEXT,
    "compensationText" TEXT,
    "responseDeadline" DATETIME,
    "decision" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationOfferDetail_applicationProcessStepId_fkey" FOREIGN KEY ("applicationProcessStepId") REFERENCES "ApplicationProcessStep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobSearchPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "targetRoles" TEXT,
    "preferredCities" TEXT,
    "preferredIndustries" TEXT,
    "recruitmentTypes" TEXT,
    "availability" TEXT,
    "hardConstraints" TEXT,
    "softPreferences" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobSearchPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerMaterialItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'USER',
    "verificationStatus" TEXT NOT NULL DEFAULT 'USER_AUTHORED',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerMaterialItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerInternshipDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "companyId" TEXT,
    "organizationName" TEXT,
    "roleTitle" TEXT,
    "locationText" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerInternshipDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CareerInternshipDetail_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerEmploymentDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "companyId" TEXT,
    "organizationName" TEXT,
    "roleTitle" TEXT,
    "employmentType" TEXT,
    "locationText" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerEmploymentDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CareerEmploymentDetail_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerProjectDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "roleTitle" TEXT,
    "projectUrl" TEXT,
    "organizationName" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerProjectDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerResearchDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "institution" TEXT,
    "roleTitle" TEXT,
    "field" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerResearchDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerPublicationDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "venue" TEXT,
    "authors" TEXT,
    "url" TEXT,
    "publishedAt" DATETIME,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerPublicationDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerCompetitionDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "organizer" TEXT,
    "awardLevel" TEXT,
    "result" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerCompetitionDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerCampusActivityDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "organizationName" TEXT,
    "roleTitle" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerCampusActivityDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerEducationDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "institution" TEXT,
    "degree" TEXT,
    "fieldOfStudy" TEXT,
    "locationText" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerEducationDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerAwardDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "issuer" TEXT,
    "awardedAt" DATETIME,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerAwardDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerSkillDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "skillName" TEXT,
    "proficiency" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerSkillDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerCertificationDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "organization" TEXT,
    "credentialUrl" TEXT,
    "issueDate" DATETIME,
    "expirationDate" DATETIME,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerCertificationDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerCustomDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerCustomDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CareerEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metricValue" REAL,
    "metricUnit" TEXT,
    "metricText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'USER',
    "verificationStatus" TEXT NOT NULL DEFAULT 'USER_AUTHORED',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerEvidence_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeContactProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "headline" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "linksData" TEXT,
    "extraData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResumeContactProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetJobOpportunityId" TEXT,
    "currentVersionId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResumeVariant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariant_targetJobOpportunityId_fkey" FOREIGN KEY ("targetJobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariant_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeVariantVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeVariantId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "parentVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "targetJdVersionId" TEXT,
    "sourceMatchAnalysisId" TEXT,
    "locale" TEXT,
    "headerSnapshot" TEXT,
    "layoutConfig" TEXT,
    "createdVia" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenAt" DATETIME,
    CONSTRAINT "ResumeVariantVersion_resumeVariantId_fkey" FOREIGN KEY ("resumeVariantId") REFERENCES "ResumeVariant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariantVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariantVersion_targetJdVersionId_fkey" FOREIGN KEY ("targetJdVersionId") REFERENCES "JobDescriptionVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariantVersion_sourceMatchAnalysisId_fkey" FOREIGN KEY ("sourceMatchAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeVariantSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeVariantVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "systemKind" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ResumeVariantSection_resumeVariantVersionId_fkey" FOREIGN KEY ("resumeVariantVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeVariantSectionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeVariantSectionId" TEXT NOT NULL,
    "careerMaterialItemId" TEXT,
    "itemKind" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ResumeVariantSectionItem_resumeVariantSectionId_fkey" FOREIGN KEY ("resumeVariantSectionId") REFERENCES "ResumeVariantSection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResumeVariantSectionItem_careerMaterialItemId_fkey" FOREIGN KEY ("careerMaterialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeExpression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeVariantSectionItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "evidenceStatus" TEXT NOT NULL DEFAULT 'UNLINKED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResumeExpression_resumeVariantSectionItemId_fkey" FOREIGN KEY ("resumeVariantSectionItemId") REFERENCES "ResumeVariantSectionItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeExpressionEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeExpressionId" TEXT NOT NULL,
    "careerEvidenceId" TEXT NOT NULL,
    "evidenceContentSnapshot" TEXT NOT NULL,
    "evidenceHashSnapshot" TEXT NOT NULL,
    "evidenceUpdatedAtSnapshot" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeExpressionEvidence_resumeExpressionId_fkey" FOREIGN KEY ("resumeExpressionId") REFERENCES "ResumeExpression" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResumeExpressionEvidence_careerEvidenceId_fkey" FOREIGN KEY ("careerEvidenceId") REFERENCES "CareerEvidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeVariantVersionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeArtifact_resumeVariantVersionId_fkey" FOREIGN KEY ("resumeVariantVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MatchAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobOpportunityId" TEXT NOT NULL,
    "jobDescriptionParseId" TEXT NOT NULL,
    "analysisType" TEXT NOT NULL,
    "resumeVariantVersionId" TEXT,
    "inputHash" TEXT NOT NULL,
    "analysisSchemaVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "staleReasonCodes" TEXT,
    "staleAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "MatchAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MatchAnalysis_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MatchAnalysis_jobDescriptionParseId_fkey" FOREIGN KEY ("jobDescriptionParseId") REFERENCES "JobDescriptionParse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MatchAnalysis_resumeVariantVersionId_fkey" FOREIGN KEY ("resumeVariantVersionId") REFERENCES "ResumeVariantVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FastScreeningDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchAnalysisId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL,
    "hardRequirements" TEXT,
    "coreMatch" TEXT,
    "preferenceMatch" TEXT,
    "reasons" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FastScreeningDetail_matchAnalysisId_fkey" FOREIGN KEY ("matchAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeepMatchDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchAnalysisId" TEXT NOT NULL,
    "overallSummary" TEXT NOT NULL,
    "overallScore" INTEGER,
    "hardRequirements" TEXT,
    "responsibilityAlignment" TEXT,
    "experienceRelevance" TEXT,
    "skillCoverage" TEXT,
    "educationExperienceFit" TEXT,
    "strengths" TEXT,
    "gaps" TEXT,
    "resumeOptimizationOpportunities" TEXT,
    "nonFixableGaps" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeepMatchDetail_matchAnalysisId_fkey" FOREIGN KEY ("matchAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MatchEvidenceLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchAnalysisId" TEXT NOT NULL,
    "requirementKey" TEXT NOT NULL,
    "requirementTextSnapshot" TEXT NOT NULL,
    "careerEvidenceId" TEXT,
    "resumeExpressionId" TEXT,
    "judgement" TEXT NOT NULL,
    "evidenceContentSnapshot" TEXT,
    "evidenceHashSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchEvidenceLink_matchAnalysisId_fkey" FOREIGN KEY ("matchAnalysisId") REFERENCES "MatchAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchEvidenceLink_careerEvidenceId_fkey" FOREIGN KEY ("careerEvidenceId") REFERENCES "CareerEvidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MatchEvidenceLink_resumeExpressionId_fkey" FOREIGN KEY ("resumeExpressionId") REFERENCES "ResumeExpression" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LegacyMigrationMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "legacyEntityType" TEXT NOT NULL,
    "legacyEntityId" TEXT NOT NULL,
    "targetEntityType" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "migrationVersion" TEXT NOT NULL,
    "mappingReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegacyMigrationMap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataMigrationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "counts" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "DataMigrationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RecruitmentCampaign_userId_archivedAt_idx" ON "RecruitmentCampaign"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "RecruitmentCampaign_companyId_year_idx" ON "RecruitmentCampaign"("companyId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "JobOpportunity_currentJdVersionId_key" ON "JobOpportunity"("currentJdVersionId");

-- CreateIndex
CREATE INDEX "JobOpportunity_userId_status_idx" ON "JobOpportunity"("userId", "status");

-- CreateIndex
CREATE INDEX "JobOpportunity_userId_deadline_idx" ON "JobOpportunity"("userId", "deadline");

-- CreateIndex
CREATE INDEX "JobOpportunity_companyId_campaignId_idx" ON "JobOpportunity"("companyId", "campaignId");

-- CreateIndex
CREATE INDEX "JobOpportunity_companyId_normalizedTitle_idx" ON "JobOpportunity"("companyId", "normalizedTitle");

-- CreateIndex
CREATE INDEX "JobOpportunityNote_jobOpportunityId_idx" ON "JobOpportunityNote"("jobOpportunityId");

-- CreateIndex
CREATE INDEX "JobOpportunityNote_userId_idx" ON "JobOpportunityNote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "JobDescriptionVersion_currentParseId_key" ON "JobDescriptionVersion"("currentParseId");

-- CreateIndex
CREATE UNIQUE INDEX "JobDescriptionVersion_jobOpportunityId_versionNumber_key" ON "JobDescriptionVersion"("jobOpportunityId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JobDescriptionVersion_jobOpportunityId_contentHash_key" ON "JobDescriptionVersion"("jobOpportunityId", "contentHash");

-- CreateIndex
CREATE INDEX "JobDescriptionParse_jobDescriptionVersionId_idx" ON "JobDescriptionParse"("jobDescriptionVersionId");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_userId_currentStageCategory_idx" ON "ApplicationAttempt"("userId", "currentStageCategory");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_userId_outcome_idx" ON "ApplicationAttempt"("userId", "outcome");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_jobOpportunityId_createdAt_idx" ON "ApplicationAttempt"("jobOpportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationProcessStep_applicationAttemptId_sortOrder_idx" ON "ApplicationProcessStep"("applicationAttemptId", "sortOrder");

-- CreateIndex
CREATE INDEX "ApplicationProcessStep_scheduledAt_idx" ON "ApplicationProcessStep"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationInterviewDetail_applicationProcessStepId_key" ON "ApplicationInterviewDetail"("applicationProcessStepId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAssessmentDetail_applicationProcessStepId_key" ON "ApplicationAssessmentDetail"("applicationProcessStepId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationOfferDetail_applicationProcessStepId_key" ON "ApplicationOfferDetail"("applicationProcessStepId");

-- CreateIndex
CREATE UNIQUE INDEX "JobSearchPreference_userId_key" ON "JobSearchPreference"("userId");

-- CreateIndex
CREATE INDEX "CareerMaterialItem_userId_type_archivedAt_idx" ON "CareerMaterialItem"("userId", "type", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CareerInternshipDetail_materialItemId_key" ON "CareerInternshipDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerEmploymentDetail_materialItemId_key" ON "CareerEmploymentDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerProjectDetail_materialItemId_key" ON "CareerProjectDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerResearchDetail_materialItemId_key" ON "CareerResearchDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerPublicationDetail_materialItemId_key" ON "CareerPublicationDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerCompetitionDetail_materialItemId_key" ON "CareerCompetitionDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerCampusActivityDetail_materialItemId_key" ON "CareerCampusActivityDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerEducationDetail_materialItemId_key" ON "CareerEducationDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerAwardDetail_materialItemId_key" ON "CareerAwardDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerSkillDetail_materialItemId_key" ON "CareerSkillDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerCertificationDetail_materialItemId_key" ON "CareerCertificationDetail"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerCustomDetail_materialItemId_key" ON "CareerCustomDetail"("materialItemId");

-- CreateIndex
CREATE INDEX "CareerEvidence_materialItemId_kind_idx" ON "CareerEvidence"("materialItemId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeContactProfile_userId_key" ON "ResumeContactProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeVariant_currentVersionId_key" ON "ResumeVariant"("currentVersionId");

-- CreateIndex
CREATE INDEX "ResumeVariant_userId_archivedAt_idx" ON "ResumeVariant"("userId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeVariantVersion_resumeVariantId_versionNumber_key" ON "ResumeVariantVersion"("resumeVariantId", "versionNumber");

-- CreateIndex
CREATE INDEX "ResumeVariantSection_resumeVariantVersionId_sortOrder_idx" ON "ResumeVariantSection"("resumeVariantVersionId", "sortOrder");

-- CreateIndex
CREATE INDEX "ResumeVariantSectionItem_resumeVariantSectionId_sortOrder_idx" ON "ResumeVariantSectionItem"("resumeVariantSectionId", "sortOrder");

-- CreateIndex
CREATE INDEX "ResumeExpression_resumeVariantSectionItemId_sortOrder_idx" ON "ResumeExpression"("resumeVariantSectionItemId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeExpressionEvidence_resumeExpressionId_careerEvidenceId_key" ON "ResumeExpressionEvidence"("resumeExpressionId", "careerEvidenceId");

-- CreateIndex
CREATE INDEX "ResumeArtifact_resumeVariantVersionId_idx" ON "ResumeArtifact"("resumeVariantVersionId");

-- CreateIndex
CREATE INDEX "MatchAnalysis_jobOpportunityId_analysisType_isStale_idx" ON "MatchAnalysis"("jobOpportunityId", "analysisType", "isStale");

-- CreateIndex
CREATE INDEX "MatchAnalysis_userId_analysisType_isStale_idx" ON "MatchAnalysis"("userId", "analysisType", "isStale");

-- CreateIndex
CREATE INDEX "MatchAnalysis_resumeVariantVersionId_idx" ON "MatchAnalysis"("resumeVariantVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "FastScreeningDetail_matchAnalysisId_key" ON "FastScreeningDetail"("matchAnalysisId");

-- CreateIndex
CREATE UNIQUE INDEX "DeepMatchDetail_matchAnalysisId_key" ON "DeepMatchDetail"("matchAnalysisId");

-- CreateIndex
CREATE INDEX "MatchEvidenceLink_matchAnalysisId_idx" ON "MatchEvidenceLink"("matchAnalysisId");

-- CreateIndex
CREATE INDEX "LegacyMigrationMap_targetEntityType_targetEntityId_idx" ON "LegacyMigrationMap"("targetEntityType", "targetEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyMigrationMap_userId_legacyEntityType_legacyEntityId_targetEntityType_targetEntityId_key" ON "LegacyMigrationMap"("userId", "legacyEntityType", "legacyEntityId", "targetEntityType", "targetEntityId");

-- CreateIndex
CREATE INDEX "DataMigrationRun_userId_startedAt_idx" ON "DataMigrationRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "DataMigrationRun_status_idx" ON "DataMigrationRun"("status");
