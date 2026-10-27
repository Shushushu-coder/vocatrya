// @vitest-environment node
//
// Dashboard V2 reads (overview metrics/reminders, board totals, status
// distribution) against a disposable database in each read family. These
// cover the shared contract the new pages rely on: real counts in legacy and
// A+B, and a typed blocked result — never fabricated zeros — when the jobs
// family is unavailable.
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
  getJobStatusDistribution,
  getJobsBoardTotals,
  getOverviewReminders,
  getOverviewStats,
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
  userId = await seedAccount(prisma, `dash-v2-${Date.now()}@example.com`);
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

async function statusIdOf(value: string): Promise<string> {
  const status = await prisma.jobStatus.findFirstOrThrow({ where: { value } });
  return status.id;
}

async function seedLegacyJob(options: {
  status: string;
  applied?: boolean;
  appliedDate?: Date | null;
  dueDate?: Date | null;
  discoveryStatus?: string | null;
}) {
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
      statusId: await statusIdOf(options.status),
      jobTitleId: title.id,
      companyId: company.id,
      applied: options.applied ?? false,
      appliedDate: options.appliedDate ?? null,
      dueDate: options.dueDate ?? null,
      discoveryStatus: options.discoveryStatus ?? null,
    },
  });
}

async function seedTask(options: {
  title: string;
  status?: string;
  dueDate?: Date | null;
}) {
  return prisma.task.create({
    data: {
      userId,
      title: options.title,
      status: options.status ?? "in-progress",
      dueDate: options.dueDate ?? null,
    },
  });
}

async function seedActivityIn(hoursFromNow: number) {
  const type = await prisma.activityType.create({
    data: { label: "Deep Work", value: `at-${randomUUID()}`, createdBy: userId },
  });
  const start = new Date(Date.now() + hoursFromNow * 3_600_000);
  return prisma.activity.create({
    data: {
      userId,
      activityName: "Deep Work",
      startTime: start,
      activityTypeId: type.id,
    },
  });
}

const DAYS = 24 * 3_600_000;

