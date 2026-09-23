// @vitest-environment node
import fs from "fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { BackupDataSchema } from "@/lib/backup/schema";
import {
  copyFoundationMigrationInto,
  copyMigrationBySuffix,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
  PROCESS_STEP_DEADLINE_MIGRATION,
  CAMPUS_CORE_FIELDS_MIGRATION,
  INTERVIEW_REFLECTION_MIGRATION,
  CANDIDATE_PROFILE_MIGRATION,
  PHASE3A_INTERVIEW_MIGRATION,
  ACCOUNT_LOGIN_FOUNDATION_MIGRATION,
} from "./helpers/abSchemaTestDb";

const LEGACY_TABLES = [
  "User",
  "Profile",
  "Resume",
  "ResumeSection",
  "ContactInfo",
  "WorkExperience",
  "Education",
  "LicenseOrCertification",
  "OtherSection",
  "Skill",
  "Tag",
  "Job",
  "Company",
  "JobStatus",
  "JobTitle",
  "Location",
  "JobSource",
  "Note",
  "Interview",
  "Automation",
  "AutomationRun",
] as const;

const NEW_TABLES = [
  "RecruitmentCampaign",
  "JobOpportunity",
  "JobDescriptionVersion",
  "JobDescriptionParse",
  "JobOpportunityNote",
  "ApplicationAttempt",
  "ApplicationProcessStep",
  "ApplicationInterviewDetail",
  "ApplicationInterviewReflectionItem",
  "ApplicationAssessmentDetail",
  "ApplicationOfferDetail",
  "JobSearchPreference",
  "CareerMaterialItem",
  "CareerInternshipDetail",
  "CareerEmploymentDetail",
  "CareerProjectDetail",
  "CareerResearchDetail",
  "CareerPublicationDetail",
  "CareerCompetitionDetail",
  "CareerCampusActivityDetail",
  "CareerEducationDetail",
  "CareerAwardDetail",
  "CareerSkillDetail",
  "CareerCertificationDetail",
  "CareerCustomDetail",
  "CareerEvidence",
  "CandidateProfile",
  "CandidateSensitiveInfo",
  "CandidateFamilyMember",
  "ResumeVariant",
  "ResumeVariantVersion",
  "ResumeVariantSection",
  "ResumeVariantSectionItem",
  "ResumeExpression",
  "ResumeExpressionEvidence",
  "ResumeArtifact",
  "MatchAnalysis",
  "FastScreeningDetail",
  "DeepMatchDetail",
  "MatchEvidenceLink",
  "LegacyMigrationMap",
  "DataMigrationRun",
  "AbMigrationState",
] as const;

async function tableNames(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
}

async function foreignKeyCheck(prisma: PrismaClient): Promise<unknown[]> {
  return prisma.$queryRaw`PRAGMA foreign_key_check;`;
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2003" || error.code === "P2014")
  );
}

