// @vitest-environment node
//
// getOverviewDataState domain extension (frozen contract §2.3 / §9 D6):
// CareerMaterialItem, ResumeVariant (ab resume family) and legacy Resume rows
// join the "has started" evidence set, so a user who only built resume-side
// records is no longer classified as a fresh user. A blocked resume family
// contributes no evidence — it cannot fabricate either verdict.
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import {
  AB_INSTANCE_SCOPE_KEY,
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
  writeInstanceMigrationState,
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
import { resolveResumeReadFamily } from "@/lib/career/resumeReadDispatch";

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
  userId = await seedAccount(
    prisma,
    `datastate-resume-${Date.now()}@example.com`,
  );
  (getCurrentUser as any).mockResolvedValue({ id: userId });
});

async function activateFreshFull() {
  vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
  vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
  await activateFreshAbNative(prisma);
  expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
  expect((await resolveResumeReadFamily(prisma)).family).toBe("ab");
}

async function seedLegacyResume() {
  const profile = await prisma.profile.create({ data: { userId } });
  return prisma.resume.create({
    data: { profileId: profile.id, title: "resume" },
  });
}

async function seedMaterial(archived = false) {
  return prisma.careerMaterialItem.create({
    data: {
      userId,
      type: "EMPLOYMENT",
      title: "material",
      archivedAt: archived ? new Date() : null,
    },
  });
}

async function seedVariant(archived = false) {
  return prisma.resumeVariant.create({
    data: {
      userId,
      name: "variant",
      archivedAt: archived ? new Date() : null,
    },
  });
}

describe("legacy resume family", () => {
  it("reports nonempty when the only record is a legacy Resume", async () => {
    expect((await resolveResumeReadFamily(prisma)).family).toBe("legacy");
    await seedLegacyResume();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("stays empty when a bare Profile owns no resumes", async () => {
    await prisma.profile.create({ data: { userId } });
    expect(await getOverviewDataState()).toBe("empty");
  });
});

describe("ab resume family (fresh-native full)", () => {
  it("reports nonempty when the only record is a career material", async () => {
    await activateFreshFull();
    await seedMaterial();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("reports nonempty when the only record is a resume variant", async () => {
    await activateFreshFull();
    await seedVariant();
    expect(await getOverviewDataState()).toBe("nonempty");
  });

  it("stays empty when the only resume-side records are archived", async () => {
    await activateFreshFull();
    await seedMaterial(true);
    await seedVariant(true);
    expect(await getOverviewDataState()).toBe("empty");
  });
});

describe("migrated READY_DISABLED (ab jobs + legacy resume)", () => {
  it("reports nonempty when the only record is a legacy Resume", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
    expect((await resolveResumeReadFamily(prisma)).family).toBe("legacy");
    await seedLegacyResume();
    expect(await getOverviewDataState()).toBe("nonempty");
  });
});

describe("blocked families", () => {
  it("reports unknown — a blocked resume family fabricates no evidence", async () => {
    await prisma.abMigrationState.create({
      data: {
        scopeKey: AB_INSTANCE_SCOPE_KEY,
        migrationKey: AB_MIGRATION_KEY,
        status: AB_MIGRATION_STATUS.IN_PROGRESS,
      },
    });
    expect((await resolveResumeReadFamily(prisma)).family).toBe("blocked");
    // Even rows that physically exist cannot be trusted through a blocked
    // family: the verdict falls back to the jobs family's unknown.
    await seedMaterial();
    expect(await getOverviewDataState()).toBe("unknown");
  });
});
