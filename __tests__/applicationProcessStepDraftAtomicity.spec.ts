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
const prisma2 = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const mockedUser = vi.mocked(getCurrentUser);

let userId: string;
let companyId: string;

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), prisma2.$disconnect()]);
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
    `draft-atomic-${Date.now()}-${Math.random()}@example.com`,
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
  await activateFreshAbNative(prisma);
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
  mockedUser.mockResolvedValue({
    id: userId,
    name: "Test",
    email: "t@example.com",
  } as never);
});

function services(client = prisma, ownerId = userId) {
  return {
    opportunities: new OpportunityService(client, ownerId, FEATURE_ON),
    applications: new ApplicationService(client, ownerId, FEATURE_ON),
  };
}

async function createOpportunity(client = prisma) {
  return services(client).opportunities.create({
    companyId,
    title: "Staff Engineer",
  });
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Two independent clients against the same SQLite file. `first` is held just
// after its ownership write-lock lands; `second` starts its transaction and
// then blocks on the SQLite writer until `first` commits.
function writerLockClients() {
  const locked = latch();
  const release = latch();
  const contender = latch();
  let firstWrite = true;
  let secondWrite = true;
  const first = prisma.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args);
        if (operation === "$executeRaw" && firstWrite) {
          firstWrite = false;
          locked.resolve();
          await release.promise;
        }
        return result;
      },
    },
  });
  const second = new Proxy(prisma2, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (...args: unknown[]) => {
          if (secondWrite) {
            secondWrite = false;
            contender.resolve();
          }
          return Reflect.apply(target.$transaction, target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    first: first as unknown as PrismaClient,
    second: second as unknown as PrismaClient,
    locked,
    release,
    contender,
  };
}

function failOnCreate(modelName: "ApplicationAttempt" | "ApplicationProcessStep") {
  let armed = true;
  return prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (armed && model === modelName && operation === "create") {
          armed = false;
          throw new Error(`forced ${modelName} create failure`);
        }
        return query(args);
      },
    },
  });
}
describe("explicit draft attempt creation", () => {
  it("atomically creates one DRAFT attempt and its first step", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();

    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Phone screen",
      notes: "bring portfolio",
    });

    const attempts = await prisma.applicationAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(step.applicationAttemptId).toBe(attempts[0].id);
    expect(attempts[0].currentStageCategory).toBe(ATTEMPT_STAGE.DRAFT);
    expect(attempts[0].outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(attempts[0].submittedAt).toBeNull();
    const persisted = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: step.id },
    });
    expect(persisted.source).toBe(PROCESS_STEP_SOURCE.USER);
    expect(persisted.status).toBe(PROCESS_STEP_STATUS.PENDING);
    expect(persisted.notes).toBe("bring portfolio");
  });

  it("rejects with STATE_CHANGED when one live attempt appeared before save", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const appeared = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Appeared meanwhile",
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Stale draft intent",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED" });

    expect(await prisma.applicationAttempt.count()).toBe(1);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    const untouched = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: appeared.id },
    });
    expect(untouched.currentStageCategory).toBe(ATTEMPT_STAGE.DRAFT);
    expect(untouched.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
  });

  it("rejects with STATE_CHANGED when several live attempts appeared", async () => {
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
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Stale draft intent",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED" });
    expect(await prisma.applicationAttempt.count()).toBe(2);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("still creates a fresh draft when only archived attempts exist", async () => {
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
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "New round",
    });
    const attempts = await prisma.applicationAttempt.findMany({
      where: { archivedAt: null },
    });
    expect(attempts).toHaveLength(1);
    expect(step.applicationAttemptId).toBe(attempts[0].id);
    expect(attempts[0].id).not.toBe(archived.id);
  });

  it("rejects createDraftAttempt combined with an explicit attempt id", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Existing",
    });

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        applicationAttemptId: attempt.id,
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Conflicting intents",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(1);
  });

  it("does not change submission facts when the draft intent is refused", async () => {
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

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "Late stage",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED" });

    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.submittedAt?.toISOString()).toBe(
      before.submittedAt?.toISOString(),
    );
    expect(after.currentStageCategory).toBe(before.currentStageCategory);
    expect(after.outcome).toBe(before.outcome);
  });

  it("rejects a draft intent for a missing or foreign opportunity without writes", async () => {
    const { applications } = services();
    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: "opp-missing",
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Nowhere",
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});
describe("transaction atomicity", () => {
  it("rolls back the new draft attempt when the step insert fails", async () => {
    const opportunity = await createOpportunity();
    const flaky = failOnCreate("ApplicationProcessStep");
    const applications = new ApplicationService(
      flaky as unknown as PrismaClient,
      userId,
      FEATURE_ON,
    );

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Will fail",
      }),
    ).rejects.toThrow("forced ApplicationProcessStep create failure");
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("produces no step when the attempt insert fails", async () => {
    const opportunity = await createOpportunity();
    const flaky = failOnCreate("ApplicationAttempt");
    const applications = new ApplicationService(
      flaky as unknown as PrismaClient,
      userId,
      FEATURE_ON,
    );

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        createDraftAttempt: true,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Will fail",
      }),
    ).rejects.toThrow("forced ApplicationAttempt create failure");
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("rolls back the auto-created attempt on the legacy path too", async () => {
    const opportunity = await createOpportunity();
    const flaky = failOnCreate("ApplicationProcessStep");
    const applications = new ApplicationService(
      flaky as unknown as PrismaClient,
      userId,
      FEATURE_ON,
    );

    await expect(
      applications.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Legacy failure",
      }),
    ).rejects.toThrow("forced ApplicationProcessStep create failure");
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});

