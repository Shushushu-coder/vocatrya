// @vitest-environment node
//
// Dashboard graceful degradation for a BLOCKED jobs read family. Runs the
// real server actions against one disposable database: when the runtime
// resolves blocked, jobs reads must surface a typed blocked result (never a
// fabricated zero) while jobs-independent activity reads keep working.
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
  getActivityCalendarData,
  getActivityDataForPeriod,
  getJobsActivityForPeriod,
  getJobsActivitySummary,
  getRecentActivities,
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

async function seedActivity(label = "Deep Work", minutes = 90) {
  const type = await prisma.activityType.create({
    data: { label, value: `at-${randomUUID()}`, createdBy: userId },
  });
  const now = new Date();
  return prisma.activity.create({
    data: {
      userId,
      activityName: label,
      startTime: now,
      endTime: now,
      duration: minutes,
      activityTypeId: type.id,
    },
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

    const [summary, recent, weekly, calendar] = await Promise.all([
      getJobsActivitySummary(7),
      getRecentJobs(),
      getJobsActivityForPeriod(),
      getActivityCalendarData(),
    ]);

    expect(summary.jobsBlocked).toBe(true);
    // Blocked is not a zero: no jobs counts are fabricated.
    expect(summary.jobsApplied).toBeUndefined();
    expect(summary.jobsTrend).toBeUndefined();
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

  it("keeps jobs-independent activity reads working", async () => {
    await blockCareerRuntime();
    await seedActivity("Deep Work", 90);

    const summary = await getJobsActivitySummary(7);
    expect(summary.jobsBlocked).toBe(true);
    expect(summary.topActivities).toEqual([{ label: "Deep Work", hours: 1.5 }]);
    expect(summary.totalHours).toBe(1.5);

    const recentActivities = await getRecentActivities();
    expect(recentActivities).toHaveLength(1);
    expect(recentActivities?.[0]?.activityName).toBe("Deep Work");

    const chart = await getActivityDataForPeriod();
    expect(chart.keys).toEqual(["Deep Work"]);
    expect(chart.data.at(-1)?.["Deep Work"]).toBe(1.5);
  });
});

describe("normal read families", () => {
  it("legacy family keeps the pre-existing result shapes", async () => {
    expect((await resolveJobsReadFamily(prisma)).family).toBe("legacy");
    await seedLegacyJob(new Date());
    await seedActivity("Deep Work", 60);

    const summary = await getJobsActivitySummary(7);
    expect(summary.jobsBlocked).toBe(false);
    if (!summary.jobsBlocked) {
      expect(summary.jobsApplied).toBe(1);
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

    const calendar = await getActivityCalendarData();
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

    const summary = await getJobsActivitySummary(7);
    expect(summary.jobsBlocked).toBe(false);
    if (!summary.jobsBlocked) {
      expect(summary.jobsApplied).toBe(1);
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
    await expect(getRecentJobs()).rejects.toThrow("Failed to fetch jobs list. ");
    jobsFind.mockRestore();

    const groupBy = vi
      .spyOn(prisma.job, "groupBy")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getJobsActivityForPeriod()).rejects.toThrow(
      "Failed to fetch jobs list. ",
    );
    groupBy.mockRestore();

    const activitiesFind = vi
      .spyOn(prisma.activity, "findMany")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getJobsActivitySummary(7)).rejects.toThrow(
      "Failed to fetch jobs and activity summary",
    );
    await expect(getActivityDataForPeriod()).rejects.toThrow(
      "Failed to fetch activities data.",
    );
    activitiesFind.mockRestore();
  });
});
