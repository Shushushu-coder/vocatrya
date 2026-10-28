// @vitest-environment node
//
// Dashboard graceful degradation for a BLOCKED jobs read family. Runs the
// real server actions against one disposable database: when the runtime
// resolves blocked, jobs reads must surface a typed blocked result (never a
// fabricated zero) while jobs-independent task reads keep working.
// Unknown database failures keep failing loudly.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  AB_INSTANCE_SCOPE_KEY,
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));

import { getCurrentUser } from "@/utils/user.utils";
import {
  getJobsActivityForPeriod,
  getJobsBoardTotals,
  getJobsCalendarData,
  getJobStatusDistribution,
  getOverviewReminders,
  getOverviewStats,
  getRecentJobs,
} from "@/actions/dashboard.actions";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";

let prisma: PrismaClient;
let userId: string;

beforeAll(async () => {
  const dbMod = await import("@/lib/db");
  prisma = dbMod.default;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `dash-blocked-${Date.now()}@example.com`);
  (getCurrentUser as any).mockResolvedValue({ id: userId });
});

async function blockCareerRuntime() {
  await prisma.abMigrationState.create({
    data: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      migrationKey: AB_MIGRATION_KEY,
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    },
  });
}

async function seedTask(title = "Open task") {
  return prisma.task.create({
    data: { userId, title, status: "in-progress" },
  });
}

async function seedLegacyJob(appliedDate: Date | null = new Date()) {
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: "applied" },
  });
  const company = await prisma.company.create({
    data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: `jt-${randomUUID()}`, createdBy: userId },
  });
  return prisma.job.create({
    data: {
      userId,
      description: "legacy job",
      jobType: "FT",
      createdAt: new Date(),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: company.id,
      applied: appliedDate !== null,
      appliedDate,
    },
  });
}

describe("composite BLOCKED runtime", () => {
  it("turns every jobs-dependent read into a typed blocked result instead of rejecting", async () => {
    await blockCareerRuntime();
    expect((await resolveJobsReadFamily(prisma)).family).toBe("blocked");

    const [totals, dist, recent, weekly, calendar] = await Promise.all([
      getJobsBoardTotals(),
      getJobStatusDistribution(),
      getRecentJobs(),
      getJobsActivityForPeriod(),
      getJobsCalendarData(),
    ]);

    expect(totals).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
    });
    expect("data" in totals).toBe(false);
    expect(dist).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
    });
    expect("data" in dist).toBe(false);
    expect(recent).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
    });
    expect("data" in recent).toBe(false);
    expect(weekly).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
    });
    expect("data" in weekly).toBe(false);
    expect(calendar).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
    });
    expect("data" in calendar).toBe(false);
  });

  it("keeps jobs-independent task reads working", async () => {
    await blockCareerRuntime();
    await seedTask("Deep Work follow-up");

    const stats = await getOverviewStats();
    expect(stats.jobsBlocked).toBe(true);
    // Blocked is not a zero: no jobs counts are fabricated.
    expect(stats.inProgress).toBeUndefined();
    expect(stats.applied7d).toBeUndefined();
    expect(stats.openTasks).toBe(1);

    const { reminders } = await getOverviewReminders();
    expect(reminders.every((r) => r.kind === "task")).toBe(true);
  });
});

describe("normal read families", () => {
  it("legacy family keeps the pre-existing result shapes", async () => {
    expect((await resolveJobsReadFamily(prisma)).family).toBe("legacy");
    await seedLegacyJob(new Date());

    const stats = await getOverviewStats();
    expect(stats.jobsBlocked).toBe(false);
    if (!stats.jobsBlocked) {
      expect(stats.applied7d).toBe(1);
    }

    const recent = await getRecentJobs();
    expect(recent.blocked).toBe(false);
    if (!recent.blocked) {
      expect(recent.data).toHaveLength(1);
    }

    const weekly = await getJobsActivityForPeriod();
    expect(weekly.blocked).toBe(false);
    if (!weekly.blocked) {
      const total = weekly.data.reduce(
        (sum: number, row: { value: number }) => sum + row.value,
        0,
      );
      expect(total).toBe(1);
    }

    const calendar = await getJobsCalendarData();
    expect(calendar.blocked).toBe(false);
    if (!calendar.blocked) {
      const year = new Date().getFullYear().toString();
      expect(calendar.data[year]?.some((row) => row.value === 1)).toBe(true);
    }
  });

  it("ab family keeps the dashboard reads unchanged", async () => {
    vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
    vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
    await activateFreshAbNative(prisma);
    expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");

    const company = await prisma.company.create({
      data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "Engineer" },
    });
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "TEST",
        submittedAt: new Date(),
        currentStageCategory: "SUBMITTED",
        outcome: "ACTIVE",
      },
    });

    const stats = await getOverviewStats();
    expect(stats.jobsBlocked).toBe(false);
    if (!stats.jobsBlocked) {
      expect(stats.applied7d).toBe(1);
    }

    const recent = await getRecentJobs();
    expect(recent.blocked).toBe(false);
    if (!recent.blocked) {
      expect(recent.data.map((row: { id: string }) => row.id)).toContain(
        opportunity.id,
      );
    }
  });
});

describe("non-blocked failures", () => {
  it("real database errors still reject and are never disguised as empty data", async () => {
    const jobsFind = vi
      .spyOn(prisma.job, "findMany")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getRecentJobs()).rejects.toThrow(
      "Failed to fetch jobs list. ",
    );
    jobsFind.mockRestore();

    const groupBy = vi
      .spyOn(prisma.job, "groupBy")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getJobsActivityForPeriod()).rejects.toThrow(
      "Failed to fetch jobs list. ",
    );
    groupBy.mockRestore();
  });
});
