// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  activateFreshAbNative,
  listUpcomingApplicationEvents,
} from "@/lib/career";
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

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getCurrentUser } from "@/utils/user.utils";
import { cancelApplicationProcessStep } from "@/actions/application.actions";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const mockedUser = vi.mocked(getCurrentUser);

let userId: string;
let companyId: string;

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
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
    `step-cancel-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-cancel-${Date.now()}-${Math.random()}`,
        createdBy: userId,
      },
    })
  ).id;
  await activateFreshAbNative(prisma);
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
  mockedUser.mockResolvedValue({
    id: userId,
    name: "Test",
    email: "t@example.com",
  } as never);
});

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunityWithStep(input: {
  scheduledAt?: Date;
  source?: string;
}) {
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
  if (input.source && input.source !== PROCESS_STEP_SOURCE.USER) {
    return prisma.applicationProcessStep.update({
      where: { id: step.id },
      data: { source: input.source },
    });
  }
  return step;
}

describe("cancelProcessStep", () => {
  it("marks a pending step cancelled, stamps completedAt, and drops it from Upcoming", async () => {
    const { applications } = services();
    const step = await createOpportunityWithStep({
      scheduledAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(
      (await listUpcomingApplicationEvents(prisma, userId)).some(
        (row) => row.processStepId === step.id,
      ),
    ).toBe(true);

    const cancelled = await applications.cancelProcessStep(step.id);
    expect(cancelled.status).toBe(PROCESS_STEP_STATUS.CANCELLED);
    expect(cancelled.completedAt).toBeInstanceOf(Date);

    const reread = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: step.id },
    });
    expect(reread.status).toBe(PROCESS_STEP_STATUS.CANCELLED);
    expect(reread.completedAt).toBeInstanceOf(Date);
    expect(
      (await listUpcomingApplicationEvents(prisma, userId)).some(
        (row) => row.processStepId === step.id,
      ),
    ).toBe(false);
  });

  it("is idempotent and a no-op on completed steps", async () => {
    const { applications } = services();
    const step = await createOpportunityWithStep({});
    const first = await applications.cancelProcessStep(step.id);
    const second = await applications.cancelProcessStep(step.id);
    expect(second.status).toBe(PROCESS_STEP_STATUS.CANCELLED);
    expect(second.completedAt?.getTime()).toBe(first.completedAt?.getTime());

    const done = await createOpportunityWithStep({});
    await applications.completeProcessStep(done.id);
    const completedBefore = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: done.id },
    });
    const stillCompleted = await applications.cancelProcessStep(done.id);
    expect(stillCompleted.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(stillCompleted.completedAt?.getTime()).toBe(
      completedBefore.completedAt?.getTime(),
    );
  });

  it("keeps the first terminal transition when complete and cancel race", async () => {
    const { applications } = services();
    const step = await createOpportunityWithStep({});
    const [completed, cancelled] = await Promise.all([
      applications.completeProcessStep(step.id),
      applications.cancelProcessStep(step.id),
    ]);
    const persisted = await prisma.applicationProcessStep.findUniqueOrThrow({ where: { id: step.id } });
    expect([PROCESS_STEP_STATUS.COMPLETED, PROCESS_STEP_STATUS.CANCELLED]).toContain(persisted.status);
    expect(completed.status).toBe(persisted.status);
    expect(cancelled.status).toBe(persisted.status);
    expect(completed.completedAt).toEqual(persisted.completedAt);
    expect(cancelled.completedAt).toEqual(persisted.completedAt);
  });

  it("rejects steps that did not come from the user", async () => {
    const { applications } = services();
    const system = await createOpportunityWithStep({
      source: PROCESS_STEP_SOURCE.SYSTEM,
    });
    await expect(
      applications.cancelProcessStep(system.id),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_CANCEL_NOT_ALLOWED" });
    const reread = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: system.id },
    });
    expect(reread.status).not.toBe(PROCESS_STEP_STATUS.CANCELLED);
    expect(reread.completedAt).toBeNull();
  });

  it("locks schedule fields after cancel while keeping notes/result editable", async () => {
    const { applications } = services();
    const original = new Date("2026-11-01T00:00:00.000Z");
    const step = await createOpportunityWithStep({ scheduledAt: original });
    await applications.cancelProcessStep(step.id);

    const updated = await applications.updateUserProcessStep({
      stepId: step.id,
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
      label: "Renamed",
      notes: "Cancelled by recruiter",
    });
    expect(updated.scheduledAt?.toISOString()).toBe(original.toISOString());
    expect(updated.label).toBe("Round 1");
    expect(updated.notes).toBe("Cancelled by recruiter");
  });
});

describe("cancelApplicationProcessStep action", () => {
  it("cancels through the action and surfaces a code for system steps", async () => {
    const { applications } = services();
    const step = await createOpportunityWithStep({});

    const ok = await cancelApplicationProcessStep(step.id);
    expect(ok.success).toBe(true);

    const system = await prisma.applicationProcessStep.update({
      where: { id: (
        await applications.createUserProcessStep({
          jobOpportunityId: (
            await prisma.applicationAttempt.findUniqueOrThrow({
              where: { id: step.applicationAttemptId },
            })
          ).jobOpportunityId,
          applicationAttemptId: step.applicationAttemptId,
          category: PROCESS_STEP_CATEGORY.OTHER,
          label: "System owned",
        })
      ).id },
      data: { source: PROCESS_STEP_SOURCE.SYSTEM },
    });
    const denied = await cancelApplicationProcessStep(system.id);
    expect(denied.success).toBe(false);
    expect(denied).toMatchObject({ code: "PROCESS_STEP_CANCEL_NOT_ALLOWED" });
  });
});
