// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { JOB_STATUSES } from "@/lib/constants";
import { SectionType } from "@/models/profile.model";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";
import {
  executeLegacyMigrationCommand,
  parseLegacyMigrationArgs,
} from "@/lib/legacy-migration/command";
import {
  resolveContactProfile,
  type LegacyContactRow,
} from "@/lib/legacy-migration/contact";
import {
  PHASE3_MIGRATION_VERSION,
  TARGET,
  UNSPECIFIED_CHANNEL_LABEL,
} from "@/lib/legacy-migration/identities";
import { runLegacyMigration } from "@/lib/legacy-migration/migrator";
import { classifyWritableTarget } from "@/lib/legacy-migration/safety";
import { JOB_RESUME_ID_CLASSIFICATION } from "@/lib/legacy-migration/phase2Auditor";

const REPO_ROOT = path.resolve(__dirname, "..");
const ENCRYPTION_SRC = path.resolve(REPO_ROOT, "src/lib/encryption.ts");

type SeedIds = {
  userId: string;
  jobs: Record<string, string>;
  resumes: Record<string, string>;
  workA: string;
  workB: string;
};

function contact(
  overrides: Partial<LegacyContactRow> & { resumeId: string },
): LegacyContactRow {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Engineer",
    email: "ada@example.com",
    phone: "555-0100",
    address: "London",
    url1: null,
    url1Label: null,
    url2: null,
    url2Label: null,
    ...overrides,
  };
}

