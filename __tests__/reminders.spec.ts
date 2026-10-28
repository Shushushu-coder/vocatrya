// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_STATUS,
  activateFreshAbNative,
} from "@/lib/career";
import {
  claimDueReminders,
  expireStaleReminders,
  reconcileReminders,
} from "@/lib/reminders/reminderService";
import {
  computeJobDueReminder,
  computeProcessStepReminder,
  DEFAULT_NOTIFICATION_LEAD_MINUTES,
  notificationPrefsFromDocument,
  normalizeNotificationLeadMinutes,
  REMINDER_OVERDUE_WINDOW_MS,
  REMINDER_SOURCE_TYPE,
  REMINDER_STATUS,
  type JobDueReminderSource,
  type NotificationPrefs,
  type ProcessStepReminderSource,
} from "@/lib/reminders/shared";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;
let jobTitleId: string;

const PREFS: NotificationPrefs = {
  enabled: true,
  leadMinutes: DEFAULT_NOTIFICATION_LEAD_MINUTES,
  locale: "zh-CN",
};

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
  userId = await seedAccount(
    prisma,
    `rem-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-rem-${Date.now()}-${Math.random()}`,
        createdBy: userId,
      },
    })
  ).id;
  jobTitleId = (
    await prisma.jobTitle.create({
      data: {
        label: "Staff Engineer",
        value: `staff-engineer-${Date.now()}-${Math.random()}`,
        createdBy: userId,
      },
    })
  ).id;
  await activateFreshAbNative(prisma);
});

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunityWithStep(input: { scheduledAt?: Date | null } = {}) {
  const { applications, opportunities } = services();
  const opportunity = await opportunities.create({
    companyId,
    title: "Staff Engineer",
  });
  await applications.createAttempt({
    jobOpportunityId: opportunity.id,
    channelLabel: "Portal",
  });
  const step = await applications.createUserProcessStep({
    jobOpportunityId: opportunity.id,
    category: PROCESS_STEP_CATEGORY.INTERVIEW,
    label: "Round 1",
    scheduledAt: input.scheduledAt ?? null,
  });
  return { opportunity, step };
}

async function reminderForStep(stepId: string) {
  return prisma.reminder.findUnique({
    where: {
      userId_sourceType_targetId: {
        userId,
        sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
        targetId: stepId,
      },
    },
  });
}

async function reminderForJob(jobId: string) {
  return prisma.reminder.findUnique({
    where: {
      userId_sourceType_targetId: {
        userId,
        sourceType: REMINDER_SOURCE_TYPE.JOB_DUE,
        targetId: jobId,
      },
    },
  });
}

function stepSource(overrides: Partial<ProcessStepReminderSource> = {}): ProcessStepReminderSource {
  return {
    id: "step-1",
    label: "Round 1",
    status: "PENDING",
    scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    completedAt: null,
    applicationAttempt: {
      archivedAt: null,
      outcome: "ACTIVE",
      jobOpportunity: {
        id: "opp-1",
        title: "Staff Engineer",
        archivedAt: null,
        company: { label: "Acme" },
      },
    },
    ...overrides,
  };
}

function jobSource(overrides: Partial<JobDueReminderSource> = {}): JobDueReminderSource {
  return {
    id: "job-1",
    dueDate: new Date("2026-11-01T06:00:00.000Z"),
    discoveryStatus: null,
    Status: { value: "new" },
    JobTitle: { label: "Staff Engineer" },
    Company: { label: "Acme" },
    ...overrides,
  };
}

async function createJob(input: { dueDate?: Date | null; statusValue?: string } = {}) {
  const status = await prisma.jobStatus.findUniqueOrThrow({
    where: { value: input.statusValue ?? "new" },
  });
  return prisma.job.create({
    data: {
      userId,
      description: "test job",
      jobType: "full-time",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      dueDate: input.dueDate ?? null,
      statusId: status.id,
      jobTitleId,
      companyId,
    },
  });
}

