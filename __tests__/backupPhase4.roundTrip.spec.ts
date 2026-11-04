// @vitest-environment node
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BackupError, buildManifest } from "@/lib/backup/manifest";
import { BackupDataSchema } from "@/lib/backup/schema";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { projectResumeVariantText } from "@/lib/career/resumeVariantText";
import { seedAccount } from "./helpers/backupTestDb";
import {
  LEGACY,
  PHASE3_MIGRATION_VERSION,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { runLegacyMigration } from "@/lib/legacy-migration/migrator";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
  resolveCareerRuntimeMode,
} from "@/lib/career";

const REPO_ROOT = path.resolve(__dirname, "..");

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const dbPath = path.join(ctx.dir, "test.db");

let userId: string;
let uploadsDir: string;
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

const SNAPSHOT_TEXT = "frozen evidence snapshot — do not regenerate";
const SNAPSHOT_HASH = "sha256-evidence-frozen";
const LIVE_EVIDENCE = "live evidence that later changed";
const LAYOUT = JSON.stringify({ columns: 2, theme: "compact" });
const HEADER = JSON.stringify({ fullName: "Ada Lovelace" });

beforeAll(async () => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
  userId = await seedAccount(prisma, "phase4@example.com");
  await seedPhase4Graph();
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

async function seedPhase4Graph() {
  const company = await prisma.company.create({
    data: {
      label: "Acme",
      value: "acme-phase4",
      createdBy: userId,
      notes: "Strategic notes",
      sizeLabel: "201-500",
      headquarters: "Beijing",
    },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: "engineer-phase4", createdBy: userId },
  });
  const location = await prisma.location.create({
    data: { label: "Remote", value: "remote-phase4", createdBy: userId },
  });
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: "applied" },
  });
  const source = await prisma.jobSource.findFirstOrThrow({
    where: { createdBy: userId },
  });
  const profile = await prisma.profile.create({ data: { userId } });
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: "Primary" },
  });
  await prisma.contactInfo.create({
    data: {
      resumeId: resume.id,
      firstName: "Ada",
      lastName: "Lovelace",
      headline: "Engineer",
      email: "ada@example.com",
      phone: "555-0100",
    },
  });
  const expSection = await prisma.resumeSection.create({
    data: {
      resumeId: resume.id,
      sectionTitle: "Experience",
      sectionType: "experience",
    },
  });
  await prisma.workExperience.create({
    data: {
      companyId: company.id,
      jobTitleId: title.id,
      locationId: location.id,
      resumeSectionId: expSection.id,
      startDate: new Date("2020-01-01T00:00:00.000Z"),
      description: "Built analytical engines.",
    },
  });
  await prisma.job.create({
    data: {
      userId,
      description: "<p>Build widgets.</p>",
      jobType: "full-time",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      applied: true,
      appliedDate: new Date("2026-01-16T00:00:00.000Z"),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: company.id,
      jobSourceId: source.id,
      locationId: location.id,
      resumeId: resume.id,
    },
  });

  const migrate = await runLegacyMigration({
    dbPath,
    repoRoot: REPO_ROOT,
    mode: "migrate",
    confirmWritable: true,
    allowDisposableCopy: true,
  });
  expect(migrate.phaseResult).toBe("PASS");
  expect(migrate.created.opportunities).toBe(1);

  await prisma.dataMigrationRun.create({
    data: {
      userId,
      version: PHASE3_MIGRATION_VERSION,
      mode: "migrate",
      status: "COMPLETED",
      counts: JSON.stringify({ sourcePath: path.resolve(dbPath) }),
    },
  });

  const opportunity = await prisma.jobOpportunity.findFirstOrThrow({
    where: { userId },
  });
  const campaign = await prisma.recruitmentCampaign.create({
    data: {
      userId,
      companyId: company.id,
      name: "2026 Campus",
      recruitmentType: "CAMPUS",
      year: 2026,
      season: "FALL",
      status: "ACTIVE",
    },
  });
  await prisma.jobOpportunity.update({
    where: { id: opportunity.id },
    data: { campaignId: campaign.id },
  });

  const jdV1 = await prisma.jobDescriptionVersion.findFirstOrThrow({
    where: { jobOpportunityId: opportunity.id },
  });
  const parse = await prisma.jobDescriptionParse.create({
    data: {
      jobDescriptionVersionId: jdV1.id,
      schemaVersion: "jd-v1",
      parserVersion: "parser-1",
      structuredData: JSON.stringify({ role: "Engineer" }),
      parseStatus: "SUCCEEDED",
      inputHash: "parse-input-hash",
      parsedAt: new Date("2026-01-17T00:00:00.000Z"),
    },
  });
  await prisma.jobDescriptionVersion.update({
    where: { id: jdV1.id },
    data: { currentParseId: parse.id },
  });

  const material = await prisma.careerMaterialItem.findFirstOrThrow({
    where: { userId },
  });
  const evidence = await prisma.careerEvidence.create({
    data: {
      materialItemId: material.id,
      kind: "ACTION",
      content: LIVE_EVIDENCE,
      sortOrder: 0,
    },
  });

  const variant = await prisma.resumeVariant.findFirstOrThrow({
    where: { userId },
  });
  const version1 = await prisma.resumeVariantVersion.findFirstOrThrow({
    where: { resumeVariantId: variant.id },
  });
  const version2 = await prisma.resumeVariantVersion.create({
    data: {
      resumeVariantId: variant.id,
      versionNumber: version1.versionNumber + 1,
      parentVersionId: version1.id,
      status: "FROZEN",
      targetJdVersionId: jdV1.id,
      headerSnapshot: HEADER,
      layoutConfig: LAYOUT,
      createdVia: "USER",
      frozenAt: new Date("2026-02-01T00:00:00.000Z"),
    },
  });
  await prisma.resumeVariant.update({
    where: { id: variant.id },
    data: {
      currentVersionId: version2.id,
      targetJobOpportunityId: opportunity.id,
    },
  });

  const section = await prisma.resumeVariantSection.create({
    data: {
      resumeVariantVersionId: version2.id,
      title: "Experience",
      systemKind: "EXPERIENCE",
      sortOrder: 0,
    },
  });
  const item = await prisma.resumeVariantSectionItem.create({
    data: {
      resumeVariantSectionId: section.id,
      careerMaterialItemId: material.id,
      materialTitleSnapshot: "Captured historical title",
      itemKind: "EMPLOYMENT",
      sortOrder: 0,
    },
  });
  const linked = await prisma.resumeExpression.create({
    data: {
      resumeVariantSectionItemId: item.id,
      kind: "BULLET",
      content: "Shipped the engine.",
      sortOrder: 0,
      evidenceStatus: "LINKED",
    },
  });
  await prisma.resumeExpression.create({
    data: {
      resumeVariantSectionItemId: item.id,
      kind: "BULLET",
      content: "Unlinked line.",
      sortOrder: 1,
      evidenceStatus: "UNLINKED",
    },
  });
  await prisma.resumeExpressionEvidence.create({
    data: {
      resumeExpressionId: linked.id,
      careerEvidenceId: evidence.id,
      evidenceContentSnapshot: SNAPSHOT_TEXT,
      evidenceHashSnapshot: SNAPSHOT_HASH,
      evidenceUpdatedAtSnapshot: new Date("2026-01-20T00:00:00.000Z"),
    },
  });

  const artifact = await prisma.resumeArtifact.create({
    data: {
      resumeVariantVersionId: version2.id,
      kind: "PDF",
      format: "application/pdf",
      storageKey: "C:\\Users\\HP\\source-machine\\resume.pdf",
      fileName: "resume.pdf",
      sha256: "abc123",
      byteSize: 12,
    },
  });

  const fast = await prisma.matchAnalysis.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      analysisType: "FAST_SCREENING",
      resumeVariantVersionId: null,
      inputHash: "fast-hash",
      analysisSchemaVersion: "fast-1",
      status: "COMPLETED",
      isStale: true,
      staleReasonCodes: JSON.stringify(["JD_CHANGED"]),
      staleAt: new Date("2026-03-01T00:00:00.000Z"),
      completedAt: new Date("2026-02-15T00:00:00.000Z"),
    },
  });
  await prisma.fastScreeningDetail.create({
    data: {
      matchAnalysisId: fast.id,
      verdict: "PROCEED",
      inputSnapshot: JSON.stringify({ jd: "Build widgets." }),
      reasons: JSON.stringify(["core match"]),
    },
  });
  const deep = await prisma.matchAnalysis.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      analysisType: "DEEP_MATCH",
      resumeVariantVersionId: version2.id,
      inputHash: "deep-hash",
      analysisSchemaVersion: "deep-1",
      status: "COMPLETED",
      isStale: false,
      completedAt: new Date("2026-02-16T00:00:00.000Z"),
    },
  });
  await prisma.deepMatchDetail.create({
    data: {
      matchAnalysisId: deep.id,
      overallSummary: "Strong fit",
      overallScore: 88,
      strengths: JSON.stringify(["engines"]),
    },
  });
  await prisma.matchEvidenceLink.create({
    data: {
      matchAnalysisId: deep.id,
      requirementKey: "built-engines",
      requirementTextSnapshot: "Build analytical engines",
      careerEvidenceId: evidence.id,
      resumeExpressionId: linked.id,
      judgement: "SUPPORTED",
      evidenceContentSnapshot: SNAPSHOT_TEXT,
      evidenceHashSnapshot: SNAPSHOT_HASH,
    },
  });
  await prisma.resumeVariantVersion.update({
    where: { id: version2.id },
    data: { sourceMatchAnalysisId: deep.id },
  });

  const attempt = await prisma.applicationAttempt.findFirstOrThrow({
    where: { userId },
  });
  await prisma.applicationAttempt.update({
    where: { id: attempt.id },
    data: {
      channelCategory: "COMPANY_SITE",
      channelLabel: "Careers page",
      sourceUrl: "https://acme.example.com/jobs/1",
      notes: "Submitted after referral",
      submittedResumeVersionId: version2.id,
      submittedResumeArtifactId: artifact.id,
      submittedAgainstJdVersionId: jdV1.id,
    },
  });
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: "Hiring manager",
      status: "COMPLETED",
      sortOrder: 10,
      scheduledAt: new Date("2026-02-20T00:00:00.000Z"),
      completedAt: new Date("2026-02-21T00:00:00.000Z"),
      result: "PASSED",
      source: "USER",
      notes: "Onsite",
    },
  });
  await prisma.applicationInterviewDetail.create({
    data: {
      applicationProcessStepId: step.id,
      interviewFormat: "ONSITE",
      roundLabel: "HM",
      locationText: "Beijing",
      durationMinutes: 45,
      structuredData: JSON.stringify({ panel: 2 }),
    },
  });

  await prisma.jobSearchPreference.create({
    data: {
      userId,
      targetRoles: JSON.stringify(["Engineer"]),
      preferredCities: JSON.stringify(["Beijing"]),
    },
  });
  await prisma.candidateProfile.upsert({
    where: { userId },
    update: { fullName: "Ada Lovelace", email: "ada@example.com" },
    create: {
      userId,
      fullName: "Ada Lovelace",
      email: "ada@example.com",
    },
  });
}

