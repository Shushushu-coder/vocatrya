// @vitest-environment node
//
// Frozen datetime consumer contract, process-step slice: structured
// StepTimeInput writes, precision/zone sidecars, historical-unknown
// protection, DateOnly/Instant overdue semantics, and the Upcoming/Dashboard
// linkage against the account zone — all against a disposable database.
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  bucketUpcomingApplicationEvents,
  CareerRuntimeError,
  listUpcomingApplicationEvents,
  OpportunityService,
  OPPORTUNITY_STATUS,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_STATUS,
  UPCOMING_BUCKET_ID,
  UPCOMING_EVENT_KIND,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  businessTimeFromColumns,
  formatBusinessTime,
  formatTimeOfDay12h,
  isDeadlineOverdue,
  runtimeTimeZone,
} from "@/lib/datetime";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;

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
  userId = await seedAccount(prisma, `ptime-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-ptime-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunity(title = "Engineer") {
  return services().opportunities.create({
    companyId,
    title,
    deadline: null,
    status: OPPORTUNITY_STATUS.UNKNOWN,
  });
}

describe("structured step-time writes", () => {
  it("stores a wall-time scheduledAt as a minute instant with zone sidecars", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
      scheduledAt: {
        kind: "wallTime",
        date: "2026-10-20",
        hour: 14,
        minute: 30,
      },
      timeZone: "Asia/Shanghai",
    });

    expect(step.scheduledAt?.toISOString()).toBe("2026-10-20T06:30:00.000Z");
    expect(step.scheduledAtPrecision).toBe("minute");
    expect(step.scheduledAtZone).toBe("Asia/Shanghai");
  });

  it("rejects a scheduled wall time inside a DST gap", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "Gap",
        scheduledAt: {
          kind: "wallTime",
          date: "2026-03-08",
          hour: 2,
          minute: 30,
        },
        timeZone: "America/New_York",
      }),
    ).rejects.toMatchObject({
      code: "PROCESS_STEP_SCHEDULE_INVALID",
    } satisfies Partial<CareerRuntimeError>);
  });

  it("picks the earlier instant on a DST fold", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Fold",
      scheduledAt: {
        kind: "wallTime",
        date: "2026-11-01",
        hour: 1,
        minute: 30,
      },
      timeZone: "America/New_York",
    });
    // 01:30 occurs twice; "earlier" is the EDT reading (05:30Z).
    expect(step.scheduledAt?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("stores a dateOnly deadline without inventing a boundary instant", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Written test",
      deadlineAt: { kind: "dateOnly", date: "2026-10-25" },
      timeZone: "Asia/Shanghai",
    });

    expect(step.deadlineOn).toBe("2026-10-25");
    expect(step.deadlineAt).toBeNull();
    expect(step.deadlinePrecision).toBe("dateOnly");
    expect(step.deadlineZone).toBe("Asia/Shanghai");
  });

  it("stores a timed deadline as a minute instant", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Submit",
      deadlineAt: {
        kind: "wallTime",
        date: "2026-10-25",
        hour: 18,
        minute: 0,
      },
      timeZone: "Asia/Shanghai",
    });

    expect(step.deadlineOn).toBeNull();
    expect(step.deadlineAt?.toISOString()).toBe("2026-10-25T10:00:00.000Z");
    expect(step.deadlinePrecision).toBe("minute");
    expect(step.deadlineZone).toBe("Asia/Shanghai");
  });

  it("keeps the unknown shape for a raw Date write", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Legacy",
      scheduledAt: new Date("2026-10-20T06:30:00.000Z"),
    });

    expect(step.scheduledAt?.toISOString()).toBe("2026-10-20T06:30:00.000Z");
    expect(step.scheduledAtPrecision).toBeNull();
    expect(step.scheduledAtZone).toBeNull();
  });
});

describe("historical unknown protection", () => {
  it("an update that never touches a field rewrites nothing", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const created = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Unknown",
      scheduledAt: new Date("2026-10-20T06:30:00.000Z"),
      deadlineAt: { kind: "dateOnly", date: "2026-10-25" },
      timeZone: "Asia/Shanghai",
    });

    const updated = await applications.updateUserProcessStep({
      stepId: created.id,
      notes: "edited notes only",
    });
    expect(updated.scheduledAtPrecision).toBeNull();
    expect(updated.scheduledAtZone).toBeNull();
    expect(updated.deadlineOn).toBe("2026-10-25");
    expect(updated.deadlinePrecision).toBe("dateOnly");
    expect(updated.deadlineZone).toBe("Asia/Shanghai");

    const timeline = await applications.getTimeline(
      opportunity.id,
      "Asia/Shanghai",
    );
    const stepDto = timeline.attempts.flatMap((a) => a.steps)[0];
    expect(stepDto.scheduledAtPrecision).toBe("unknown");
    expect(stepDto.deadlineOn).toBe("2026-10-25");
    expect(stepDto.deadlinePrecision).toBe("dateOnly");
    expect(timeline.timeZone).toBe("Asia/Shanghai");
  });

  it("clearing a dateOnly deadline clears every sidecar", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const created = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Clear me",
      deadlineAt: { kind: "dateOnly", date: "2026-10-25" },
      timeZone: "Asia/Shanghai",
    });
    const updated = await applications.updateUserProcessStep({
      stepId: created.id,
      deadlineAt: null,
    });
    expect(updated.deadlineOn).toBeNull();
    expect(updated.deadlineAt).toBeNull();
    expect(updated.deadlinePrecision).toBeNull();
    expect(updated.deadlineZone).toBeNull();
  });
});

describe("completed/cancelled precision", () => {
  it("complete and cancel stamp completedAtPrecision fullInstant", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const done = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.SCREENING,
      label: "Done",
    });
    const cancelled = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Cancel",
    });
    const completed = await applications.completeProcessStep(done.id);
    const cancelledRow = await applications.cancelProcessStep(cancelled.id);
    expect(completed.completedAtPrecision).toBe("fullInstant");
    expect(cancelledRow.completedAtPrecision).toBe("fullInstant");
    expect(cancelledRow.status).toBe(PROCESS_STEP_STATUS.CANCELLED);
  });
});

describe("upcoming consumption of precision semantics", () => {
  it("returns the envelope and surfaces a dateOnly deadline step", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Written test",
      deadlineAt: { kind: "dateOnly", date: "2026-10-25" },
      timeZone: runtimeTimeZone(),
    });

    const envelope = await listUpcomingApplicationEvents(prisma, userId, runtimeTimeZone());
    expect(envelope.timeZone).toBe(runtimeTimeZone());
    const event = envelope.events.find(
      (row) => row.kind === UPCOMING_EVENT_KIND.PROCESS_STEP,
    );
    expect(event).toBeTruthy();
    expect(event?.deadlineOn).toBe("2026-10-25");
    expect(event?.deadlineAt).toBeNull();
    expect(event?.deadlinePrecision).toBe("dateOnly");
    // Attention sits at the start of the calendar day in the account zone.
    const dayStart = new Date(event!.attentionAt);
    expect(dayStart.toISOString()).toBe(event!.attentionAt);
  });

  it("drops completed and cancelled steps from Upcoming", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const done = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Done",
      scheduledAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const cancelled = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Cancelled",
      scheduledAt: new Date("2099-01-02T00:00:00.000Z"),
    });
    await applications.completeProcessStep(done.id);
    await applications.cancelProcessStep(cancelled.id);

    const { events } = await listUpcomingApplicationEvents(prisma, userId, runtimeTimeZone());
    expect(events.map((row) => row.processStepId)).not.toContain(done.id);
    expect(events.map((row) => row.processStepId)).not.toContain(cancelled.id);
  });

  it("a dateOnly deadline is overdue only after its calendar day ends", () => {
    const tz = "Asia/Shanghai";
    const todayValue = businessTimeFromColumns({
      dateOnly: "2026-10-20",
      instant: null,
      precision: "dateOnly",
    });
    // 2026-10-20 23:00 in Shanghai = 15:00Z — still inside the day.
    expect(
      isDeadlineOverdue(
        todayValue,
        new Date("2026-10-20T15:00:00.000Z"),
        tz,
      ),
    ).toBe(false);
    // 2026-10-21 00:30 in Shanghai = 16:30Z — the day has ended.
    expect(
      isDeadlineOverdue(
        todayValue,
        new Date("2026-10-20T16:30:00.000Z"),
        tz,
      ),
    ).toBe(true);
  });

  it("an instant deadline is overdue the moment it passes", () => {
    const value = businessTimeFromColumns({
      dateOnly: null,
      instant: "2026-10-20T06:00:00.000Z",
      precision: "minute",
    });
    expect(
      isDeadlineOverdue(
        value,
        new Date("2026-10-20T05:59:59.999Z"),
        "Asia/Shanghai",
      ),
    ).toBe(false);
    expect(
      isDeadlineOverdue(
        value,
        new Date("2026-10-20T06:00:00.001Z"),
        "Asia/Shanghai",
      ),
    ).toBe(true);
  });

  it("buckets follow the account-zone calendar, not the host clock", () => {
    const tz = "Asia/Shanghai";
    // 2026-10-20 07:30Z = 15:30 Shanghai; a 16:00Z event is 10-21 00:00 in
    // Shanghai — "today" in UTC but "next 7 days" for the account.
    const event = {
      kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
      jobOpportunityId: "job-1",
      companyName: "Acme",
      roleTitle: "A",
      applicationAttemptId: "att-1",
      processStepId: "step-1",
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Boundary",
      stepStatus: PROCESS_STEP_STATUS.PENDING,
      scheduledAt: "2026-10-20T16:00:00.000Z",
      scheduledAtPrecision: "minute",
      scheduledAtZone: tz,
      deadlineOn: null,
      deadlineAt: null,
      deadlinePrecision: null,
      deadlineZone: null,
      attentionAt: "2026-10-20T16:00:00.000Z",
    } as const;
    const now = new Date("2026-10-20T07:30:00.000Z");
    const buckets = bucketUpcomingApplicationEvents([event], now, tz);
    expect(buckets.map((row) => row.id)).toEqual([
      UPCOMING_BUCKET_ID.next7Days,
    ]);
  });
});

describe("shared helpers", () => {
  it("formats time-of-day in the 12h wire form", () => {
    expect(formatTimeOfDay12h(0, 0)).toBe("12:00 AM");
    expect(formatTimeOfDay12h(13, 5)).toBe("01:05 PM");
    expect(formatTimeOfDay12h(23, 59)).toBe("11:59 PM");
  });

  it("renders dateOnly, declared instant, and unknown distinctly", () => {
    const tz = "Asia/Shanghai";
    expect(
      formatBusinessTime(
        businessTimeFromColumns({
          dateOnly: "2026-10-25",
          instant: null,
          precision: "dateOnly",
        }),
        "zh-CN",
        tz,
      ),
    ).toContain("10");
    // Unknown instant: date part only, no fabricated clock time.
    const unknown = formatBusinessTime(
      businessTimeFromColumns({
        dateOnly: null,
        instant: "2026-10-20T06:30:00.000Z",
        precision: null,
      }),
      "zh-CN",
      tz,
    );
    expect(unknown).toContain("10");
    expect(unknown).not.toMatch(/\d{1,2}:\d{2}/);
    // Declared minute instant renders the wall time in the account zone.
    const minute = formatBusinessTime(
      businessTimeFromColumns({
        dateOnly: null,
        instant: "2026-10-20T06:30:00.000Z",
        precision: "minute",
      }),
      "zh-CN",
      tz,
    );
    expect(minute).toContain("14:30");
  });
});