describe("reminder prefs and payload cleaning", () => {
  it("falls back to defaults on a missing or corrupt notifications block", () => {
    expect(notificationPrefsFromDocument({})).toEqual({
      enabled: true,
      leadMinutes: DEFAULT_NOTIFICATION_LEAD_MINUTES,
      locale: "zh-CN",
    });
    expect(
      notificationPrefsFromDocument({
        settings: { notifications: { enabled: "yes", leadMinutes: 7 } },
      }),
    ).toMatchObject({ enabled: true, leadMinutes: DEFAULT_NOTIFICATION_LEAD_MINUTES });
    expect(
      notificationPrefsFromDocument({
        settings: {
          notifications: { enabled: false, leadMinutes: 60 },
          general: { locale: "en" },
        },
      }),
    ).toEqual({ enabled: false, leadMinutes: 60, locale: "en" });
  });

  it("only accepts the supported minute presets", () => {
    expect(normalizeNotificationLeadMinutes(7)).toBe(
      DEFAULT_NOTIFICATION_LEAD_MINUTES,
    );
    expect(normalizeNotificationLeadMinutes("30")).toBe(
      DEFAULT_NOTIFICATION_LEAD_MINUTES,
    );
    expect(normalizeNotificationLeadMinutes(1440)).toBe(1440);
    expect(normalizeNotificationLeadMinutes(0)).toBe(0);
  });

  it("computes a step reminder from the scheduled anchor minus lead time", () => {
    const payload = computeProcessStepReminder(stepSource(), PREFS)!;
    expect(payload.anchorAt).toEqual(new Date("2026-11-01T06:00:00.000Z"));
    expect(payload.fireAt).toEqual(new Date("2026-11-01T05:30:00.000Z"));
    expect(payload.title).toBe("Round 1");
    expect(payload.body).toBe("Acme · Staff Engineer");
    expect(payload.deepLink).toBe("/dashboard/myjobs/opp-1");
  });

  it.each([
    ["no anchor", { scheduledAt: null }],
    ["completed", { completedAt: new Date() }],
    ["cancelled status", { status: PROCESS_STEP_STATUS.CANCELLED }],
    [
      "terminal outcome",
      {
        applicationAttempt: {
          archivedAt: null,
          outcome: "REJECTED",
          jobOpportunity: {
            id: "opp-1",
            title: "Staff Engineer",
            archivedAt: null,
            company: { label: "Acme" },
          },
        },
      },
    ],
    [
      "archived opportunity",
      {
        applicationAttempt: {
          archivedAt: null,
          outcome: "ACTIVE",
          jobOpportunity: {
            id: "opp-1",
            title: "Staff Engineer",
            archivedAt: new Date(),
            company: { label: "Acme" },
          },
        },
      },
    ],
  ])("returns null for %s", (_name, overrides) => {
    expect(
      computeProcessStepReminder(stepSource(overrides), PREFS),
    ).toBeNull();
  });

  it("computes a job-due reminder and rejects concluded jobs", () => {
    const payload = computeJobDueReminder(jobSource(), PREFS)!;
    expect(payload.title).toBe("申请截止提醒");
    expect(payload.body).toBe("Staff Engineer · Acme");
    expect(payload.deepLink).toBe("/dashboard/myjobs/job-1");
    expect(computeJobDueReminder(jobSource({ dueDate: null }), PREFS)).toBeNull();
    expect(
      computeJobDueReminder(
        jobSource({ Status: { value: "rejected" } }),
        PREFS,
      ),
    ).toBeNull();
    expect(
      computeJobDueReminder(jobSource({ discoveryStatus: "dismissed" }), PREFS),
    ).toBeNull();
  });
});