function migrateOpts() {
  return {
    dbPath,
    repoRoot: REPO_ROOT,
    mode: "migrate" as const,
    confirmWritable: true,
    allowDisposableCopy: true,
  };
}

describe("Phase 4 v2 backup / restore round-trip", () => {
  it("preserves builder visibility and lineage as values while remapping row identities", async () => {
    const section = await prisma.resumeVariantSection.findFirstOrThrow({ where: { version: { resumeVariant: { userId } } }, include: { items: { include: { expressions: true } } } });
    const hiddenAt = new Date("2026-10-29T00:00:00.000Z");
    await prisma.resumeVariantSection.update({ where: { id: section.id }, data: { hiddenAt, originRefId: "section-lineage" } });
    await prisma.resumeVariantSectionItem.update({ where: { id: section.items[0].id }, data: { hiddenAt, originRefId: "item-lineage" } });
    await prisma.resumeExpression.update({ where: { id: section.items[0].expressions[0].id }, data: { hiddenAt, originRefId: "expression-lineage" } });
    const { buffer } = await buildBackupZip(userId, "phase4@example.com");
    await importBackup(buffer, userId, "phase4@example.com", true);
    const restored = await prisma.resumeVariantSection.findFirstOrThrow({ where: { originRefId: "section-lineage", version: { resumeVariant: { userId } } }, include: { items: { include: { expressions: true } } } });
    expect(restored.id).not.toBe(section.id); expect(restored.hiddenAt).toEqual(hiddenAt);
    expect(restored.items[0].originRefId).toBe("item-lineage"); expect(restored.items[0].hiddenAt).toEqual(hiddenAt);
    expect(restored.items[0].expressions.find((e) => e.originRefId === "expression-lineage")?.hiddenAt).toEqual(hiddenAt);
  }, 120_000);

  it("restores old backup items without a snapshot as null, with no live title fallback", async () => {
    const { buffer } = await buildBackupZip(userId, "phase4@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    for (const row of data.ResumeVariantSectionItem)
      delete row.materialTitleSnapshot;
    zip.file("data.json", JSON.stringify(data));
    try {
      await importBackup(
        await zip.generateAsync({ type: "nodebuffer" }),
        userId,
        "phase4@example.com",
        true,
      );
      const items = await prisma.resumeVariantSectionItem.findMany({
        where: { section: { version: { resumeVariant: { userId } } } },
      });
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.materialTitleSnapshot === null)).toBe(
        true,
      );
      const variant = await prisma.resumeVariant.findFirstOrThrow({
        where: { userId },
      });
      const service = new ResumeVariantService(prisma, userId, {
        ...process.env,
        [AB_RUNTIME_FEATURE_ENV]: "true",
        [AB_ROLLOUT_SCOPE_ENV]: "full",
      });
      const version = await service.getVersion(variant.currentVersionId!);
      expect(projectResumeVariantText(version)).not.toContain(
        "Captured historical title",
      );
      for (const item of version.sections.flatMap((section) => section.items)) {
        if (item.careerMaterialItem)
          expect(item.materialTitleSnapshot).toBeNull();
      }
    } finally {
      await importBackup(buffer, userId, "phase4@example.com", true);
    }
  }, 120_000);

  it("writes formatVersion 8 and omits DataMigrationRun", async () => {
    const { buffer } = await buildBackupZip(userId, "phase4@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(
      await zip.file("manifest.json")!.async("string"),
    );
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(manifest.formatVersion).toBe(8);
    expect(manifest.containsSensitiveData).toBe(false);
    expect(data).not.toHaveProperty("CandidateSensitiveInfo");
    expect(data).not.toHaveProperty("ResumeContactProfile");
    expect(data.DataMigrationRun).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("sourcePath");
    expect(data.Company[0].notes).toBe("Strategic notes");
    expect(data.LegacyMigrationMap.length).toBeGreaterThan(0);
    expect(data.JobOpportunity.length).toBe(1);
  }, 120_000);

  it("restores the A+B graph, remaps deferred FKs, and keeps snapshots", async () => {
    const { buffer } = await buildBackupZip(userId, "phase4@example.com");
    const result = await importBackup(
      buffer,
      userId,
      "phase4@example.com",
      true,
    );
    expect(result.counts.JobOpportunity).toBe(1);
    expect(result.counts.DataMigrationRun).toBeUndefined();

    const company = await prisma.company.findFirstOrThrow({
      where: { createdBy: userId, value: "acme-phase4" },
    });
    expect(company.notes).toBe("Strategic notes");
    expect(company.sizeLabel).toBe("201-500");
    expect(company.headquarters).toBe("Beijing");

    const opportunity = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId },
      include: {
        campaign: true,
        currentJdVersion: { include: { currentParse: true } },
      },
    });
    expect(opportunity.campaign?.name).toBe("2026 Campus");
    expect(opportunity.currentJdVersionId).toBeTruthy();
    expect(opportunity.currentJdVersionId).toBe(
      opportunity.currentJdVersion?.id,
    );
    expect(opportunity.currentJdVersion?.currentParseId).toBe(
      opportunity.currentJdVersion?.currentParse?.id,
    );
    expect(opportunity.currentJdVersion?.currentParse?.inputHash).toBe(
      "parse-input-hash",
    );

    const variant = await prisma.resumeVariant.findFirstOrThrow({
      where: { userId },
      include: {
        currentVersion: true,
        versions: { orderBy: { versionNumber: "asc" } },
      },
    });
    expect(variant.currentVersionId).toBe(variant.currentVersion?.id);
    expect(variant.versions).toHaveLength(2);
    const current = variant.currentVersion!;
    expect(
      (
        await prisma.resumeVariantSectionItem.findFirstOrThrow({
          where: { section: { resumeVariantVersionId: current.id } },
        })
      ).materialTitleSnapshot,
    ).toBe("Captured historical title");
    expect(current.status).toBe("FROZEN");
    expect(current.layoutConfig).toBe(LAYOUT);
    expect(current.headerSnapshot).toBe(HEADER);
    expect(current.parentVersionId).toBe(variant.versions[0].id);
    expect(current.sourceMatchAnalysisId).toBeTruthy();

    const expressions = await prisma.resumeExpression.findMany({
      where: {
        sectionItem: { section: { resumeVariantVersionId: current.id } },
      },
      include: { evidenceLinks: true },
      orderBy: { sortOrder: "asc" },
    });
    expect(expressions).toHaveLength(2);
    expect(expressions[0].evidenceStatus).toBe("LINKED");
    expect(expressions[1].evidenceStatus).toBe("UNLINKED");
    expect(expressions[1].evidenceLinks).toHaveLength(0);
    expect(expressions[0].evidenceLinks[0].evidenceContentSnapshot).toBe(
      SNAPSHOT_TEXT,
    );
    expect(expressions[0].evidenceLinks[0].evidenceHashSnapshot).toBe(
      SNAPSHOT_HASH,
    );

    const liveEvidence = await prisma.careerEvidence.findFirstOrThrow({
      where: { materialItem: { userId }, content: LIVE_EVIDENCE },
    });
    expect(expressions[0].evidenceLinks[0].careerEvidenceId).toBe(
      liveEvidence.id,
    );
    expect(expressions[0].evidenceLinks[0].evidenceContentSnapshot).not.toBe(
      liveEvidence.content,
    );

    const artifact = await prisma.resumeArtifact.findFirstOrThrow({
      where: { version: { resumeVariant: { userId } } },
    });
    expect(artifact.storageKey).toBe(
      `resume-artifacts/${artifact.id}/resume.pdf`,
    );
    expect(artifact.storageKey).not.toMatch(/C:\\Users\\HP/);
    expect(artifact.sha256).toBe("abc123");

    const attempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { userId },
      include: {
        processSteps: {
          include: { interviewDetail: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    expect(attempt.channelLabel).toBe("Careers page");
    expect(attempt.sourceUrl).toBe("https://acme.example.com/jobs/1");
    expect(attempt.notes).toBe("Submitted after referral");
    expect(attempt.submittedResumeVersionId).toBe(current.id);
    expect(attempt.submittedResumeArtifactId).toBe(artifact.id);
    expect(attempt.submittedAgainstJdVersionId).toBe(
      opportunity.currentJdVersionId,
    );
    const interviewStep = attempt.processSteps.find(
      (s) => s.category === "INTERVIEW",
    );
    expect(interviewStep?.label).toBe("Hiring manager");
    expect(interviewStep?.sortOrder).toBe(10);
    expect(interviewStep?.interviewDetail?.interviewFormat).toBe("ONSITE");
    expect(interviewStep?.interviewDetail?.structuredData).toBe(
      JSON.stringify({ panel: 2 }),
    );

    const fast = await prisma.matchAnalysis.findFirstOrThrow({
      where: { userId, analysisType: "FAST_SCREENING" },
      include: { fastScreeningDetail: true },
    });
    expect(fast.resumeVariantVersionId).toBeNull();
    expect(fast.inputHash).toBe("fast-hash");
    expect(fast.isStale).toBe(true);
    expect(fast.staleReasonCodes).toBe(JSON.stringify(["JD_CHANGED"]));
    expect(fast.fastScreeningDetail?.inputSnapshot).toContain("Build widgets");
    expect(fast.jobDescriptionParseId).toBe(
      opportunity.currentJdVersion?.currentParseId,
    );

    const deep = await prisma.matchAnalysis.findFirstOrThrow({
      where: { userId, analysisType: "DEEP_MATCH" },
      include: { deepMatchDetail: true, evidenceLinks: true },
    });
    expect(deep.resumeVariantVersionId).toBe(current.id);
    expect(deep.inputHash).toBe("deep-hash");
    expect(deep.deepMatchDetail?.overallScore).toBe(88);
    expect(deep.evidenceLinks[0].requirementTextSnapshot).toBe(
      "Build analytical engines",
    );
    expect(deep.evidenceLinks[0].evidenceContentSnapshot).toBe(SNAPSHOT_TEXT);
    expect(current.sourceMatchAnalysisId).toBe(deep.id);

    const maps = await prisma.legacyMigrationMap.findMany({
      where: { userId },
    });
    expect(maps.length).toBeGreaterThan(0);
    const job = await prisma.job.findFirstOrThrow({ where: { userId } });
    const jobMap = maps.find(
      (m) =>
        m.legacyEntityType === LEGACY.JOB &&
        m.targetEntityType === TARGET.JOB_OPPORTUNITY,
    );
    expect(jobMap?.legacyEntityId).toBe(job.id);
    expect(jobMap?.targetEntityId).toBe(opportunity.id);
    expect(maps.every((m) => m.legacyEntityId !== jobMap?.id)).toBe(true);

    expect(await prisma.dataMigrationRun.count({ where: { userId } })).toBe(0);

    const migrationState = await prisma.abMigrationState.findFirstOrThrow();
    expect(migrationState.status).toBe(AB_MIGRATION_STATUS.COMPLETED);
    expect(migrationState.verifiedAt).not.toBeNull();
    const restoredMode = await resolveCareerRuntimeMode(prisma);
    expect(restoredMode.mode).not.toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(restoredMode.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    const enabledEnv = {
      ...process.env,
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    };
    const flagged = await resolveCareerRuntimeMode(prisma, { env: enabledEnv });
    expect(flagged.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  }, 180_000);

  it("does not duplicate Phase 3 backfill after restore", async () => {
    const beforeOpps = await prisma.jobOpportunity.count({ where: { userId } });
    const beforeMaps = await prisma.legacyMigrationMap.count({
      where: { userId },
    });
    const second = await runLegacyMigration(migrateOpts());
    expect(second.phaseResult).toBe("PASS");
    expect(second.duplicated).toBe(0);
    expect(second.created.opportunities).toBe(0);
    expect(second.created.attempts).toBe(0);
    expect(second.created.resumeVariants).toBe(0);
    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(
      beforeOpps,
    );
    expect(
      await prisma.legacyMigrationMap.count({ where: { userId } }),
    ).toBeGreaterThanOrEqual(beforeMaps);
  }, 180_000);

  it("is semantically stable across backup → restore → backup", async () => {
    const first = await collectBackupData(userId);
    const { buffer } = await buildBackupZip(userId, "phase4@example.com");
    await importBackup(buffer, userId, "phase4@example.com", true);
    const second = await collectBackupData(userId);

    const keys = [
      "Company",
      "JobOpportunity",
      "JobDescriptionVersion",
      "JobDescriptionParse",
      "ApplicationAttempt",
      "ApplicationProcessStep",
      "CareerMaterialItem",
      "CareerEvidence",
      "CandidateProfile",
      "ResumeVariant",
      "ResumeVariantVersion",
      "ResumeExpression",
      "ResumeExpressionEvidence",
      "ResumeArtifact",
      "MatchAnalysis",
      "FastScreeningDetail",
      "DeepMatchDetail",
      "MatchEvidenceLink",
      "LegacyMigrationMap",
      "AbMigrationState",
    ] as const;
    for (const key of keys) {
      expect(second[key].length, key).toBe(first[key].length);
    }
    expect(second.Company[0].notes).toBe(first.Company[0].notes);
    expect(
      second.ResumeExpressionEvidence.map(
        (row) => row.evidenceContentSnapshot,
      ).sort(),
    ).toEqual(
      first.ResumeExpressionEvidence.map(
        (row) => row.evidenceContentSnapshot,
      ).sort(),
    );
    expect(second.MatchAnalysis.map((row) => row.inputHash).sort()).toEqual(
      first.MatchAnalysis.map((row) => row.inputHash).sort(),
    );
  }, 180_000);

  it("wipes stale A+B rows when restoring a v1 archive", async () => {
    const v1Data = BackupDataSchema.parse({
      Company: [
        { id: "c-v1", label: "LegacyCo", value: "legacy-co", logoUrl: null },
      ],
    });
    const v1Body: Record<string, unknown> = {};
    for (const key of [
      "Company",
      "JobTitle",
      "Location",
      "JobSource",
      "Tag",
      "ActivityType",
      "ContactRole",
      "Profile",
      "File",
      "Resume",
      "ContactInfo",
      "Summary",
      "ResumeSection",
      "WorkExperience",
      "Education",
      "LicenseOrCertification",
      "OtherSection",
      "Skill",
      "CoverLetter",
      "Automation",
      "Job",
      "Note",
      "Interview",
      "Contact",
      "JobContact",
      "Task",
      "Question",
      "AutomationRun",
      "UserSettings",
      "_JobToTag",
      "_QuestionToTag",
      "jobStatuses",
      "user",
    ] as const) {
      v1Body[key] = v1Data[key];
    }
    const zip = new JSZip();
    const manifest = {
      ...buildManifest(v1Data, "phase4@example.com"),
      formatVersion: 1,
    };
    zip.file("manifest.json", JSON.stringify(manifest));
    zip.file("data.json", JSON.stringify(v1Body));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: (
          await prisma.company.findFirstOrThrow({
            where: { createdBy: userId },
          })
        ).id,
        title: "Stale leftover",
      },
    });

    await importBackup(bytes, userId, "phase4@example.com", true);

    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(0);
    expect(await prisma.resumeVariant.count({ where: { userId } })).toBe(0);
    expect(await prisma.matchAnalysis.count({ where: { userId } })).toBe(0);
    expect(await prisma.legacyMigrationMap.count({ where: { userId } })).toBe(
      0,
    );
    expect(await prisma.abMigrationState.count()).toBe(0);
    const companies = await prisma.company.findMany({
      where: { createdBy: userId },
    });
    expect(companies.map((c) => c.value)).toEqual(["legacy-co"]);
    expect(companies[0].notes).toBeNull();
  }, 180_000);

  it("fails closed on a dangling deferred FK and does not report success", async () => {
    userId = await seedAccount(prisma, "phase4-fail@example.com");
    await seedPhase4Graph();
    const { buffer } = await buildBackupZip(userId, "phase4-fail@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const beforeOpps = await prisma.jobOpportunity.count({ where: { userId } });
    data.JobOpportunity[0].currentJdVersionId = "missing-jd-version";
    const broken = new JSZip();
    broken.file(
      "manifest.json",
      await zip.file("manifest.json")!.async("string"),
    );
    broken.file("data.json", JSON.stringify(data));
    const bytes = await broken.generateAsync({ type: "nodebuffer" });

    await expect(
      importBackup(bytes, userId, "phase4-fail@example.com", true),
    ).rejects.toBeInstanceOf(BackupError);
    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(
      beforeOpps,
    );
    expect(
      (await prisma.jobOpportunity.findFirstOrThrow({ where: { userId } }))
        .title,
    ).not.toBeUndefined();
  }, 180_000);
});
