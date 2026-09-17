// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  careerReadFamilyFor,
  careerWriteFamilyFor,
  OpportunityService,
  resolveCareerRuntimeMode,
  writeInstanceMigrationState,
} from "@/lib/career";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import { runLegacyMigration } from "@/lib/legacy-migration/migrator";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const dbPath = path.join(ctx.dir, "test.db");

let userId: string;
let companyId: string;
let statusId: string;
let titleId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

async function resetDisposableDb() {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'
  `;
  for (const table of tables) {
    if (table.name === "JobStatus") continue;
    await prisma.$executeRawUnsafe(`DELETE FROM "${table.name}"`);
  }
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
}

beforeEach(async () => {
  await resetDisposableDb();
  userId = await seedAccount(prisma, `phase5-${Date.now()}@example.com`);
  const company = await prisma.company.create({
    data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userId },
  });
  companyId = company.id;
  statusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } })).id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-${Date.now()}`, createdBy: userId },
    })
  ).id;
});

describe("Phase 5 career runtime gates", () => {
  it("defaults to NOT_STARTED / legacy mode", async () => {
    const resolved = await resolveCareerRuntimeMode(prisma);
    expect(resolved.migrationStatus).toBe(AB_MIGRATION_STATUS.NOT_STARTED);
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.legacy);
    expect(careerReadFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.legacy);
  });

  it("blocks A+B while migration is IN_PROGRESS", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.featureEnabled).toBe(true);
  });

  it("blocks A+B while migration is FAILED", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FAILED,
      errorCode: "ROOT_FAILURE",
      completedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
  });

  it("keeps A+B disabled when COMPLETED but feature is off", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma);
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.legacy);
  });

  it("enables A+B only after COMPLETED + feature on + integrity pass", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(careerWriteFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.ab);
  });

  it("does not enable A+B when the feature is on but migration is incomplete", async () => {
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(resolved.reason).toBe("feature-on-migration-incomplete");
  });

  it("blocks COMPLETED state that is missing legacy root mappings", async () => {
    await prisma.job.create({
      data: {
        userId,
        description: "Build widgets",
        jobType: "full-time",
        createdAt: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("UNMAPPED_LEGACY_JOBS");
  });

  it("blocks feature-on COMPLETED when integrity fails", async () => {
    const profile = await prisma.profile.create({ data: { userId } });
    const resume = await prisma.resume.create({
      data: { profileId: profile.id, title: "Primary" },
    });
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.unmappedResumeIds).toContain(resume.id);
  });

  it("blocks A+B rows that exist while migration is NOT_STARTED", async () => {
    await prisma.jobOpportunity.create({
      data: { userId, companyId, title: "Orphan opportunity" },
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("AB_ROWS_WITHOUT_MIGRATION");
  });

  it("records COMPLETED after a successful disposable Phase 3 migration", async () => {
    const profile = await prisma.profile.create({ data: { userId } });
    await prisma.resume.create({
      data: { profileId: profile.id, title: "Primary" },
    });
    await prisma.job.create({
      data: {
        userId,
        description: "Build widgets",
        jobType: "full-time",
        createdAt: new Date(),
        applied: true,
        appliedDate: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });

    const report = await runLegacyMigration({
      dbPath,
      repoRoot: REPO_ROOT,
      mode: "migrate",
      confirmWritable: true,
      allowDisposableCopy: true,
    });
    expect(report.phaseResult).toBe("PASS");

    const state = await prisma.abMigrationState.findFirstOrThrow();
    expect(state.status).toBe(AB_MIGRATION_STATUS.COMPLETED);
    expect(state.verifiedAt).not.toBeNull();

    const off = await resolveCareerRuntimeMode(prisma);
    expect(off.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    const on = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(on.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  }, 120_000);

  it("does not write COMPLETED after a failed Phase 3 migration", async () => {
    const profile = await prisma.profile.create({ data: { userId } });
    await prisma.resume.create({
      data: { profileId: profile.id, title: "Primary" },
    });
    const job = await prisma.job.create({
      data: {
        userId,
        description: "Build widgets",
        jobType: "full-time",
        createdAt: new Date(),
        applied: true,
        appliedDate: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });

    const report = await runLegacyMigration({
      dbPath,
      repoRoot: REPO_ROOT,
      mode: "migrate",
      confirmWritable: true,
      allowDisposableCopy: true,
      hooks: {
        beforeFinishRoot: (kind, legacyId) => {
          if (kind === "Job" && legacyId === job.id) {
            throw new Error("controlled failure");
          }
        },
      },
    });
    expect(report.phaseResult).toBe("FAILED");
    const state = await prisma.abMigrationState.findFirstOrThrow();
    expect(state.status).not.toBe(AB_MIGRATION_STATUS.COMPLETED);
    expect(state.status).toBe(AB_MIGRATION_STATUS.FAILED);
    expect(state.verifiedAt).toBeNull();
  }, 120_000);

  it("routes the runtime to the legacy family before production backfill", async () => {
    const resolved = await resolveCareerRuntimeMode(prisma);
    expect(careerWriteFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.legacy);
    expect(careerReadFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.legacy);
  });

  it("routes to the A+B family only after the complete gate", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(careerWriteFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.ab);
  });

  it("does not dual-write JobOpportunity from a legacy job create", async () => {
    const job = await createJobRecord(
      {
        jobTitleId: titleId,
        companyId,
        statusId,
        description: "legacy job",
        jobType: "full-time",
        userId,
      },
      prisma,
    );
    expect(job.id).toBeTruthy();
    expect(await prisma.jobOpportunity.count()).toBe(0);

    await prisma.job.deleteMany();
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const previous = process.env[AB_RUNTIME_FEATURE_ENV];
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    try {
      await expect(
        createJobRecord(
          {
            jobTitleId: titleId,
            companyId,
            statusId,
            description: "should not write",
            jobType: "full-time",
            userId,
          },
          prisma,
        ),
      ).rejects.toMatchObject({ code: "LEGACY_WRITE_BLOCKED" });
      expect(await prisma.job.count()).toBe(0);
      expect(await prisma.jobOpportunity.count()).toBe(0);

      const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
      await opportunities.create({ companyId, title: "A+B only" });
      expect(await prisma.jobOpportunity.count()).toBe(1);
      expect(await prisma.job.count()).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env[AB_RUNTIME_FEATURE_ENV];
      } else {
        process.env[AB_RUNTIME_FEATURE_ENV] = previous;
      }
    }
  });
});
