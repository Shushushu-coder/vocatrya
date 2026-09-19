// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_KEY,
  activateFreshAbNative,
  assertLegacyCareerWriteAllowed,
  careerReadFamilyFor,
  careerWriteFamilyFor,
  resolveCareerRuntimeMode,
  writeInstanceMigrationState,
} from "@/lib/career";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

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

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `phase7-rt-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-rt-${Date.now()}`, createdBy: userId },
    })
  ).id;
  statusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } }))
    .id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-rt-${Date.now()}`, createdBy: userId },
    })
  ).id;
});

describe("Phase 7 runtime resolver and write protection", () => {
  it("stays LEGACY_ONLY with no state even if the feature is on", async () => {
    const off = await resolveCareerRuntimeMode(prisma);
    expect(off.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    const on = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(on.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
  });

  it("resolves FRESH_READY + gate off to AB_READY_DISABLED with blocked writes", async () => {
    await activateFreshAbNative(prisma);
    const resolved = await resolveCareerRuntimeMode(prisma);
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.migrationStatus).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(careerWriteFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(careerReadFamilyFor(resolved.mode)).toBe(CAREER_WRITE_FAMILY.ab);
  });

  it("enables A+B for FRESH_READY + gate on + integrity pass", async () => {
    await activateFreshAbNative(prisma);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(resolved.integrity.ok).toBe(true);
  });

  it("blocks FRESH_READY when legacy jobs appear", async () => {
    await activateFreshAbNative(prisma);
    await prisma.job.create({
      data: {
        userId,
        description: "pollution",
        jobType: "full-time",
        createdAt: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("FRESH_HAS_LEGACY_JOBS");
  });

  it("blocks FRESH_READY when another legacy career row appears", async () => {
    await activateFreshAbNative(prisma);
    const profile = await prisma.profile.create({ data: { userId } });
    await prisma.coverLetter.create({
      data: { profileId: profile.id, title: "Pollution", content: "Legacy" },
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("FRESH_HAS_LEGACY_CAREER_ROWS");
  });

  it("blocks readiness states whose migration origin is mismatched", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FRESH_READY,
      migrationKey: "phase-3-key",
      verifiedAt: new Date(),
    });
    const fresh = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(fresh.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(fresh.integrity.code).toBe("MIGRATION_STATE_ORIGIN_MISMATCH");

    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      migrationKey: FRESH_NATIVE_KEY,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const migrated = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(migrated.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(migrated.integrity.code).toBe("MIGRATION_STATE_ORIGIN_MISMATCH");
  });

  it("does not require LegacyMigrationMap for FRESH_READY integrity", async () => {
    await activateFreshAbNative(prisma);
    expect(await prisma.legacyMigrationMap.count()).toBe(0);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(resolved.integrity.ok).toBe(true);
  });

  it("keeps COMPLETED semantics", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const off = await resolveCareerRuntimeMode(prisma);
    expect(off.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    const on = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(on.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  });

  it("allows legacy writers only in LEGACY_ONLY", async () => {
    await expect(assertLegacyCareerWriteAllowed(prisma)).resolves.toBeUndefined();
    await createJobRecord(
      {
        jobTitleId: titleId,
        companyId,
        statusId,
        description: "legacy ok",
        jobType: "full-time",
        userId,
      },
      prisma,
    );
    expect(await prisma.job.count()).toBe(1);
  });

  it("rejects legacy writers when ready-but-disabled, enabled, or blocked", async () => {
    await activateFreshAbNative(prisma);
    await expect(assertLegacyCareerWriteAllowed(prisma)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });

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

    await expect(
      assertLegacyCareerWriteAllowed(prisma, FEATURE_ON),
    ).rejects.toMatchObject({ code: "LEGACY_WRITE_BLOCKED" });

    await prisma.job.create({
      data: {
        userId,
        description: "pollution",
        jobType: "full-time",
        createdAt: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });
    await expect(
      assertLegacyCareerWriteAllowed(prisma, FEATURE_ON),
    ).rejects.toMatchObject({ code: "CAREER_RUNTIME_BLOCKED" });
  });
});