async function seedLegacyGraph(prisma: PrismaClient): Promise<SeedIds> {
  const userId = await seedAccount(prisma, "phase3@example.com");
  const profile = await prisma.profile.create({ data: { userId } });
  const company = await prisma.company.create({
    data: { label: "Acme", value: "acme-phase3", createdBy: userId },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: "engineer-phase3", createdBy: userId },
  });
  const location = await prisma.location.create({
    data: { label: "Remote", value: "remote-phase3", createdBy: userId },
  });
  const source = await prisma.jobSource.findFirstOrThrow({
    where: { createdBy: userId },
  });
  const status = async (value: string) =>
    prisma.jobStatus.findFirstOrThrow({ where: { value } });

  const resumeA = await prisma.resume.create({
    data: { profileId: profile.id, title: "Primary" },
  });
  const resumeB = await prisma.resume.create({
    data: { profileId: profile.id, title: "Secondary" },
  });

  await prisma.contactInfo.create({
    data: {
      resumeId: resumeA.id,
      firstName: "Ada",
      lastName: "Lovelace",
      headline: "Engineer",
      email: "ada@example.com",
      phone: "555-0100",
      address: "London",
    },
  });
  await prisma.contactInfo.create({
    data: {
      resumeId: resumeB.id,
      firstName: "Ada",
      lastName: "Lovelace",
      headline: "Engineer",
      email: "ada.other@example.com",
      phone: "555-0100",
      address: null,
    },
  });

  const summary = await prisma.summary.create({
    data: { content: "Builds analytical engines." },
  });
  await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Summary",
      sectionType: SectionType.SUMMARY,
      summaryId: summary.id,
    },
  });
  const expA = await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Experience",
      sectionType: SectionType.EXPERIENCE,
    },
  });
  const expB = await prisma.resumeSection.create({
    data: {
      resumeId: resumeB.id,
      sectionTitle: "Experience",
      sectionType: SectionType.EXPERIENCE,
    },
  });
  const eduSection = await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Education",
      sectionType: SectionType.EDUCATION,
    },
  });
  const skillSection = await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Skills",
      sectionType: SectionType.SKILLS,
    },
  });
  const projectSection = await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Projects",
      sectionType: SectionType.PROJECT,
    },
  });
  const certSection = await prisma.resumeSection.create({
    data: {
      resumeId: resumeA.id,
      sectionTitle: "Certs",
      sectionType: SectionType.CERTIFICATION,
    },
  });

  const workA = await prisma.workExperience.create({
    data: {
      companyId: company.id,
      jobTitleId: title.id,
      locationId: location.id,
      startDate: new Date("2020-01-01T00:00:00.000Z"),
      endDate: new Date("2021-01-01T00:00:00.000Z"),
      description: "Shipped the difference engine.",
      resumeSectionId: expA.id,
    },
  });
  const workB = await prisma.workExperience.create({
    data: {
      companyId: company.id,
      jobTitleId: title.id,
      locationId: location.id,
      startDate: new Date("2020-01-01T00:00:00.000Z"),
      endDate: new Date("2021-01-01T00:00:00.000Z"),
      description: "Shipped the difference engine.",
      resumeSectionId: expB.id,
    },
  });
  await prisma.education.create({
    data: {
      institution: "Cambridge",
      degree: "BA",
      fieldOfStudy: "Mathematics",
      startDate: new Date("2015-01-01T00:00:00.000Z"),
      endDate: new Date("2018-01-01T00:00:00.000Z"),
      description: "Analytical science.",
      locationId: location.id,
      resumeSectionId: eduSection.id,
    },
  });
  const tag = await prisma.tag.create({
    data: { label: "TypeScript", value: "typescript-phase3", createdBy: userId },
  });
  await prisma.skill.create({
    data: { tagId: tag.id, resumeSectionId: skillSection.id, order: 3 },
  });
  await prisma.otherSection.create({
    data: {
      title: "Difference Engine",
      content: "Mechanical calculator",
      resumeSectionId: projectSection.id,
    },
  });
  await prisma.licenseOrCertification.create({
    data: {
      title: "Fellow",
      organization: "Royal Society",
      resumeSectionId: certSection.id,
    },
  });

  const createdAt = new Date("2024-01-01T00:00:00.000Z");
  const makeJob = async (
    key: string,
    data: {
      status: string;
      applied: boolean;
      appliedDate?: Date | null;
      resumeId?: string | null;
      jobSourceId?: string | null;
      description?: string;
    },
  ) => {
    const row = await prisma.job.create({
      data: {
        userId,
        description: data.description ?? `<p>${key} jd</p>`,
        jobType: "FT",
        createdAt,
        applied: data.applied,
        appliedDate: data.appliedDate ?? null,
        dueDate: new Date("2024-06-01T00:00:00.000Z"),
        statusId: (await status(data.status)).id,
        jobTitleId: title.id,
        companyId: company.id,
        locationId: location.id,
        resumeId: data.resumeId ?? null,
        jobSourceId: data.jobSourceId ?? null,
        salaryRange: "100k",
      },
    });
    return row.id;
  };

  const jobs = {
    unapplied: await makeJob("unapplied", {
      status: "draft",
      applied: false,
    }),
    appliedDated: await makeJob("appliedDated", {
      status: "applied",
      applied: true,
      appliedDate: new Date("2024-02-02T00:00:00.000Z"),
      resumeId: resumeA.id,
    }),
    appliedNoDate: await makeJob("appliedNoDate", {
      status: "applied",
      applied: true,
    }),
    interview: await makeJob("interview", {
      status: "interview",
      applied: true,
    }),
    offer: await makeJob("offer", {
      status: "offer",
      applied: true,
      appliedDate: new Date("2024-03-03T00:00:00.000Z"),
    }),
    rejected: await makeJob("rejected", {
      status: "rejected",
      applied: true,
    }),
    resumeAssoc: await makeJob("resumeAssoc", {
      status: "draft",
      applied: false,
      resumeId: resumeA.id,
      jobSourceId: source.id,
    }),
    expired: await makeJob("expired", {
      status: "expired",
      applied: false,
    }),
  };

  await prisma.note.create({
    data: { jobId: jobs.appliedDated, userId, content: "Follow up" },
  });

  expect(JOB_STATUSES.length).toBeGreaterThan(0);
  return { userId, jobs, resumes: { a: resumeA.id, b: resumeB.id }, workA: workA.id, workB: workB.id };
}

function migrateOpts(dbPath: string, extra: Record<string, unknown> = {}) {
  return {
    dbPath,
    repoRoot: REPO_ROOT,
    mode: "migrate" as const,
    confirmWritable: true,
    allowDisposableCopy: true,
    ...extra,
  };
}

