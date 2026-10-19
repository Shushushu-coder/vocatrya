// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  activateFreshAbNative,
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
import { createApplicationProcessStep } from "@/actions/application.actions";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const mockedUser = vi.mocked(getCurrentUser);

let userId: string;
let otherUserId: string;
let companyId: string;
let otherCompanyId: string;

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
    `step-owner-${Date.now()}-${Math.random()}@example.com`,
  );
  otherUserId = await seedAccount(
    prisma,
    `step-owner-other-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-${Date.now()}-${Math.random()}`,
        createdBy: userId,
      },
    })
  ).id;
  otherCompanyId = (
    await prisma.company.create({
      data: {
        label: "Other Co",
        value: `other-${Date.now()}-${Math.random()}`,
        createdBy: otherUserId,
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

async function createOpportunity(ownerId = userId) {
  return services(ownerId).opportunities.create({
    companyId: ownerId === userId ? companyId : otherCompanyId,
    title: "Staff Engineer",
  });
}

describe("explicit ApplicationAttempt ownership", () => {
  it("binds a new step to the explicitly selected attempt, not the latest", async () => {
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

    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: first.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
    });

    expect(step.applicationAttemptId).toBe(first.id);
    expect(step.source).toBe(PROCESS_STEP_SOURCE.USER);
    expect(
      await prisma.applicationProcessStep.count({
        where: { applicationAttemptId: second.id },
      }),
    ).toBe(0);
  });

  it("rejects an attempt owned by another user", async () => {
    const { applications } = services();
    const other = services(otherUserId).applications;
    const opportunity = await createOpportunity();
    const otherOpportunity = await createOpportunity(otherUserId);
    const mine = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Mine",
    });
    const foreign = await other.createAttempt({
      jobOpportunityId: otherOpportunity.id,
      channelLabel: "Foreign",
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        applicationAttemptId: foreign.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Intruder",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
    await expect(
      other.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        applicationAttemptId: mine.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Intruder",
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("rejects an attempt bound to a different opportunity", async () => {
    const { applications } = services();
    const first = await createOpportunity();
    const second = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: first.id,
      channelLabel: "First",
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: second.id,
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Misfiled",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_OPPORTUNITY_MISMATCH" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("rejects an archived attempt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Archived",
    });
    await prisma.applicationAttempt.update({
      where: { id: attempt.id },
      data: { archivedAt: new Date() },
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Late",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_ARCHIVED" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});

describe("legacy (attempt-less) create path", () => {
  it("rejects instead of silently picking the latest of several attempts", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "First",
    });
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Second",
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "Ambiguous",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_ATTEMPT_AMBIGUOUS" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("keeps attaching to the single live attempt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Only",
    });

    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Follow up",
    });
    expect(step.applicationAttemptId).toBe(attempt.id);
  });

  it("keeps auto-creating a draft attempt when none exists", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();

    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Follow up",
    });
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(step.applicationAttemptId).toBe(attempt.id);
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.DRAFT);
    expect(attempt.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
  });

  it("creates a fresh attempt when every existing one is archived", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const archived = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Old",
    });
    await prisma.applicationAttempt.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "New round",
    });
    expect(step.applicationAttemptId).not.toBe(archived.id);
    const attempt = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: step.applicationAttemptId },
    });
    expect(attempt.archivedAt).toBeNull();
  });
});

describe("submission truthfulness and historical ownership", () => {
  it("does not change attempt submission facts when a step is created", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Portal",
    });
    const submittedAt = new Date("2024-03-01T00:00:00.000Z");
    await applications.markSubmitted({ attemptId: attempt.id, submittedAt });
    const before = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });

    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Onsite",
    });

    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.submittedAt?.toISOString()).toBe(
      before.submittedAt?.toISOString(),
    );
    expect(after.currentStageCategory).toBe(before.currentStageCategory);
    expect(after.outcome).toBe(before.outcome);
  });

  it("never re-attributes historical steps to another attempt", async () => {
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
    const historical = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: first.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Imported legacy step",
        sortOrder: 10,
        status: PROCESS_STEP_STATUS.PENDING,
        source: PROCESS_STEP_SOURCE.IMPORT,
      },
    });

    // The ambiguous legacy call must fail without touching existing rows.
    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Ambiguous",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_ATTEMPT_AMBIGUOUS" });

    const created = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: second.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Second round",
    });

    const reread = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: historical.id },
    });
    expect(reread.applicationAttemptId).toBe(first.id);
    expect(created.applicationAttemptId).toBe(second.id);
    expect(reread.source).toBe(PROCESS_STEP_SOURCE.IMPORT);
  });
});

describe("createApplicationProcessStep action", () => {
  it("returns a stable code for the ambiguous legacy call", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "First",
    });
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Second",
    });

    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Ambiguous",
    });
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ code: "PROCESS_STEP_ATTEMPT_AMBIGUOUS" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("accepts an explicit applicationAttemptId", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const first = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "First",
    });
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Second",
    });

    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: first.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Explicit",
    });
    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.applicationAttemptId).toBe(first.id);
  });

  it("rejects a blank explicit applicationAttemptId", async () => {
    const opportunity = await createOpportunity();
    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: "   ",
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Blank id",
    });
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ code: "INVALID_ID" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(0);
  });
});
