// @vitest-environment node
//
// Adaptive overview data-state contract (Dashboard V2.1). TRUE_EMPTY is a
// provable fact — never inferred from the four headline metrics being zero —
// so each tracked domain (positions, tasks, activities, user questions) gets
// its own "history exists" case, in both read families. A blocked family and
// a real query failure must surface as unknown/error, never as "empty".
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
import { getOverviewDataState } from "@/actions/dashboard.actions";
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
  userId = await seedAccount(prisma, `dash-adaptive-${Date.now()}@example.com`);
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

async function seedLegacyJob(options: { status: string } = { status: "new" }) {
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
    },
  });
}

async function seedTask(status = "in-progress") {
  return prisma.task.create({
    data: { userId, title: `task-${randomUUID()}`, status },
  });
}

async function seedActivityType() {
  return prisma.activityType.create({
    data: {
      label: "Deep Work",
      value: `at-${randomUUID()}`,
      createdBy: userId,
    },
  });
}

async function seedQuestion(
  options: { preset?: boolean; deleted?: boolean } = {},
) {
  return prisma.question.create({
    data: {
      question: `q-${randomUUID()}`,
      createdBy: userId,
      createdVia: options.preset ? "PRESET:core" : null,
      presetBankKey: options.preset ? "core" : null,
      presetItemKey: options.preset ? randomUUID() : null,
      deletedAt: options.deleted ? new Date() : null,
    },
  });
}

async function activateAb() {
  vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
  vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
  await activateFreshAbNative(prisma);
  expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
}

describe("legacy read family", () => {
  it("reports empty for a brand-new account with no records", async () => {
    expect((await resolveJobsReadFamily(prisma)).family).toBe("legacy");
    expect(await getOverviewDataState()).toBe("empty");
  });

  it("reports nonempty with a single position record", async () => {
    await seedLegacyJob({ status: "new" });
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty when only an archived position exists", async () => {
    await seedLegacyJob({ status: "archived" });
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty when only rejected/applied history exists", async () => {
    await seedLegacyJob({ status: "rejected" });
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty with a single task record", async () => {
    await seedTask();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty when only completed tasks exist", async () => {
    await seedTask("complete");
    await seedTask("cancelled");
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("stays empty when only a task-category dictionary row exists", async () => {
    await seedActivityType();
    expect(await getOverviewDataState()).toBe("empty");
  });

  it("reports nonempty with only a user-created question", async () => {
    await seedQuestion();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("stays empty when the only questions are preset-bank installs", async () => {
    await seedQuestion({ preset: true });
    expect(await getOverviewDataState()).toBe("empty");
  });

  it("stays empty when the only user question is soft-deleted", async () => {
    await seedQuestion({ deleted: true });
    expect(await getOverviewDataState()).toBe("empty");
  });

  it("reports nonempty when only an interview session exists", async () => {
    await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1",
      },
    });
    expect(await getOverviewDataState()).toBe("nonempty");
  });
});

describe("ab read family", () => {
  it("reports empty for a fresh-native account with no records", async () => {
    await activateAb();
    expect(await getOverviewDataState()).toBe("empty");
  });

  it("reports nonempty with a single opportunity record", async () => {
    await activateAb();
    const company = await prisma.company.create({
      data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
    });
    await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "Engineer" },
    });
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty when only an archived opportunity exists", async () => {
    await activateAb();
    const company = await prisma.company.create({
      data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
    });
    await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "Engineer",
        archivedAt: new Date(),
      },
    });
    expect(await getOverviewDataState()).toBe("nonempty");
  });
});

describe("blocked and failing reads", () => {
  it("reports unknown — never empty — when the jobs family is blocked", async () => {
    await blockCareerRuntime();
    expect((await resolveJobsReadFamily(prisma)).family).toBe("blocked");
    expect(await getOverviewDataState()).toBe("unknown");
  });

  it("still reports nonempty under a blocked family when other records exist", async () => {
    await blockCareerRuntime();
    await seedTask();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("lets real query failures reject instead of disguising them as empty", async () => {
    const taskCount = vi
      .spyOn(prisma.task, "count")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getOverviewDataState()).rejects.toThrow("sqlite exploded");
    taskCount.mockRestore();
  });
});