describe("process-step write-path sync", () => {
  it("creates a PENDING reminder when a step has a scheduled anchor", async () => {
    const anchor = new Date("2026-11-01T06:00:00.000Z");
    const { step } = await createOpportunityWithStep({ scheduledAt: anchor });
    const reminder = await reminderForStep(step.id);
    expect(reminder).not.toBeNull();
    expect(reminder!.status).toBe(REMINDER_STATUS.PENDING);
    expect(reminder!.anchorAt).toEqual(anchor);
    expect(reminder!.fireAt).toEqual(
      new Date(anchor.getTime() - DEFAULT_NOTIFICATION_LEAD_MINUTES * 60_000),
    );
    expect(reminder!.deepLink).toMatch(/^\/dashboard\/myjobs\//);
  });

  it("creates nothing for a step without a schedule", async () => {
    const { step } = await createOpportunityWithStep({});
    expect(await reminderForStep(step.id)).toBeNull();
  });

  it("retargets the reminder on reschedule", async () => {
    const { applications } = services();
    const { step } = await createOpportunityWithStep({
      scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    });
    const later = new Date("2026-12-01T06:00:00.000Z");
    await applications.updateUserProcessStep({ stepId: step.id, scheduledAt: later });
    const reminder = await reminderForStep(step.id);
    expect(reminder!.status).toBe(REMINDER_STATUS.PENDING);
    expect(reminder!.anchorAt).toEqual(later);
  });

  it("cancels the reminder on complete, cancel, and delete", async () => {
    const { applications } = services();
    const anchor = new Date("2026-11-01T06:00:00.000Z");

    const done = await createOpportunityWithStep({ scheduledAt: anchor });
    await applications.completeProcessStep(done.step.id);
    expect((await reminderForStep(done.step.id))!.status).toBe(
      REMINDER_STATUS.CANCELLED,
    );

    const cancelled = await createOpportunityWithStep({ scheduledAt: anchor });
    await applications.cancelProcessStep(cancelled.step.id);
    expect((await reminderForStep(cancelled.step.id))!.status).toBe(
      REMINDER_STATUS.CANCELLED,
    );

    const deleted = await createOpportunityWithStep({ scheduledAt: anchor });
    await applications.deleteUserProcessStep(deleted.step.id);
    expect((await reminderForStep(deleted.step.id))!.status).toBe(
      REMINDER_STATUS.CANCELLED,
    );
  });

  it("cancels the reminder when the schedule is cleared", async () => {
    const { applications } = services();
    const { step } = await createOpportunityWithStep({
      scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    });
    await applications.updateUserProcessStep({ stepId: step.id, scheduledAt: null });
    expect((await reminderForStep(step.id))!.status).toBe(
      REMINDER_STATUS.CANCELLED,
    );
  });

  it("never rewrites a FIRED reminder", async () => {
    const { applications } = services();
    const { step } = await createOpportunityWithStep({
      scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    });
    await prisma.reminder.updateMany({
      where: { targetId: step.id },
      data: { status: REMINDER_STATUS.FIRED, firedAt: new Date() },
    });
    await applications.updateUserProcessStep({
      stepId: step.id,
      scheduledAt: new Date("2026-12-01T06:00:00.000Z"),
    });
    const reminder = await reminderForStep(step.id);
    expect(reminder!.status).toBe(REMINDER_STATUS.FIRED);
    expect(reminder!.anchorAt).toEqual(new Date("2026-11-01T06:00:00.000Z"));
  });
});

describe("reconcile sweep", () => {
  it("picks up a step written outside the hooked service paths", async () => {
    const { opportunity } = await createOpportunityWithStep({});
    const attempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { jobOpportunityId: opportunity.id },
    });
    // Simulates the legacy-migration / import paths that insert steps
    // directly without going through ApplicationService.
    const direct = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "Direct insert",
        status: PROCESS_STEP_STATUS.PENDING,
        sortOrder: 99,
        scheduledAt: new Date("2026-11-05T06:00:00.000Z"),
        source: "IMPORT",
      },
    });
    expect(await reminderForStep(direct.id)).toBeNull();
    await reconcileReminders(prisma, userId);
    expect((await reminderForStep(direct.id))!.status).toBe(
      REMINDER_STATUS.PENDING,
    );
  });

  it("syncs legacy Job.dueDate and cancels when the anchor is gone", async () => {
    const job = await createJob({ dueDate: new Date("2026-11-10T06:00:00.000Z") });
    await reconcileReminders(prisma, userId);
    const created = await reminderForJob(job.id);
    expect(created!.status).toBe(REMINDER_STATUS.PENDING);
    expect(created!.sourceType).toBe(REMINDER_SOURCE_TYPE.JOB_DUE);

    await prisma.job.update({ where: { id: job.id }, data: { dueDate: null } });
    await reconcileReminders(prisma, userId);
    expect((await reminderForJob(job.id))!.status).toBe(
      REMINDER_STATUS.CANCELLED,
    );
  });

  it("skips terminal-status and dismissed jobs", async () => {
    const rejected = await createJob({
      dueDate: new Date("2026-11-10T06:00:00.000Z"),
      statusValue: "rejected",
    });
    const dismissed = await prisma.job.update({
      where: {
        id: (
          await createJob({ dueDate: new Date("2026-11-10T06:00:00.000Z") })
        ).id,
      },
      data: { discoveryStatus: "dismissed" },
    });
    await reconcileReminders(prisma, userId);
    expect(await reminderForJob(rejected.id)).toBeNull();
    expect(await reminderForJob(dismissed.id)).toBeNull();
  });

  it("revives an EXPIRED reminder when the step is rescheduled", async () => {
    const { applications } = services();
    const { step } = await createOpportunityWithStep({
      scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    });
    await prisma.reminder.updateMany({
      where: { targetId: step.id },
      data: { status: REMINDER_STATUS.EXPIRED },
    });
    const later = new Date("2026-12-15T06:00:00.000Z");
    await applications.updateUserProcessStep({ stepId: step.id, scheduledAt: later });
    const reminder = await reminderForStep(step.id);
    expect(reminder!.status).toBe(REMINDER_STATUS.PENDING);
    expect(reminder!.anchorAt).toEqual(later);
  });
});

