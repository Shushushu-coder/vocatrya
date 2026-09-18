// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  CareerRuntimeError,
  COMPATIBILITY_PROCESS_STEPS,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import { syncApplicationFromUiStatus } from "@/lib/career/jobOpportunityAdapter";
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
  userId = await seedAccount(prisma, `timeline-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `timeline-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-timeline-${Date.now()}`,
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
    variants: new ResumeVariantService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunity() {
  const { opportunities } = services();
  return opportunities.create({ companyId, title: "Staff Engineer" });
}

describe("Application timeline read", () => {
  it("rejects a cross-user opportunity", async () => {
    const opportunity = await createOpportunity();
    const other = new ApplicationService(prisma, otherUserId, FEATURE_ON);
    await expect(other.getTimeline(opportunity.id)).rejects.toMatchObject({
      code: "OPPORTUNITY_NOT_FOUND",
    });
  });

  it("returns an empty attempts list when the opportunity has none", async () => {
    const opportunity = await createOpportunity();
    const timeline = await services().applications.getTimeline(opportunity.id);
    expect(timeline).toEqual({
      opportunityId: opportunity.id,
      attempts: [],
    });
  });

  it("returns one attempt with a null submitted resume", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts).toHaveLength(1);
    expect(timeline.attempts[0].id).toBe(attempt.id);
    expect(timeline.attempts[0].submittedResume).toBeNull();
    expect(timeline.attempts[0]).not.toHaveProperty("userId");
    expect(timeline.attempts[0]).not.toHaveProperty("submittedResumeVersionId");
  });

  it("returns bound submitted resume metadata without mapping a legacy resume", async () => {
    const { applications, variants } = services();
    const opportunity = await createOpportunity();
    const variant = await variants.createVariant({ name: "General" });
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    });
    await applications.markSubmitted({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId!,
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].submittedResume).toEqual({
      id: variant.currentVersionId,
      title: "General",
      versionNumber: 1,
    });
  });

  it("orders multiple attempts by submittedAt then createdAt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const first = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "First",
    });
    const second = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Second",
    });
    await applications.markSubmitted({
      attemptId: first.id,
      submittedAt: new Date("2024-02-01T00:00:00.000Z"),
    });
    await applications.markSubmitted({
      attemptId: second.id,
      submittedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it("orders steps by sortOrder, then scheduledAt, then createdAt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const late = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Late",
      sortOrder: 10,
      scheduledAt: new Date("2024-03-01T00:00:00.000Z"),
    });
    const early = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Early",
      sortOrder: 10,
      scheduledAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const first = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.SCREENING,
      label: "Screen",
      sortOrder: 1,
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].steps.map((step) => step.id)).toEqual([
      first.id,
      early.id,
      late.id,
    ]);
  });
});

describe("Application process step writes", () => {
  it("creates a USER step with category, label, schedule and notes", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const scheduledAt = new Date("2024-05-01T12:00:00.000Z");
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Hiring manager",
      scheduledAt,
      notes: "Bring portfolio",
    });
    expect(step.source).toBe(PROCESS_STEP_SOURCE.USER);
    expect(step.category).toBe(PROCESS_STEP_CATEGORY.INTERVIEW);
    expect(step.label).toBe("Hiring manager");
    expect(step.status).toBe(PROCESS_STEP_STATUS.PENDING);
    expect(step.scheduledAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(step.notes).toBe("Bring portfolio");
    expect(step.sortOrder).toBe(10);
  });

  it("rejects create and update from another user", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Follow up",
    });
    const other = new ApplicationService(prisma, otherUserId, FEATURE_ON);
    await expect(
      other.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Intruder",
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    await expect(
      other.updateUserProcessStep({ stepId: step.id, notes: "nope" }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_NOT_FOUND" });
    await expect(other.completeProcessStep(step.id)).rejects.toMatchObject({
      code: "PROCESS_STEP_NOT_FOUND",
    });
  });

  it("completes a pending step without mutating attempt outcome", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
    });
    const completed = await applications.completeProcessStep(step.id);
    expect(completed.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(completed.completedAt).toBeInstanceOf(Date);
    const again = await applications.completeProcessStep(step.id);
    expect(again.completedAt?.toISOString()).toBe(
      completed.completedAt?.toISOString(),
    );
    const reread = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(reread.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
  });

  it("lets a completed step keep notes/result edits without rewriting history", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Online test",
    });
    await applications.completeProcessStep(step.id);
    const updated = await applications.updateUserProcessStep({
      stepId: step.id,
      category: PROCESS_STEP_CATEGORY.OFFER,
      label: "should not apply",
      notes: "scored well",
      result: "pass",
    });
    expect(updated.category).toBe(PROCESS_STEP_CATEGORY.ASSESSMENT);
    expect(updated.label).toBe("Online test");
    expect(updated.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(updated.notes).toBe("scored well");
    expect(updated.result).toBe("pass");
  });
});

describe("Compatibility process step dedupe and history protection", () => {
  it("does not create duplicate INTERVIEW compatibility steps", async () => {
    const opportunity = await createOpportunity();
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const steps = await prisma.applicationProcessStep.findMany();
    expect(steps).toHaveLength(1);
    expect(steps[0].source).toBe(PROCESS_STEP_SOURCE.SYSTEM);
    expect(steps[0].category).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(steps[0].label).toBe(COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label);
  });

  it("does not create duplicate OFFER compatibility steps", async () => {
    const opportunity = await createOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, opportunity.id, "offer", {
      env: FEATURE_ON,
    });
    await syncApplicationFromUiStatus(prisma, userId, opportunity.id, "offer", {
      env: FEATURE_ON,
    });
    const steps = await prisma.applicationProcessStep.findMany();
    expect(steps).toHaveLength(1);
    expect(steps[0].source).toBe(PROCESS_STEP_SOURCE.SYSTEM);
    expect(steps[0].category).toBe(ATTEMPT_STAGE.OFFER);
  });

  it("does not treat a user interview round as the compatibility step", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const userStep = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "一面",
    });
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const steps = await prisma.applicationProcessStep.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(steps).toHaveLength(2);
    expect(steps.map((row) => row.id)).toContain(userStep.id);
    expect(steps.some((row) => row.source === PROCESS_STEP_SOURCE.SYSTEM)).toBe(
      true,
    );
    const rereadUser = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: userStep.id },
    });
    expect(rereadUser.label).toBe("一面");
    expect(rereadUser.source).toBe(PROCESS_STEP_SOURCE.USER);
  });

  it("does not reset or delete a completed compatibility step on later status sync", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const created = await prisma.applicationProcessStep.findFirstOrThrow();
    const completed = await applications.completeProcessStep(created.id);
    await applications.updateUserProcessStep({
      stepId: created.id,
      notes: "went well",
    });
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const steps = await prisma.applicationProcessStep.findMany();
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe(created.id);
    expect(steps[0].status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(steps[0].completedAt?.toISOString()).toBe(
      completed.completedAt?.toISOString(),
    );
    expect(steps[0].label).toBe(COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label);
    expect(steps[0].category).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(steps[0].notes).toBe("went well");
  });

  it("reuses a legacy USER compatibility step instead of duplicating it", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const legacy = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.category,
      label: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label,
      sortOrder: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.sortOrder,
      status: PROCESS_STEP_STATUS.IN_PROGRESS,
      source: PROCESS_STEP_SOURCE.USER,
    });
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const steps = await prisma.applicationProcessStep.findMany();
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe(legacy.id);
    expect(steps[0].source).toBe(PROCESS_STEP_SOURCE.SYSTEM);
  });
});

describe("ApplicationService ownership", () => {
  it("throws CareerRuntimeError for an unknown opportunity", async () => {
    await expect(
      services().applications.getTimeline("missing-opportunity"),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
  });
});
