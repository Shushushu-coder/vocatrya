// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  bucketUpcomingApplicationEvents,
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
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
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
  userId = await seedAccount(prisma, `upcoming-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `upcoming-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-upcoming-${Date.now()}`,
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

async function createOpportunity(input: {
  title: string;
  deadline?: Date | null;
  status?: string;
  archivedAt?: Date | null;
}) {
  const created = await services().opportunities.create({
    companyId,
    title: input.title,
    deadline: input.deadline ?? null,
    status: input.status ?? OPPORTUNITY_STATUS.UNKNOWN,
  });
  if (input.archivedAt) {
    return prisma.jobOpportunity.update({
      where: { id: created.id },
      data: { archivedAt: input.archivedAt },
    });
  }
  return created;
}

describe("Upcoming job deadlines", () => {
  it("includes an unsubmitted opportunity with a real deadline", async () => {
    const deadline = new Date("2026-10-20T00:00:00.000Z");
    const opportunity = await createOpportunity({
      title: "Staff Engineer",
      deadline,
    });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
      jobOpportunityId: opportunity.id,
      companyName: "Acme",
      roleTitle: "Staff Engineer",
      applicationAttemptId: null,
      processStepId: null,
      deadlineAt: deadline.toISOString(),
      attentionAt: deadline.toISOString(),
    });
  });

  it("excludes the application deadline after a submitted non-archived attempt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity({
      title: "Submitted role",
      deadline: new Date("2026-10-20T00:00:00.000Z"),
    });
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    await applications.markSubmitted({ attemptId: attempt.id });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events.filter((row) => row.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE)).toEqual([]);
  });

  it("does not invent an upcoming event when deadline is null", async () => {
    await createOpportunity({ title: "No deadline" });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events).toEqual([]);
  });

  it("excludes archived, closed, and expired opportunities", async () => {
    await createOpportunity({
      title: "Archived",
      deadline: new Date("2026-10-20T00:00:00.000Z"),
      archivedAt: new Date(),
    });
    await createOpportunity({
      title: "Closed",
      deadline: new Date("2026-10-20T00:00:00.000Z"),
      status: OPPORTUNITY_STATUS.CLOSED,
    });
    await createOpportunity({
      title: "Expired",
      deadline: new Date("2026-10-20T00:00:00.000Z"),
      status: OPPORTUNITY_STATUS.EXPIRED,
    });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events).toEqual([]);
  });
});

describe("Upcoming process steps", () => {
  it("includes ACTIVE and OFFER unfinished steps, one item when both times exist", async () => {
    const { applications } = services();
    const activeOpp = await createOpportunity({ title: "Active role" });
    const offerOpp = await createOpportunity({ title: "Offer role" });
    const rejectedOpp = await createOpportunity({ title: "Rejected role" });
    const withdrawnOpp = await createOpportunity({ title: "Withdrawn role" });
    const hiredOpp = await createOpportunity({ title: "Hired role" });
    const transferredOpp = await createOpportunity({ title: "Transferred role" });

    const active = await applications.createAttempt({
      jobOpportunityId: activeOpp.id,
      channelLabel: "A",
    });
    const offer = await applications.createAttempt({
      jobOpportunityId: offerOpp.id,
      channelLabel: "B",
    });
    const rejected = await applications.createAttempt({
      jobOpportunityId: rejectedOpp.id,
      channelLabel: "C",
    });
    const withdrawn = await applications.createAttempt({
      jobOpportunityId: withdrawnOpp.id,
      channelLabel: "D",
    });
    const hired = await applications.createAttempt({
      jobOpportunityId: hiredOpp.id,
      channelLabel: "E",
    });
    const transferred = await applications.createAttempt({
      jobOpportunityId: transferredOpp.id,
      channelLabel: "F",
    });
    await applications.recordOutcome(offer.id, ATTEMPT_OUTCOME.OFFER);
    await applications.recordOutcome(rejected.id, ATTEMPT_OUTCOME.REJECTED);
    await applications.recordOutcome(withdrawn.id, ATTEMPT_OUTCOME.WITHDRAWN);
    await applications.recordOutcome(hired.id, ATTEMPT_OUTCOME.HIRED);
    await applications.recordOutcome(transferred.id, ATTEMPT_OUTCOME.TRANSFERRED);

    const scheduled = new Date("2026-10-20T00:00:00.000Z");
    const deadline = new Date("2026-10-23T00:00:00.000Z");
    const both = await applications.createUserProcessStep({
      jobOpportunityId: activeOpp.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Online test",
      scheduledAt: scheduled,
      deadlineAt: deadline,
    });
    await applications.createUserProcessStep({
      jobOpportunityId: offerOpp.id,
      category: PROCESS_STEP_CATEGORY.OFFER,
      label: "Offer reply",
      deadlineAt: new Date("2026-10-24T00:00:00.000Z"),
    });
    await applications.createUserProcessStep({
      jobOpportunityId: rejectedOpp.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Rejected interview",
      scheduledAt: scheduled,
    });
    await applications.createUserProcessStep({
      jobOpportunityId: withdrawnOpp.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Withdrawn interview",
      scheduledAt: scheduled,
    });
    await applications.createUserProcessStep({
      jobOpportunityId: hiredOpp.id,
      category: PROCESS_STEP_CATEGORY.ONBOARDING,
      label: "Onboarding",
      scheduledAt: scheduled,
    });
    await applications.createUserProcessStep({
      jobOpportunityId: transferredOpp.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Transferred interview",
      scheduledAt: scheduled,
    });
    const completed = await applications.createUserProcessStep({
      jobOpportunityId: activeOpp.id,
      category: PROCESS_STEP_CATEGORY.SCREENING,
      label: "Done screen",
      scheduledAt: scheduled,
    });
    await applications.completeProcessStep(completed.id);

    const events = await listUpcomingApplicationEvents(prisma, userId);
    const stepEvents = events.filter(
      (row) => row.kind === UPCOMING_EVENT_KIND.PROCESS_STEP,
    );
    expect(stepEvents.map((row) => row.label).sort()).toEqual([
      "Offer reply",
      "Online test",
    ]);
    const bothEvent = stepEvents.find((row) => row.processStepId === both.id);
    expect(bothEvent?.scheduledAt).toBe(scheduled.toISOString());
    expect(bothEvent?.deadlineAt).toBe(deadline.toISOString());
    expect(bothEvent?.attentionAt).toBe(scheduled.toISOString());
    expect(stepEvents.filter((row) => row.processStepId === both.id)).toHaveLength(1);
    expect(active.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
  });

  it("includes scheduled-only and deadline-only unfinished steps", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity({ title: "Timed role" });
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "A",
    });
    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Scheduled only",
      scheduledAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Deadline only",
      deadlineAt: new Date("2026-11-02T00:00:00.000Z"),
    });
    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "No time",
    });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events.map((row) => row.label).sort()).toEqual([
      "Deadline only",
      "Scheduled only",
    ]);
  });
});

describe("Upcoming overdue buckets, sort, and ownership", () => {
  it("classifies past deadline, past scheduled-without-deadline, and past job deadline as overdue", () => {
    const now = new Date("2026-09-18T12:00:00.000Z");
    const buckets = bucketUpcomingApplicationEvents(
      [
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: "job-1",
          companyName: "Acme",
          roleTitle: "A",
          applicationAttemptId: "att-1",
          processStepId: "step-deadline",
          category: PROCESS_STEP_CATEGORY.ASSESSMENT,
          label: "Past deadline",
          stepStatus: PROCESS_STEP_STATUS.PENDING,
          scheduledAt: null,
          deadlineAt: "2026-09-17T00:00:00.000Z",
          attentionAt: "2026-09-17T00:00:00.000Z",
        },
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: "job-1",
          companyName: "Acme",
          roleTitle: "A",
          applicationAttemptId: "att-1",
          processStepId: "step-scheduled",
          category: PROCESS_STEP_CATEGORY.INTERVIEW,
          label: "Past scheduled",
          stepStatus: PROCESS_STEP_STATUS.PENDING,
          scheduledAt: "2026-09-16T00:00:00.000Z",
          deadlineAt: null,
          attentionAt: "2026-09-16T00:00:00.000Z",
        },
        {
          kind: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          jobOpportunityId: "job-2",
          companyName: "Acme",
          roleTitle: "B",
          applicationAttemptId: null,
          processStepId: null,
          category: null,
          label: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          stepStatus: null,
          scheduledAt: null,
          deadlineAt: "2026-09-10T00:00:00.000Z",
          attentionAt: "2026-09-10T00:00:00.000Z",
        },
      ],
      now,
    );
    expect(buckets.map((row) => row.id)).toEqual([UPCOMING_BUCKET_ID.overdue]);
    expect(buckets[0].events).toHaveLength(3);
  });

  it("buckets remaining events into Today, Next 7 Days, and Later by local calendar day", () => {
    const now = new Date(2026, 8, 18, 12, 0, 0);
    const today = new Date(2026, 8, 18, 18, 0, 0);
    const next7 = new Date(2026, 8, 22, 9, 0, 0);
    const later = new Date(2026, 9, 10, 9, 0, 0);
    const buckets = bucketUpcomingApplicationEvents(
      [
        {
          kind: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          jobOpportunityId: "today",
          companyName: "Acme",
          roleTitle: "Today role",
          applicationAttemptId: null,
          processStepId: null,
          category: null,
          label: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          stepStatus: null,
          scheduledAt: null,
          deadlineAt: today.toISOString(),
          attentionAt: today.toISOString(),
        },
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: "next",
          companyName: "Acme",
          roleTitle: "Soon role",
          applicationAttemptId: "att-1",
          processStepId: "step-next",
          category: PROCESS_STEP_CATEGORY.INTERVIEW,
          label: "Soon interview",
          stepStatus: PROCESS_STEP_STATUS.PENDING,
          scheduledAt: next7.toISOString(),
          deadlineAt: null,
          attentionAt: next7.toISOString(),
        },
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: "later",
          companyName: "Acme",
          roleTitle: "Later role",
          applicationAttemptId: "att-2",
          processStepId: "step-later",
          category: PROCESS_STEP_CATEGORY.OFFER,
          label: "Later offer",
          stepStatus: PROCESS_STEP_STATUS.PENDING,
          scheduledAt: later.toISOString(),
          deadlineAt: null,
          attentionAt: later.toISOString(),
        },
      ],
      now,
    );
    expect(buckets.map((row) => row.id)).toEqual([
      UPCOMING_BUCKET_ID.today,
      UPCOMING_BUCKET_ID.next7Days,
      UPCOMING_BUCKET_ID.later,
    ]);
  });

  it("sorts by attentionAt, then kind, then stable id", async () => {
    const { applications } = services();
    const first = await createOpportunity({
      title: "Later deadline",
      deadline: new Date("2026-11-02T00:00:00.000Z"),
    });
    const second = await createOpportunity({
      title: "Earlier deadline",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    const sameTime = await createOpportunity({ title: "Same-time steps" });
    await applications.createAttempt({
      jobOpportunityId: sameTime.id,
      channelLabel: "A",
    });
    const lateStep = await applications.createUserProcessStep({
      jobOpportunityId: sameTime.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Zed",
      scheduledAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const earlyStep = await applications.createUserProcessStep({
      jobOpportunityId: sameTime.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Ace",
      deadlineAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events[0].jobOpportunityId).toBe(second.id);
    expect(events[0].kind).toBe(UPCOMING_EVENT_KIND.APPLICATION_DEADLINE);
    const sameAttention = events.filter(
      (row) => row.attentionAt === "2026-11-01T00:00:00.000Z",
    );
    expect(sameAttention[0].kind).toBe(UPCOMING_EVENT_KIND.APPLICATION_DEADLINE);
    const stepIds = sameAttention
      .filter((row) => row.kind === UPCOMING_EVENT_KIND.PROCESS_STEP)
      .map((row) => row.processStepId);
    expect(stepIds).toEqual([earlyStep.id, lateStep.id].sort());
    expect(events.map((row) => row.jobOpportunityId)).toContain(first.id);
  });

  it("does not let user A read user B upcoming events", async () => {
    const otherCompany = await prisma.company.create({
      data: {
        label: "OtherCo",
        value: `other-upcoming-${Date.now()}`,
        createdBy: otherUserId,
      },
    });
    const other = services(otherUserId);
    await other.opportunities.create({
      companyId: otherCompany.id,
      title: "Secret",
      deadline: new Date("2026-10-20T00:00:00.000Z"),
    });
    await createOpportunity({
      title: "Mine",
      deadline: new Date("2026-10-21T00:00:00.000Z"),
    });
    const mine = await listUpcomingApplicationEvents(prisma, userId);
    const theirs = await listUpcomingApplicationEvents(prisma, otherUserId);
    expect(mine.map((row) => row.roleTitle)).toEqual(["Mine"]);
    expect(theirs.map((row) => row.roleTitle)).toEqual(["Secret"]);
  });
});

describe("Upcoming after ProcessStep delete", () => {
  it("drops a future USER step from Upcoming after delete", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity({ title: "Upcoming role" });
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "A",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Future interview",
      deadlineAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const before = await listUpcomingApplicationEvents(prisma, userId);
    expect(
      before.some((row) => row.processStepId === step.id),
    ).toBe(true);
    await applications.deleteUserProcessStep(step.id);
    const after = await listUpcomingApplicationEvents(prisma, userId);
    expect(after.some((row) => row.processStepId === step.id)).toBe(false);
  });

  it("keeps TRANSFERRED attempts excluded after deleting a process step", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity({ title: "Transferred role" });
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "A",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Transferred interview",
      scheduledAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.TRANSFERRED);
    expect(
      (await listUpcomingApplicationEvents(prisma, userId)).some(
        (row) => row.processStepId === step.id,
      ),
    ).toBe(false);
    await applications.deleteUserProcessStep(step.id);
    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.outcome).toBe(ATTEMPT_OUTCOME.TRANSFERRED);
    expect(
      (await listUpcomingApplicationEvents(prisma, userId)).some(
        (row) => row.jobOpportunityId === opportunity.id,
      ),
    ).toBe(false);
  });
});