describe("legacy read family", () => {
  it("counts board totals per position across statuses", async () => {
    expect((await resolveJobsReadFamily(prisma)).family).toBe("legacy");
    await seedLegacyJob({
      status: "applied",
      applied: true,
      appliedDate: new Date(),
    });
    await seedLegacyJob({ status: "interview" });
    await seedLegacyJob({ status: "offer" });
    await seedLegacyJob({ status: "rejected" });
    // Dismissed discoveries are hidden from every jobs surface.
    await seedLegacyJob({ status: "new", discoveryStatus: "dismissed" });

    const totals = await getJobsBoardTotals();
    expect(totals.blocked).toBe(false);
    if (totals.blocked) return;
    expect(totals.data).toEqual({
      total: 4,
      applied: 1,
      interviews: 1,
      offers: 1,
      inProgress: 3,
    });
  });

  it("breaks positions down by status", async () => {
    await seedLegacyJob({ status: "new" });
    await seedLegacyJob({ status: "new" });
    await seedLegacyJob({ status: "applied", applied: true });

    const dist = await getJobStatusDistribution();
    expect(dist.blocked).toBe(false);
    if (dist.blocked) return;
    expect(dist.data).toEqual([
      { status: "new", count: 2 },
      { status: "applied", count: 1 },
    ]);
  });

  it("reports overview metrics from real rows", async () => {
    await seedLegacyJob({
      status: "applied",
      applied: true,
      appliedDate: new Date(),
    });
    await seedLegacyJob({ status: "interview" });
    await seedLegacyJob({ status: "rejected" });
    await seedTask({ title: "Open" });
    await seedTask({ title: "Done", status: "complete" });
    await seedActivityIn(24);
    await seedActivityIn(24 * 30); // outside the 7d window

    const stats = await getOverviewStats();
    expect(stats.jobsBlocked).toBe(false);
    if (stats.jobsBlocked) return;
    expect(stats.inProgress).toBe(2);
    expect(stats.applied7d).toBe(1);
    expect(stats.openTasks).toBe(1);
    expect(stats.upcomingActivities).toBe(1);
  });

  it("surfaces due tasks and application deadlines as reminders", async () => {
    const soon = new Date(Date.now() + 2 * DAYS);
    const later = new Date(Date.now() + 30 * DAYS);
    const overdueTask = await seedTask({
      title: "Overdue",
      dueDate: new Date(Date.now() - DAYS),
    });
    await seedTask({ title: "Due soon", dueDate: soon });
    await seedTask({ title: "Later", dueDate: later });
    await seedTask({ title: "Done", status: "complete", dueDate: soon });
    const job = await seedLegacyJob({ status: "new", dueDate: soon });
    await seedLegacyJob({ status: "rejected", dueDate: soon });
    await seedLegacyJob({ status: "new", dueDate: later });

    const { reminders } = await getOverviewReminders();
    const kinds = Object.fromEntries(reminders.map((r) => [r.id, r.kind]));
    expect(kinds[`task:${overdueTask.id}`]).toBe("task");
    expect(kinds[`deadline:${job.id}`]).toBe("deadline");
    expect(reminders.find((r) => r.id === `task:${overdueTask.id}`)?.overdue)
      .toBe(true);
    expect(reminders).toHaveLength(3);
    expect(reminders.map((r) => r.title)).not.toContain("Later");
    expect(reminders.map((r) => r.title)).not.toContain("Done");
  });

  it("returns an empty reminder list when nothing is due", async () => {
    await seedTask({ title: "No due date" });
    expect((await getOverviewReminders()).reminders).toEqual([]);
  });

  it("limits mixed DateOnly and instant reminders after their attention sort", async () => {
    const { addDaysToDateOnly, todayDateOnly } = await import("@/lib/datetime");
    const { getUserTimeZone } = await import("@/lib/userSettings/timeZone.server");
    const zone = await getUserTimeZone(userId);
    const tomorrow = addDaysToDateOnly(todayDateOnly(zone), 1);
    await prisma.task.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        userId,
        title: `Tomorrow ${i}`,
        status: "in-progress",
        dueOn: tomorrow,
        duePrecision: "dateOnly",
      })),
    });
    const overdue = await seedTask({
      title: "Earlier instant",
      dueDate: new Date(Date.now() - DAYS),
    });
    const { reminders } = await getOverviewReminders();
    expect(reminders).toHaveLength(6);
    expect(reminders[0]).toMatchObject({ id: `task:${overdue.id}`, overdue: true });
  });
});

