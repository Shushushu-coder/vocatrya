// @vitest-environment node
import fs from "fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { BackupDataSchema } from "@/lib/backup/schema";
import {
  copyRemainingMigrations,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
  preparePrismaProjectThrough,
} from "./helpers/abSchemaTestDb";

// Last migration before the A+B foundation; the "legacy" database state.
const LEGACY_CUTOFF_MIGRATION = "contact_default_role";

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
    // Legacy base = the full migration history up to (and including) the last
    // migration before the A+B foundation. Everything after it is applied as
    // the upgrade wave, in timestamp order, derived from the filesystem.
    const schemaPath = preparePrismaProjectThrough(
      ctx.dir,
      LEGACY_CUTOFF_MIGRATION,
    );
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

    afterAll(async () => {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    it("leaves legacy Job / Resume / Company rows unchanged", async () => {
      migrateDeploy(ctx.url, schemaPath);

      // Seed through raw SQL using only columns that exist at the cutoff; the
      // generated client targets the latest schema and would reference later
      // columns.
      const ids = {
        user: "legacy-user-1",
        company: "legacy-company-1",
        title: "legacy-title-1",
        status: "legacy-status-1",
        profile: "legacy-profile-1",
        resume: "legacy-resume-1",
        job: "legacy-job-1",
      };
      const createdAt = new Date("2026-01-15T00:00:00.000Z").getTime();
      const appliedDate = new Date("2026-01-16T00:00:00.000Z").getTime();
      const dueDate = new Date("2026-02-01T00:00:00.000Z").getTime();
      const description = "Build widgets. Do not mutate this text.";
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "name", "email", "password")
        VALUES (${ids.user}, ${"Legacy User"}, ${"legacy-ab@example.com"}, ${"x"})
      `;
      await prisma.$executeRaw`
        INSERT INTO "Company" ("id", "label", "value", "createdBy", "watched", "websiteUrl")
        VALUES (${ids.company}, ${"Acme"}, ${"acme"}, ${ids.user}, ${1}, ${"https://acme.example.com"})
      `;
      await prisma.$executeRaw`
        INSERT INTO "JobTitle" ("id", "label", "value", "createdBy")
        VALUES (${ids.title}, ${"Engineer"}, ${"engineer"}, ${ids.user})
      `;
      await prisma.$executeRaw`
        INSERT INTO "JobStatus" ("id", "label", "value")
        VALUES (${ids.status}, ${"Applied"}, ${"applied-ab-phase1"})
      `;
      await prisma.$executeRaw`
        INSERT INTO "Profile" ("id", "userId") VALUES (${ids.profile}, ${ids.user})
      `;
      await prisma.$executeRaw`
        INSERT INTO "Resume" ("id", "profileId", "title", "updatedAt")
        VALUES (${ids.resume}, ${ids.profile}, ${"Legacy Resume"}, ${createdAt})
      `;
      await prisma.$executeRaw`
        INSERT INTO "Job" ("id", "userId", "description", "jobType", "createdAt", "applied", "appliedDate", "dueDate", "statusId", "jobTitleId", "companyId", "resumeId")
        VALUES (${ids.job}, ${ids.user}, ${description}, ${"FT"}, ${createdAt}, ${1}, ${appliedDate}, ${dueDate}, ${ids.status}, ${ids.title}, ${ids.company}, ${ids.resume})
      `;

      const count = async (table: string) =>
        Number(
          (
            await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
              `SELECT COUNT(*) as n FROM "${table}"`,
            )
          )[0].n,
        );
      const before = {
        jobs: await count("Job"),
        resumes: await count("Resume"),
        companies: await count("Company"),
      };
      expect(before).toEqual({ jobs: 1, resumes: 1, companies: 1 });

      copyRemainingMigrations(ctx.dir);
      migrateDeploy(ctx.url, schemaPath);
      // Refresh SQLite prepared statement metadata after the table rebuilds.
      await prisma.$disconnect();

      expect(await prisma.job.count()).toBe(before.jobs);
      expect(await prisma.resume.count()).toBe(before.resumes);
      expect(await prisma.company.count()).toBe(before.companies);

      const jobAfter = await prisma.job.findUniqueOrThrow({
        where: { id: ids.job },
      });
      const resumeAfter = await prisma.resume.findUniqueOrThrow({
        where: { id: ids.resume },
      });
      const companyAfter = await prisma.company.findUniqueOrThrow({
        where: { id: ids.company },
      });

      expect(jobAfter.description).toBe(description);
      expect(jobAfter.resumeId).toBe(ids.resume);
      expect(jobAfter.applied).toBe(true);
      expect(jobAfter.createdAt.getTime()).toBe(createdAt);
      expect(jobAfter.appliedDate?.getTime()).toBe(appliedDate);
      expect(jobAfter.dueDate?.getTime()).toBe(dueDate);
      expect(resumeAfter.title).toBe("Legacy Resume");
      expect(companyAfter.label).toBe("Acme");
      expect(companyAfter.value).toBe("acme");
      expect(companyAfter.websiteUrl).toBe("https://acme.example.com");
      expect(companyAfter.createdBy).toBe(ids.user);
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