describe("real SQLite writer serialization", { timeout: 30_000 }, () => {
  it("admits exactly one of two concurrent draft intents", async () => {
    const opportunity = await createOpportunity();
    const c = writerLockClients();
    const first = new ApplicationService(
      c.first,
      userId,
      FEATURE_ON,
    ).createUserProcessStep({
      jobOpportunityId: opportunity.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "First",
    });
    await c.locked.promise;
    const second = new ApplicationService(
      c.second,
      userId,
      FEATURE_ON,
    ).createUserProcessStep({
      jobOpportunityId: opportunity.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Second",
    });
    const settled = Promise.allSettled([first, second]);
    await c.contender.promise;
    c.release.resolve();
    const results = await settled;

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED" });

    const attempts = await prisma.applicationAttempt.findMany();
    const steps = await prisma.applicationProcessStep.findMany();
    expect(attempts).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(steps[0].applicationAttemptId).toBe(attempts[0].id);
  });

  it("serializes two legacy zero-candidate calls onto one attempt", async () => {
    const opportunity = await createOpportunity();
    const c = writerLockClients();
    const first = new ApplicationService(
      c.first,
      userId,
      FEATURE_ON,
    ).createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "First",
    });
    await c.locked.promise;
    const second = new ApplicationService(
      c.second,
      userId,
      FEATURE_ON,
    ).createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Second",
    });
    const settled = Promise.allSettled([first, second]);
    await c.contender.promise;
    c.release.resolve();
    const results = await settled;

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const attempts = await prisma.applicationAttempt.findMany();
    const steps = await prisma.applicationProcessStep.findMany();
    expect(attempts).toHaveLength(1);
    expect(steps).toHaveLength(2);
    expect(
      steps.every((step) => step.applicationAttemptId === attempts[0].id),
    ).toBe(true);
  });
});

describe("createApplicationProcessStep action contract", () => {
  it("creates the draft attempt and step through the action", async () => {
    const opportunity = await createOpportunity();

    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Phone screen",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    const attempts = await prisma.applicationAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(data?.applicationAttemptId).toBe(attempts[0].id);
  });

  it("surfaces STATE_CHANGED as a stable action code", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Appeared meanwhile",
    });

    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Stale",
    });
    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED",
    });
    expect(await prisma.applicationAttempt.count()).toBe(1);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("surfaces INVALID_INPUT when both intents are supplied", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Existing",
    });

    const result = await createApplicationProcessStep({
      jobOpportunityId: opportunity.id,
      applicationAttemptId: attempt.id,
      createDraftAttempt: true,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Conflict",
    });
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ code: "INVALID_INPUT" });
    expect(await prisma.applicationAttempt.count()).toBe(1);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});