describe("Vocatrya A+B phase 1 schema", () => {
  describe("fresh database", () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir);
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

    afterAll(async () => {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    it("applies the full migration chain on an empty database", async () => {
      migrateDeploy(ctx.url, schemaPath);
      const names = await tableNames(prisma);
      for (const table of LEGACY_TABLES) {
        expect(names.has(table), `missing legacy table ${table}`).toBe(true);
      }
      for (const table of NEW_TABLES) {
        expect(names.has(table), `missing new table ${table}`).toBe(true);
      }
      expect(names.has("UserCompany")).toBe(false);
      expect(names.has("CanonicalCompany")).toBe(false);
      expect(await foreignKeyCheck(prisma)).toEqual([]);
    }, 120_000);

    it("preserves Company A+B columns in the backup schema", () => {
      const parsed = BackupDataSchema.parse({
        Company: [
          {
            id: "c1",
            label: "Acme",
            value: "acme",
            logoUrl: null,
            watched: true,
            watchedAt: null,
            atsProvider: null,
            atsToken: null,
            atsHost: null,
            websiteUrl: null,
            careersUrl: null,
            industry: null,
            notes: "optional A+B field",
            sizeLabel: "L",
            headquarters: "Beijing",
          },
        ],
      });
      expect(parsed.Company[0]).toMatchObject({
        notes: "optional A+B field",
        sizeLabel: "L",
        headquarters: "Beijing",
      });
    });

    it("keeps prisma.job / prisma.resume / prisma.company delegates", async () => {
      expect(typeof prisma.job.create).toBe("function");
      expect(typeof prisma.resume.create).toBe("function");
      expect(typeof prisma.company.create).toBe("function");
      expect(typeof prisma.jobOpportunity.create).toBe("function");
      expect(typeof prisma.applicationAttempt.create).toBe("function");
      expect(typeof prisma.careerMaterialItem.create).toBe("function");
      expect(typeof prisma.resumeVariant.create).toBe("function");
      expect(typeof prisma.matchAnalysis.create).toBe("function");
    });
  });

  describe("existing legacy-like database", () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeFoundation: true,
      excludeSuffix: [
        PROCESS_STEP_DEADLINE_MIGRATION,
        CAMPUS_CORE_FIELDS_MIGRATION,
        INTERVIEW_REFLECTION_MIGRATION,
        CANDIDATE_PROFILE_MIGRATION,
        // Phase 3A Interview migration needs the A+B foundation tables
        // (JobDescriptionVersion composite unique), so it joins the
        // upgrade wave instead of the legacy base.
        PHASE3A_INTERVIEW_MIGRATION,
        // Phase B ALTERs InterviewSession/MatchAnalysis/JobDescriptionParse/
        // ResumeVariantVersion — all created in the waves above — so it is
        // the last migration of the upgrade wave, not the legacy base.
        ACCOUNT_LOGIN_FOUNDATION_MIGRATION,
      ],
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

    afterAll(async () => {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    it("leaves legacy Job / Resume / Company rows unchanged", async () => {
      migrateDeploy(ctx.url, schemaPath);

      const user = await prisma.user.create({
        data: {
          name: "Legacy User",
          email: "legacy-ab@example.com",
          password: "x",
        },
      });
      // Insert through SQL so the generated client cannot mention A+B columns
      // that do not exist until the foundation migration runs.
      const companyId = "legacy-company-1";
      await prisma.$executeRaw`
        INSERT INTO "Company" ("id", "label", "value", "createdBy", "watched", "websiteUrl")
        VALUES (${companyId}, ${"Acme"}, ${"acme"}, ${user.id}, ${1}, ${"https://acme.example.com"})
      `;
      const company = { id: companyId, label: "Acme", createdBy: user.id };
      const title = await prisma.jobTitle.create({
        data: { label: "Engineer", value: "engineer", createdBy: user.id },
      });
      const status = await prisma.jobStatus.create({
        data: { label: "Applied", value: "applied-ab-phase1" },
      });
      const profile = await prisma.profile.create({ data: { userId: user.id } });
      const resume = await prisma.resume.create({
        data: { profileId: profile.id, title: "Legacy Resume" },
      });
      const job = await prisma.job.create({
        data: {
          userId: user.id,
          description: "Build widgets. Do not mutate this text.",
          jobType: "FT",
          createdAt: new Date("2026-01-15T00:00:00.000Z"),
          applied: true,
          appliedDate: new Date("2026-01-16T00:00:00.000Z"),
          dueDate: new Date("2026-02-01T00:00:00.000Z"),
          statusId: status.id,
          jobTitleId: title.id,
          companyId: company.id,
          resumeId: resume.id,
        },
      });

      const beforeCompany = await prisma.$queryRaw<
        Array<{
          id: string;
          label: string;
          value: string;
          createdBy: string;
          websiteUrl: string | null;
        }>
      >`SELECT "id", "label", "value", "createdBy", "websiteUrl" FROM "Company" WHERE "id" = ${company.id}`;
      const before = {
        jobs: await prisma.job.count(),
        resumes: await prisma.resume.count(),
        companies: await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*) as n FROM "Company"`,
        jobRow: await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
        resumeRow: await prisma.resume.findUniqueOrThrow({
          where: { id: resume.id },
        }),
        companyRow: beforeCompany[0],
      };

      copyFoundationMigrationInto(ctx.dir);
      copyMigrationBySuffix(ctx.dir, PROCESS_STEP_DEADLINE_MIGRATION);
      copyMigrationBySuffix(ctx.dir, CAMPUS_CORE_FIELDS_MIGRATION);
      copyMigrationBySuffix(ctx.dir, INTERVIEW_REFLECTION_MIGRATION);
      copyMigrationBySuffix(ctx.dir, CANDIDATE_PROFILE_MIGRATION);
      // Timestamp-ordered after the foundation, so it applies last.
      copyMigrationBySuffix(ctx.dir, PHASE3A_INTERVIEW_MIGRATION);
      copyMigrationBySuffix(ctx.dir, ACCOUNT_LOGIN_FOUNDATION_MIGRATION);
      migrateDeploy(ctx.url, schemaPath);

      expect(await prisma.job.count()).toBe(before.jobs);
      expect(await prisma.resume.count()).toBe(before.resumes);
      expect(await prisma.company.count()).toBe(Number(before.companies[0].n));

      const jobAfter = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      const resumeAfter = await prisma.resume.findUniqueOrThrow({
        where: { id: resume.id },
      });
      const companyAfter = await prisma.company.findUniqueOrThrow({
        where: { id: company.id },
      });

      expect(jobAfter.description).toBe(before.jobRow.description);
      expect(jobAfter.resumeId).toBe(resume.id);
      expect(jobAfter.applied).toBe(true);
      expect(resumeAfter.title).toBe(before.resumeRow.title);
      expect(companyAfter.label).toBe(before.companyRow.label);
      expect(companyAfter.createdBy).toBe(user.id);
      expect(companyAfter.notes).toBeNull();
      expect(companyAfter.sizeLabel).toBeNull();
      expect(companyAfter.headquarters).toBeNull();
      expect(await prisma.legacyMigrationMap.count()).toBe(0);
      expect(await prisma.jobOpportunity.count()).toBe(0);
      expect(await foreignKeyCheck(prisma)).toEqual([]);
    }, 120_000);
  });

  describe("relations, uniques, and cascade boundaries", () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir);
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    let userId: string;
    let companyId: string;

    beforeAll(async () => {
      migrateDeploy(ctx.url, schemaPath);
      const user = await prisma.user.create({
        data: { name: "AB User", email: "ab-schema@example.com", password: "x" },
      });
      const company = await prisma.company.create({
        data: { label: "Beta", value: "beta", createdBy: user.id },
      });
      userId = user.id;
      companyId = company.id;
    }, 120_000);

    afterAll(async () => {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    it("wires Campaign / Opportunity / Attempt / JD version / parse", async () => {
      const campaign = await prisma.recruitmentCampaign.create({
        data: { userId, companyId, name: "2027 Campus" },
      });
      const opportunity = await prisma.jobOpportunity.create({
        data: {
          userId,
          companyId,
          campaignId: campaign.id,
          title: "Backend Engineer",
          normalizedTitle: "backend engineer",
          status: "ACTIVE",
        },
      });
      const withoutCampaign = await prisma.jobOpportunity.create({
        data: {
          userId,
          companyId,
          title: "Unattached Role",
          status: "UNKNOWN",
        },
      });
      expect(withoutCampaign.campaignId).toBeNull();

      const version = await prisma.jobDescriptionVersion.create({
        data: {
          jobOpportunityId: opportunity.id,
          versionNumber: 1,
          rawContent: "Need SQL.",
          capturedAt: new Date(),
          contentHash: "hash-v1",
        },
      });
      const parse = await prisma.jobDescriptionParse.create({
        data: {
          jobDescriptionVersionId: version.id,
          schemaVersion: "1",
          parserVersion: "test",
          structuredData: '{"requirements":[]}',
          parseStatus: "SUCCEEDED",
          inputHash: "parse-hash",
        },
      });
      const attempt = await prisma.applicationAttempt.create({
        data: {
          userId,
          jobOpportunityId: opportunity.id,
          channelLabel: "Legacy / unspecified",
          submittedAgainstJdVersionId: version.id,
        },
      });

      expect(attempt.submittedResumeVersionId).toBeNull();
      expect(attempt.submittedResumeArtifactId).toBeNull();
      expect(parse.jobDescriptionVersionId).toBe(version.id);

      await expect(
        prisma.jobOpportunity.delete({ where: { id: opportunity.id } }),
      ).rejects.toSatisfy(isConstraintError);
    });

    it("enforces JD versionNumber and contentHash uniqueness", async () => {
      const opportunity = await prisma.jobOpportunity.create({
        data: { userId, companyId, title: "Unique JD Target" },
      });
      await prisma.jobDescriptionVersion.create({
        data: {
          jobOpportunityId: opportunity.id,
          versionNumber: 1,
          rawContent: "A",
          capturedAt: new Date(),
          contentHash: "same-hash",
        },
      });
      await expect(
        prisma.jobDescriptionVersion.create({
          data: {
            jobOpportunityId: opportunity.id,
            versionNumber: 1,
            rawContent: "B",
            capturedAt: new Date(),
            contentHash: "other-hash",
          },
        }),
      ).rejects.toSatisfy(isConstraintError);
      await expect(
        prisma.jobDescriptionVersion.create({
          data: {
            jobOpportunityId: opportunity.id,
            versionNumber: 2,
            rawContent: "A",
            capturedAt: new Date(),
            contentHash: "same-hash",
          },
        }),
      ).rejects.toSatisfy(isConstraintError);
    });

    it("cascades type details but restricts CareerEvidence provenance", async () => {
      const item = await prisma.careerMaterialItem.create({
        data: { userId, type: "INTERNSHIP", title: "Acme intern" },
      });
      const detail = await prisma.careerInternshipDetail.create({
        data: { materialItemId: item.id, roleTitle: "Intern" },
      });
      await prisma.careerMaterialItem.delete({ where: { id: item.id } });
      expect(
        await prisma.careerInternshipDetail.findUnique({
          where: { id: detail.id },
        }),
      ).toBeNull();

      const kept = await prisma.careerMaterialItem.create({
        data: { userId, type: "PROJECT", title: "Kept project" },
      });
      await prisma.careerProjectDetail.create({
        data: { materialItemId: kept.id },
      });
      const evidence = await prisma.careerEvidence.create({
        data: {
          materialItemId: kept.id,
          kind: "ACHIEVEMENT",
          content: "Shipped v1",
        },
      });
      await expect(
        prisma.careerMaterialItem.delete({ where: { id: kept.id } }),
      ).rejects.toSatisfy(isConstraintError);
      expect(
        await prisma.careerEvidence.findUnique({ where: { id: evidence.id } }),
      ).not.toBeNull();
    });

    it("builds the resume variant hierarchy and snapshots evidence", async () => {
      const variant = await prisma.resumeVariant.create({
        data: { userId, name: "General" },
      });
      const version = await prisma.resumeVariantVersion.create({
        data: {
          resumeVariantId: variant.id,
          versionNumber: 1,
          status: "DRAFT",
          headerSnapshot: '{"fullName":"A B"}',
        },
      });
      await expect(
        prisma.resumeVariantVersion.create({
          data: { resumeVariantId: variant.id, versionNumber: 1 },
        }),
      ).rejects.toSatisfy(isConstraintError);

      const section = await prisma.resumeVariantSection.create({
        data: {
          resumeVariantVersionId: version.id,
          title: "Experience",
          sortOrder: 0,
        },
      });
      const sectionItem = await prisma.resumeVariantSectionItem.create({
        data: {
          resumeVariantSectionId: section.id,
          itemKind: "CUSTOM",
          sortOrder: 0,
        },
      });
      const expression = await prisma.resumeExpression.create({
        data: {
          resumeVariantSectionItemId: sectionItem.id,
          kind: "BULLET",
          content: "Did a thing",
        },
      });
      const material = await prisma.careerMaterialItem.create({
        data: { userId, type: "CUSTOM", title: "Fact" },
      });
      await prisma.careerCustomDetail.create({
        data: { materialItemId: material.id },
      });
      const evidence = await prisma.careerEvidence.create({
        data: {
          materialItemId: material.id,
          kind: "ACTION",
          content: "Did a thing",
        },
      });
      await prisma.resumeExpressionEvidence.create({
        data: {
          resumeExpressionId: expression.id,
          careerEvidenceId: evidence.id,
          evidenceContentSnapshot: "Did a thing",
          evidenceHashSnapshot: "abc",
          evidenceUpdatedAtSnapshot: evidence.updatedAt,
        },
      });

      await prisma.resumeVariantVersion.delete({ where: { id: version.id } });
      expect(
        await prisma.resumeExpression.findUnique({
          where: { id: expression.id },
        }),
      ).toBeNull();
      expect(
        await prisma.careerEvidence.findUnique({ where: { id: evidence.id } }),
      ).not.toBeNull();
    });

    it("cascades match details and restricts evidence links", async () => {
      const opportunity = await prisma.jobOpportunity.create({
        data: { userId, companyId, title: "Match target" },
      });
      const jd = await prisma.jobDescriptionVersion.create({
        data: {
          jobOpportunityId: opportunity.id,
          versionNumber: 1,
          rawContent: "SQL",
          capturedAt: new Date(),
          contentHash: "match-hash",
        },
      });
      const parse = await prisma.jobDescriptionParse.create({
        data: {
          jobDescriptionVersionId: jd.id,
          schemaVersion: "1",
          parserVersion: "test",
          structuredData: "{}",
          parseStatus: "SUCCEEDED",
          inputHash: "in",
        },
      });
      const analysis = await prisma.matchAnalysis.create({
        data: {
          userId,
          jobOpportunityId: opportunity.id,
          jobDescriptionParseId: parse.id,
          analysisType: "FAST_SCREENING",
          inputHash: "fast",
          analysisSchemaVersion: "1",
          status: "SUCCEEDED",
        },
      });
      const detail = await prisma.fastScreeningDetail.create({
        data: {
          matchAnalysisId: analysis.id,
          verdict: "PASS",
          inputSnapshot: "{}",
        },
      });
      const material = await prisma.careerMaterialItem.create({
        data: { userId, type: "SKILL", title: "SQL" },
      });
      await prisma.careerSkillDetail.create({
        data: { materialItemId: material.id, skillName: "SQL" },
      });
      const evidence = await prisma.careerEvidence.create({
        data: {
          materialItemId: material.id,
          kind: "SKILL_USAGE",
          content: "Used SQL",
        },
      });
      await prisma.matchEvidenceLink.create({
        data: {
          matchAnalysisId: analysis.id,
          requirementKey: "REQ-001",
          requirementTextSnapshot: "SQL",
          careerEvidenceId: evidence.id,
          judgement: "MATCHED",
          evidenceContentSnapshot: "Used SQL",
          evidenceHashSnapshot: "h",
        },
      });

      await expect(
        prisma.careerEvidence.delete({ where: { id: evidence.id } }),
      ).rejects.toSatisfy(isConstraintError);

      await prisma.matchAnalysis.delete({ where: { id: analysis.id } });
      expect(
        await prisma.fastScreeningDetail.findUnique({
          where: { id: detail.id },
        }),
      ).toBeNull();
      expect(
        await prisma.careerEvidence.findUnique({ where: { id: evidence.id } }),
      ).not.toBeNull();
    });

    it("enforces one-to-one process-step details", async () => {
      const opportunity = await prisma.jobOpportunity.create({
        data: { userId, companyId, title: "Step target" },
      });
      const attempt = await prisma.applicationAttempt.create({
        data: {
          userId,
          jobOpportunityId: opportunity.id,
          channelLabel: "Email",
        },
      });
      const step = await prisma.applicationProcessStep.create({
        data: {
          applicationAttemptId: attempt.id,
          category: "INTERVIEW",
          label: "HR面",
          sortOrder: 1,
        },
      });
      await prisma.applicationInterviewDetail.create({
        data: { applicationProcessStepId: step.id, interviewFormat: "ONSITE" },
      });
      await expect(
        prisma.applicationInterviewDetail.create({
          data: { applicationProcessStepId: step.id },
        }),
      ).rejects.toSatisfy(isConstraintError);

      await prisma.applicationAttempt.delete({ where: { id: attempt.id } });
      expect(
        await prisma.applicationProcessStep.findUnique({
          where: { id: step.id },
        }),
      ).toBeNull();
    });
  });
});