describe("Phase 3 contact resolution", () => {
  it("fills a field when all non-empty values agree, including missing rows", () => {
    const result = resolveContactProfile([
      contact({ resumeId: "r1", email: "ada@example.com", address: "London" }),
      contact({ resumeId: "r2", email: " ada@example.com ", address: null }),
    ]);
    expect(result.profile.email).toBe("ada@example.com");
    expect(result.profile.address).toBe("London");
    expect(result.conflicts).toEqual([]);
    expect(result.createProfile).toBe(true);
  });

  it("does not pick a current email/phone/address from conflicts", () => {
    const email = resolveContactProfile([
      contact({ resumeId: "r1", email: "a@example.com" }),
      contact({ resumeId: "r2", email: "b@example.com" }),
    ]);
    expect(email.profile.email).toBeNull();
    expect(email.createProfile).toBe(false);
    expect(email.conflicts.some((c) => c.field === "email")).toBe(true);

    const phone = resolveContactProfile([
      contact({ resumeId: "r1", phone: "111" }),
      contact({ resumeId: "r2", phone: "222" }),
    ]);
    expect(phone.profile.phone).toBeNull();
    expect(phone.createProfile).toBe(false);

    const address = resolveContactProfile([
      contact({ resumeId: "r1", address: "London" }),
      contact({ resumeId: "r2", address: "Paris" }),
    ]);
    expect(address.profile.address).toBeNull();
    expect(address.createProfile).toBe(false);
  });
});

describe("Phase 3 CLI safety", () => {
  it("defaults to non-mutating audit and rejects --force", () => {
    expect(parseLegacyMigrationArgs([]).command).toBe("audit");
    expect(parseLegacyMigrationArgs(["--db", "x.db"]).command).toBe("audit");
    expect(parseLegacyMigrationArgs(["migrate", "--force"]).forceRequested).toBe(
      true,
    );
  });

  it("refuses known production/audit paths as writable targets", () => {
    const prod = classifyWritableTarget(
      path.join(REPO_ROOT, "prisma", "dev.db"),
      REPO_ROOT,
    );
    expect(prod.allowed).toBe(false);
    const smoke = classifyWritableTarget(
      path.join(REPO_ROOT, "prisma", "smoke-i18n.db"),
      REPO_ROOT,
    );
    expect(smoke.allowed).toBe(false);
  });
});

