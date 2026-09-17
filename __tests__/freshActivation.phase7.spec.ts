// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_KEY,
  activateFreshAbNative,
  checkFreshAbEligibility,
  resolveCareerRuntimeMode,
  writeInstanceMigrationState,
} from "@/lib/career";
import { executeFreshInitCommand } from "@/lib/career/freshCommand";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const dbPath = `${ctx.dir.replace(/\\/g, "/")}/test.db`;

let userId: string;
let companyId: string;
let statusId: string;

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
  userId = await seedAccount(prisma, `phase7-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userId },
    })
  ).id;
  statusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } }))
    .id;
});

describe("Phase 7 fresh activation", () => {
  it("treats an empty domain DB as eligible", async () => {
    await resetDisposableDb();
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.legacyDomainRowCounts.job).toBe(0);
    expect(eligibility.legacyDomainRowCounts.resume).toBe(0);
    expect(eligibility.abDomainRowCounts.jobOpportunity).toBe(0);
    expect(eligibility.migrationBookkeepingCounts.LegacyMigrationMap).toBe(0);
  });

  it("treats auth bootstrap data as eligible", async () => {
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockers).toEqual([]);
  });

  it("rejects a legacy Job", async () => {
    const title = await prisma.jobTitle.create({
      data: { label: "Eng", value: `eng-${Date.now()}`, createdBy: userId },
    });
    await prisma.job.create({
      data: {
        userId,
        description: "Build widgets",
        jobType: "full-time",
        createdAt: new Date(),
        statusId,
        jobTitleId: title.id,
        companyId,
      },
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers.some((row) => row.startsWith("LEGACY_DOMAIN:job"))).toBe(
      true,
    );
  });

  it("rejects a legacy Resume", async () => {
    const profile = await prisma.profile.create({ data: { userId } });
    await prisma.resume.create({
      data: { profileId: profile.id, title: "Primary" },
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(
      eligibility.blockers.some((row) => row.startsWith("LEGACY_DOMAIN:resume")),
    ).toBe(true);
  });

  it("rejects unexplained A+B data", async () => {
    await prisma.jobOpportunity.create({
      data: { userId, companyId, title: "Orphan" },
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toContain("AB_DATA_WITHOUT_RECOGNIZED_STATE");
  });

  it("rejects IN_PROGRESS migration state", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toContain("MIGRATION_IN_PROGRESS");
  });

  it("rejects FAILED migration state", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FAILED,
      errorCode: "ROOT_FAILURE",
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toContain("MIGRATION_FAILED");
  });

  it("activates FRESH_READY without writing COMPLETED", async () => {
    const first = await activateFreshAbNative(prisma);
    expect(first.created).toBe(1);
    expect(first.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    const row = await prisma.abMigrationState.findFirstOrThrow();
    expect(row.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(row.status).not.toBe(AB_MIGRATION_STATUS.COMPLETED);
    expect(row.migrationKey).toBe(FRESH_NATIVE_KEY);
    expect(row.completedAt).toBeNull();
    expect(row.verifiedAt).not.toBeNull();
  });

  it("is idempotent on a second activation", async () => {
    const first = await activateFreshAbNative(prisma);
    const second = await activateFreshAbNative(prisma);
    expect(second.created).toBe(0);
    expect(second.idempotent).toBe(true);
    expect(second.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(second.verifiedAt?.getTime()).toBe(first.verifiedAt?.getTime());
    expect(await prisma.abMigrationState.count()).toBe(1);
  });

  it("rejects a malformed FRESH_READY state", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FRESH_READY,
      migrationKey: "wrong-origin",
      verifiedAt: new Date(),
    });
    const eligibility = await checkFreshAbEligibility(prisma);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toContain("FRESH_STATE_KEY_MISMATCH");
    await expect(activateFreshAbNative(prisma)).rejects.toMatchObject({
      code: "FRESH_ACTIVATION_REJECTED",
    });
  });

  it("refuses --force and defaults to check-only", async () => {
    const forced = await executeFreshInitCommand({
      argv: ["--confirm", "--force"],
      repoRoot: process.cwd(),
    });
    expect(forced.exitCode).toBe(2);
    expect(forced.writesAttempted).toBe(false);

    const checked = await executeFreshInitCommand({
      argv: [`--db=${dbPath}`],
      repoRoot: process.cwd(),
    });
    expect(checked.writesAttempted).toBe(false);
    expect(checked.stdout).toContain("eligible=true");
    expect(await prisma.abMigrationState.count()).toBe(0);
  });

  it("refuses to activate a sibling database", async () => {
    const result = await executeFreshInitCommand({
      argv: ["--confirm", `--db=${dbPath}`],
      repoRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.writesAttempted).toBe(false);
    expect(result.stdout).toContain("may only mutate");
    expect(await prisma.abMigrationState.count()).toBe(0);
  });

  it("does not enable A+B from the feature flag alone", async () => {
    const off = await resolveCareerRuntimeMode(prisma);
    expect(off.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    const on = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(on.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(on.writeFamily).toBe(CAREER_WRITE_FAMILY.legacy);
  });
});