describe("ab read family", () => {
  async function activate() {
    vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
    vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
    await activateFreshAbNative(prisma);
    expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
  }

  async function seedOpportunity(options: {
    attempts: Array<{
      submittedAt?: Date | null;
      stage?: string;
      outcome?: string;
    }>;
    interviewSteps?: number;
    archived?: boolean;
  }) {
    const company = await prisma.company.create({
      data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "Engineer",
        archivedAt: options.archived ? new Date() : null,
      },
    });
    const createdIds: string[] = [];
    for (const attempt of options.attempts) {
      const created = await prisma.applicationAttempt.create({
        data: {
          userId,
          jobOpportunityId: opportunity.id,
          channelLabel: "TEST",
          submittedAt: attempt.submittedAt ?? null,
          currentStageCategory: attempt.stage ?? "DRAFT",
          outcome: attempt.outcome ?? "ACTIVE",
        },
      });
      createdIds.push(created.id);
    }
    for (let i = 0; i < (options.interviewSteps ?? 0); i++) {
      await prisma.applicationProcessStep.create({
        data: {
          applicationAttemptId: createdIds[0],
          category: "INTERVIEW",
          label: `Interview ${i + 1}`,
          sortOrder: i,
        },
      });
    }
    return opportunity;
  }

  it("derives totals from attempts and process steps, deduped per position", async () => {
    await activate();
    // Two attempts on one opportunity still count once; a draft doesn't.
    await seedOpportunity({
      attempts: [
        { submittedAt: new Date(), stage: "SUBMITTED" },
        { stage: "DRAFT" },
      ],
      interviewSteps: 2,
    });
    await seedOpportunity({ attempts: [{ stage: "DRAFT" }] });
    await seedOpportunity({
      attempts: [{ submittedAt: new Date(), stage: "OFFER", outcome: "OFFER" }],
    });
    await seedOpportunity({ attempts: [], archived: true });

    const totals = await getJobsBoardTotals();
    expect(totals.blocked).toBe(false);
    if (totals.blocked) return;
    expect(totals.data).toEqual({
      total: 3,
      applied: 2,
      interviews: 2,
      offers: 1,
      inProgress: 3,
    });
  });

  it("derives the status breakdown from uiStatus", async () => {
    await activate();
    await seedOpportunity({ attempts: [{ stage: "DRAFT" }] });
    await seedOpportunity({
      attempts: [{ submittedAt: new Date(), stage: "INTERVIEW" }],
    });
    await seedOpportunity({
      attempts: [{ submittedAt: new Date(), stage: "CLOSED", outcome: "REJECTED" }],
    });

    const dist = await getJobStatusDistribution();
    expect(dist.blocked).toBe(false);
    if (dist.blocked) return;
    const counts = Object.fromEntries(
      dist.data.map((row) => [row.status, row.count]),
    );
    expect(counts["draft"]).toBe(1);
    expect(counts["interview"]).toBe(1);
    expect(counts["rejected"]).toBe(1);
  });

  it("surfaces upcoming application events as reminders", async () => {
    await activate();
    const opportunity = await seedOpportunity({ attempts: [] });
    await prisma.jobOpportunity.update({
      where: { id: opportunity.id },
      data: { deadline: new Date(Date.now() + 3 * DAYS) },
    });

    const { reminders } = await getOverviewReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      kind: "deadline",
      title: "Engineer",
      detail: "Acme",
      overdue: false,
    });
  });

  it("labels the time carrier that supplies a process reminder's attention", async () => {
    await activate();
    const { addDaysToDateOnly, dateOnlyUtcWindow, todayDateOnly } = await import("@/lib/datetime");
    const { getUserTimeZone } = await import("@/lib/userSettings/timeZone.server");
    const zone = await getUserTimeZone(userId);
    const deadlineOn = addDaysToDateOnly(todayDateOnly(zone), 3);
    const deadlineStart = dateOnlyUtcWindow(deadlineOn, zone).startIso;
    const scheduledAt = new Date(Date.now() + DAYS);
    const opportunity = await seedOpportunity({ attempts: [{ stage: "DRAFT" }] });
    const attempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { jobOpportunityId: opportunity.id },
    });
    const step = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: "INTERVIEW",
        label: "Interview before deadline",
        sortOrder: 1,
        scheduledAt,
        scheduledAtPrecision: "minute",
        deadlineOn,
        deadlinePrecision: "dateOnly",
      },
    });
    expect((await getOverviewReminders()).reminders).toEqual([
      expect.objectContaining({
        id: `event:${step.id}`, at: scheduledAt.toISOString(), dateOn: null,
      }),
    ]);
    await prisma.applicationProcessStep.update({
      where: { id: step.id },
      data: { scheduledAt: new Date(new Date(deadlineStart).getTime() + 3_600_000) },
    });
    expect((await getOverviewReminders()).reminders).toEqual([
      expect.objectContaining({ id: `event:${step.id}`, at: deadlineStart, dateOn: deadlineOn }),
    ]);
  });
});

describe("blocked read family", () => {
  it("returns typed blocked results while task/activity metrics stay real", async () => {
    await blockCareerRuntime();
    await seedTask({ title: "Open" });
    await seedActivityIn(24);

    const [totals, dist, stats] = await Promise.all([
      getJobsBoardTotals(),
      getJobStatusDistribution(),
      getOverviewStats(),
    ]);

    expect(totals).toMatchObject({ blocked: true });
    expect(dist).toMatchObject({ blocked: true });
    expect(stats.jobsBlocked).toBe(true);
    // Blocked is not a zero.
    expect(stats.inProgress).toBeUndefined();
    expect(stats.applied7d).toBeUndefined();
    expect(stats.openTasks).toBe(1);
    expect(stats.upcomingActivities).toBe(1);

    // The reminder strip degrades to task reminders only.
    const { reminders } = await getOverviewReminders();
    expect(reminders.every((r) => r.kind === "task")).toBe(true);
  });
});