describe("claim and overdue policy", () => {
  async function seedReminder(input: {
    anchorAt: Date;
    fireAt: Date;
    status?: string;
  }) {
    return prisma.reminder.create({
      data: {
        userId,
        sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
        targetId: `target-${Math.random()}`,
        anchorAt: input.anchorAt,
        fireAt: input.fireAt,
        title: "Round 1",
        body: "Acme · Staff Engineer",
        deepLink: "/dashboard/myjobs/opp-1",
        status: input.status ?? REMINDER_STATUS.PENDING,
      },
    });
  }

  it("claims due rows exactly once even under concurrent ticks", async () => {
    const now = new Date();
    await seedReminder({
      anchorAt: new Date(now.getTime() + 30 * 60_000),
      fireAt: new Date(now.getTime() - 60_000),
    });
    const [first, second] = await Promise.all([
      claimDueReminders(prisma, userId, now),
      claimDueReminders(prisma, userId, now),
    ]);
    expect(first.length + second.length).toBe(1);
    // A follow-up tick sees the row already FIRED and delivers nothing.
    expect(await claimDueReminders(prisma, userId, now)).toHaveLength(0);
    const row = await prisma.reminder.findFirstOrThrow({ where: { userId } });
    expect(row.status).toBe(REMINDER_STATUS.FIRED);
    expect(row.firedAt).toEqual(now);
  });

  it("does not claim reminders whose fireAt is still in the future", async () => {
    const now = new Date();
    await seedReminder({
      anchorAt: new Date(now.getTime() + 2 * 60 * 60_000),
      fireAt: new Date(now.getTime() + 60 * 60_000),
    });
    expect(await claimDueReminders(prisma, userId, now)).toHaveLength(0);
  });

  it("delivers a pending reminder overdue inside the 24h window (restart catch-up)", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);
    await seedReminder({ anchorAt: twoHoursAgo, fireAt: twoHoursAgo });
    const claimed = await claimDueReminders(prisma, userId, now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].title).toBe("Round 1");
  });

  it("expires a pending reminder whose anchor is older than 24h", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - REMINDER_OVERDUE_WINDOW_MS - 60_000);
    await seedReminder({ anchorAt: stale, fireAt: stale });
    expect(await claimDueReminders(prisma, userId, now)).toHaveLength(0);
    const row = await prisma.reminder.findFirstOrThrow({ where: { userId } });
    expect(row.status).toBe(REMINDER_STATUS.EXPIRED);
    expect(row.firedAt).toBeNull();
  });

  it("expireStaleReminders only touches old anchors", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - REMINDER_OVERDUE_WINDOW_MS - 60_000);
    const fresh = new Date(now.getTime() - 60 * 60_000);
    await seedReminder({ anchorAt: stale, fireAt: stale });
    await seedReminder({ anchorAt: fresh, fireAt: fresh });
    expect(await expireStaleReminders(prisma, userId, now)).toBe(1);
    expect(
      await prisma.reminder.count({
        where: { userId, status: REMINDER_STATUS.PENDING },
      }),
    ).toBe(1);
  });
});