describe("Phase 3 disposable SQLite backfill", () => {
  const ctx = makeTestDbUrl();
  const dbPath = path.join(ctx.dir, "test.db");
  const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  let ids: SeedIds;
  let unknownPath: string;
  let partialPath: string;

  beforeAll(async () => {
    pushSchema(ctx.url);
    ids = await seedLegacyGraph(prisma);
    await prisma.$disconnect();

    unknownPath = path.join(ctx.dir, "unknown.db");
    partialPath = path.join(ctx.dir, "partial.db");
    fs.copyFileSync(dbPath, unknownPath);
    fs.copyFileSync(dbPath, partialPath);

    const unknownPrisma = new PrismaClient({
      datasources: { db: { url: `file:${unknownPath}` } },
    });
    const mystery = await unknownPrisma.jobStatus.create({
      data: { label: "Waiting", value: "waiting-for-feedback" },
    });
    const user = await unknownPrisma.user.findFirstOrThrow();
    const company = await unknownPrisma.company.findFirstOrThrow();
    const title = await unknownPrisma.jobTitle.findFirstOrThrow();
    await unknownPrisma.job.create({
      data: {
        userId: user.id,
        description: "mystery",
        jobType: "FT",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        applied: true,
        statusId: mystery.id,
        jobTitleId: title.id,
        companyId: company.id,
      },
    });
    await unknownPrisma.$disconnect();
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    try {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY") throw err;
    }
  });

  it("keeps LEGACY_SALT unchanged", () => {
    const src = fs.readFileSync(ENCRYPTION_SRC, "utf8");
    expect(src).toContain('const LEGACY_SALT = "jobsync-api-key-encryption"');
    expect(JOB_RESUME_ID_CLASSIFICATION).toBe("DO_NOT_MAP");
  });

  it("audit/plan/default migrate without flags perform zero writes", async () => {
    const before = fs.readFileSync(dbPath);
    const audit = await executeLegacyMigrationCommand({
      argv: ["audit", "--db", dbPath],
      repoRoot: REPO_ROOT,
    });
    expect(audit.writesAttempted).toBe(false);
    const plan = await runLegacyMigration({
      dbPath,
      repoRoot: REPO_ROOT,
      mode: "plan",
    });
    expect(plan.writeCount).toBe(0);
    expect(plan.runId).toBeNull();
    const refused = await runLegacyMigration({
      dbPath,
      repoRoot: REPO_ROOT,
      mode: "migrate",
    });
    expect(refused.phaseResult).toBe("BLOCKED");
    expect(refused.writeCount).toBe(0);
    const forced = await runLegacyMigration({
      ...migrateOpts(dbPath),
      forceRequested: true,
    });
    expect(forced.phaseResult).toBe("BLOCKED");
    expect(Buffer.compare(before, fs.readFileSync(dbPath))).toBe(0);
  }, 120_000);

  it("migrates representative legacy state idempotently", async () => {
    const first = await runLegacyMigration(migrateOpts(dbPath));
    expect(first.phaseResult).toBe("PASS");
    expect(first.preflight.ok).toBe(true);
    expect(first.duplicated).toBe(0);
    expect(first.created.opportunities).toBe(8);
    expect(first.created.attempts).toBe(5);
    expect(first.created.resumeVariants).toBe(2);
    expect(first.created.resumeVersions).toBe(2);
    expect(first.duplicateCandidates.automaticMerges).toBe(0);
    expect(first.duplicateCandidates.groupCount).toBeGreaterThanOrEqual(1);
    expect(first.contactConflicts.some((c) => c.fields.includes("email"))).toBe(
      true,
    );
    expect(first.orderingLimitations.join(" ")).toMatch(/ORDER_UNRECOVERABLE/);

    const verify = new PrismaClient({
      datasources: { db: { url: ctx.url } },
    });
    try {
      const migrationState = await verify.abMigrationState.findFirstOrThrow();
      expect(migrationState.status).toBe("COMPLETED");
      expect(migrationState.verifiedAt).not.toBeNull();

      const opportunities = await verify.jobOpportunity.findMany();
      expect(opportunities).toHaveLength(8);
      expect(opportunities.every((o) => o.campaignId == null)).toBe(true);
      expect(
        opportunities.every(
          (o) => !["INTERVIEW", "OFFER", "REJECTED"].includes(o.status),
        ),
      ).toBe(true);
      const expired = await verify.legacyMigrationMap.findFirstOrThrow({
        where: {
          legacyEntityId: ids.jobs.expired,
          targetEntityType: TARGET.JOB_OPPORTUNITY,
        },
      });
      const expiredOpp = await verify.jobOpportunity.findUniqueOrThrow({
        where: { id: expired.targetEntityId },
      });
      expect(expiredOpp.status).toBe("EXPIRED");

      const unappliedMap = await verify.legacyMigrationMap.findFirst({
        where: {
          legacyEntityId: ids.jobs.unapplied,
          targetEntityType: TARGET.APPLICATION_ATTEMPT,
        },
      });
      expect(unappliedMap).toBeNull();
      expect(
        await verify.applicationAttempt.count({
          where: { jobOpportunityId: expiredOpp.id },
        }),
      ).toBe(0);

      const datedMap = await verify.legacyMigrationMap.findFirstOrThrow({
        where: {
          legacyEntityId: ids.jobs.appliedDated,
          targetEntityType: TARGET.APPLICATION_ATTEMPT,
        },
      });
      const dated = await verify.applicationAttempt.findUniqueOrThrow({
        where: { id: datedMap.targetEntityId },
      });
      expect(dated.submittedAt?.toISOString()).toBe("2024-02-02T00:00:00.000Z");
      expect(dated.submittedResumeVersionId).toBeNull();
      expect(dated.submittedAgainstJdVersionId).toBeNull();
      const migratedItems = await verify.resumeVariantSectionItem.findMany({ include: { careerMaterialItem: true } });
      expect(migratedItems.filter((item) => item.careerMaterialItem).length).toBeGreaterThan(0);
      for (const item of migratedItems) expect(item.materialTitleSnapshot).toBe(item.careerMaterialItem?.title ?? null);
      expect(dated.channelLabel).toBe(UNSPECIFIED_CHANNEL_LABEL);
      expect(dated.channelCategory).toBeNull();

      const noDateMap = await verify.legacyMigrationMap.findFirstOrThrow({
        where: {
          legacyEntityId: ids.jobs.appliedNoDate,
          targetEntityType: TARGET.APPLICATION_ATTEMPT,
        },
      });
      const noDate = await verify.applicationAttempt.findUniqueOrThrow({
        where: { id: noDateMap.targetEntityId },
      });
      expect(noDate.submittedAt).toBeNull();

      const interviewMap = await verify.legacyMigrationMap.findFirstOrThrow({
        where: {
          legacyEntityId: ids.jobs.interview,
          targetEntityType: TARGET.APPLICATION_ATTEMPT,
        },
      });
      const interview = await verify.applicationAttempt.findUniqueOrThrow({
        where: { id: interviewMap.targetEntityId },
        include: { processSteps: true },
      });
      expect(interview.currentStageCategory).toBe("INTERVIEW");
      expect(interview.processSteps).toHaveLength(1);
      expect(interview.processSteps[0].category).toBe("INTERVIEW");
      expect(interview.processSteps[0].scheduledAt).toBeNull();
      expect(interview.processSteps[0].completedAt).toBeNull();

      const assocMap = await verify.legacyMigrationMap.findFirstOrThrow({
        where: {
          legacyEntityId: ids.jobs.resumeAssoc,
          targetEntityType: TARGET.JOB_OPPORTUNITY,
        },
      });
      const assoc = await verify.jobOpportunity.findUniqueOrThrow({
        where: { id: assocMap.targetEntityId },
      });
      expect(assoc.sourceLabel).toBeTruthy();
      expect(
        await verify.applicationAttempt.count({
          where: { jobOpportunityId: assoc.id },
        }),
      ).toBe(0);

      const jdCount = await verify.jobDescriptionVersion.count();
      expect(jdCount).toBe(8);
      expect(
        await verify.jobDescriptionParse.count(),
      ).toBe(0);

      const versions = await verify.resumeVariantVersion.findMany({
        include: { sections: true },
      });
      expect(versions).toHaveLength(2);
      expect(
        versions.every((v) => v.layoutConfig?.includes("ORDER_UNRECOVERABLE")),
      ).toBe(true);
      expect(versions.every((v) => v.status === "FROZEN")).toBe(true);
      expect(
        versions.flatMap((v) => v.sections).every((s) => s.sortOrder === 0),
      ).toBe(true);

      const materials = await verify.careerMaterialItem.findMany({
        include: { skillDetail: true },
      });
      expect(materials.filter((m) => m.type === "EMPLOYMENT")).toHaveLength(2);
      expect(materials.some((m) => m.type === "PROJECT")).toBe(true);
      expect(materials.some((m) => m.type === "EDUCATION")).toBe(true);
      expect(materials.some((m) => m.type === "CERTIFICATION")).toBe(true);
      const skill = materials.find((m) => m.type === "SKILL");
      expect(skill?.skillDetail?.structuredData).toMatch(/"skillOrder":3/);
      const ownTag = await verify.tag.findFirstOrThrow({
        where: { value: "typescript-phase3" },
      });
      expect(skill?.skillDetail?.skillName).toBe(ownTag.label);
      expect(skill?.skillDetail?.tagId).toBe(ownTag.id);

      const profile = await verify.candidateProfile.findUnique({
        where: { userId: ids.userId },
      });
      expect(profile).toBeNull();
      expect(first.created.contactProfiles).toBe(0);

      const maps = await verify.legacyMigrationMap.findMany();
      const identityKeys = maps.map(
        (m) =>
          `${m.legacyEntityType}|${m.legacyEntityId}|${m.targetEntityType}`,
      );
      expect(new Set(identityKeys).size).toBe(identityKeys.length);

      const firstVersionJson = JSON.stringify(
        await verify.resumeVariantVersion.findMany({ orderBy: { id: "asc" } }),
      );

      const second = await runLegacyMigration(migrateOpts(dbPath));
      expect(second.phaseResult).toBe("PASS");
      expect(second.created.opportunities).toBe(0);
      expect(second.created.attempts).toBe(0);
      expect(second.created.jdVersions).toBe(0);
      expect(second.created.resumeVariants).toBe(0);
      expect(second.created.resumeVersions).toBe(0);
      expect(second.created.careerMaterials).toBe(0);
      expect(second.created.careerEvidence).toBe(0);
      expect(second.created.contactProfiles).toBe(0);
      expect(second.writeCount).toBe(0);
      expect(second.duplicated).toBe(0);
      expect(second.unexpectedUpdates).toBe(0);
      expect(await verify.jobOpportunity.count()).toBe(8);
      expect(await verify.applicationAttempt.count()).toBe(5);
      expect(await verify.jobDescriptionVersion.count()).toBe(8);
      expect(await verify.resumeVariant.count()).toBe(2);
      expect(await verify.resumeVariantVersion.count()).toBe(2);
      expect(await verify.legacyMigrationMap.count()).toBe(maps.length);
      expect(
        JSON.stringify(
          await verify.resumeVariantVersion.findMany({ orderBy: { id: "asc" } }),
        ),
      ).toBe(firstVersionJson);
      expect(await verify.dataMigrationRun.count()).toBe(2);
      expect(
        (await verify.dataMigrationRun.findMany()).every(
          (run) => run.status === "COMPLETED" && run.completedAt != null,
        ),
      ).toBe(true);
      expect(second.migrationVersion).toBe(PHASE3_MIGRATION_VERSION);
    } finally {
      await verify.$disconnect();
    }
  }, 180_000);

  it("blocks writable execution when an unknown JobStatus exists", async () => {
    const before = fs.readFileSync(unknownPath);
    const report = await runLegacyMigration(migrateOpts(unknownPath));
    expect(report.phaseResult).toBe("BLOCKED");
    expect(report.preflight.ok).toBe(false);
    expect(report.writeCount).toBe(0);
    expect(report.runId).toBeNull();
    expect(Buffer.compare(before, fs.readFileSync(unknownPath))).toBe(0);

    const unknownPrisma = new PrismaClient({
      datasources: { db: { url: `file:${unknownPath}` } },
    });
    try {
      expect(await unknownPrisma.jobOpportunity.count()).toBe(0);
      expect(await unknownPrisma.dataMigrationRun.count()).toBe(0);
    } finally {
      await unknownPrisma.$disconnect();
    }
  }, 120_000);

  it("rolls back a failed root and resumes without duplicating successes", async () => {
    const failId = ids.jobs.offer;
    const first = await runLegacyMigration({
      ...migrateOpts(partialPath),
      hooks: {
        beforeFinishRoot: (kind, legacyId) => {
          if (kind === "Job" && legacyId === failId) {
            throw new Error("controlled failure");
          }
        },
      },
    });
    expect(first.phaseResult).toBe("FAILED");
    expect(first.failed.opportunities).toBe(1);
    expect(first.created.opportunities).toBe(7);

    const partialPrisma = new PrismaClient({
      datasources: { db: { url: `file:${partialPath}` } },
    });
    try {
      const failedRun = await partialPrisma.dataMigrationRun.findFirstOrThrow({
        orderBy: { startedAt: "desc" },
      });
      expect(failedRun.status).toBe("FAILED");
      expect(failedRun.completedAt).not.toBeNull();
      const failedState = await partialPrisma.abMigrationState.findFirstOrThrow();
      expect(failedState.status).not.toBe("COMPLETED");
      expect(failedState.status).toBe("FAILED");
      expect(failedState.verifiedAt).toBeNull();

      const offerMap = await partialPrisma.legacyMigrationMap.findFirst({
        where: {
          legacyEntityId: failId,
          targetEntityType: TARGET.JOB_OPPORTUNITY,
        },
      });
      expect(offerMap).toBeNull();
      const successMap = await partialPrisma.legacyMigrationMap.findFirst({
        where: {
          legacyEntityId: ids.jobs.appliedDated,
          targetEntityType: TARGET.JOB_OPPORTUNITY,
        },
      });
      expect(successMap).toBeTruthy();
      const beforeOpps = await partialPrisma.jobOpportunity.count();

      const second = await runLegacyMigration(migrateOpts(partialPath));
      expect(second.phaseResult).toBe("PASS");
      expect(second.created.opportunities).toBe(1);
      expect(await partialPrisma.jobOpportunity.count()).toBe(beforeOpps + 1);
      expect(
        await partialPrisma.legacyMigrationMap.findFirst({
          where: {
            legacyEntityId: failId,
            targetEntityType: TARGET.JOB_OPPORTUNITY,
          },
        }),
      ).toBeTruthy();
      expect(await partialPrisma.jobOpportunity.count()).toBe(8);
      const completedState = await partialPrisma.abMigrationState.findFirstOrThrow();
      expect(completedState.status).toBe("COMPLETED");
      expect(completedState.verifiedAt).not.toBeNull();
    } finally {
      await partialPrisma.$disconnect();
    }
  }, 180_000);

  it("keeps a real tagId only for same-user tags; cross-user degrades to text", async () => {
    const tagCtx = makeTestDbUrl();
    const tagDbPath = path.join(tagCtx.dir, "test.db");
    const seedPrisma = new PrismaClient({
      datasources: { db: { url: tagCtx.url } },
    });
    try {
      pushSchema(tagCtx.url);
      const uid = await seedAccount(seedPrisma, "skill-tag@example.com");
      const otherUid = await seedAccount(seedPrisma, "skill-other@example.com");
      const profile = await seedPrisma.profile.create({
        data: { userId: uid },
      });
      const resume = await seedPrisma.resume.create({
        data: { profileId: profile.id, title: "R" },
      });
      const section = await seedPrisma.resumeSection.create({
        data: {
          resumeId: resume.id,
          sectionTitle: "Skills",
          sectionType: SectionType.SKILLS,
        },
      });
      const ownTag = await seedPrisma.tag.create({
        data: { label: "Own Skill", value: "own-skill-x", createdBy: uid },
      });
      const foreignTag = await seedPrisma.tag.create({
        data: {
          label: "Foreign Skill",
          value: "foreign-skill-x",
          createdBy: otherUid,
        },
      });
      await seedPrisma.skill.create({
        data: { tagId: ownTag.id, resumeSectionId: section.id, order: 1 },
      });
      await seedPrisma.skill.create({
        data: { tagId: foreignTag.id, resumeSectionId: section.id, order: 2 },
      });
      await seedPrisma.$disconnect();

      const report = await runLegacyMigration(migrateOpts(tagDbPath));
      expect(report.phaseResult).toBe("PASS");

      const verify = new PrismaClient({
        datasources: { db: { url: tagCtx.url } },
      });
      try {
        const details = await verify.careerSkillDetail.findMany();
        const own = details.find((d) => d.skillName === "Own Skill");
        const foreign = details.find((d) => d.skillName === "Foreign Skill");
        // Same-user Tag: the real reference survives migration.
        expect(own?.tagId).toBe(ownTag.id);
        // Cross-user Tag: keep the label as a text snapshot, no fabricated link.
        expect(foreign?.tagId).toBeNull();
        expect(foreign?.skillName).toBe("Foreign Skill");
      } finally {
        await verify.$disconnect();
      }
    } finally {
      await seedPrisma.$disconnect();
      try {
        fs.rmSync(tagCtx.dir, { recursive: true, force: true });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") throw err;
      }
    }
  }, 180_000);
});
