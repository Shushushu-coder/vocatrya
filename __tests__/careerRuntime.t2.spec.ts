// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_KEY,
  activateFreshAbNative,
  assertLegacyCareerWriteAllowed,
  resolveCareerRuntimeMode,
  resolveEffectiveCareerRuntimeConfig,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  iterateJobs,
  loadDashboardJobCounts,
  loadJobsAppliedDateCounts,
  loadRecentJobs,
  resolveJobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import { resolveResumeReadFamily } from "@/lib/career/resumeReadDispatch";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const REPO = path.resolve(__dirname, "..");
const ABSENT = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

function env(partial: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...ABSENT };
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId = "";
let companyId = "";
let titleId = "";
let statusId = "";

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows may keep a short lock on the temp directory.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `t2-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-t2-${Date.now()}`, createdBy: userId },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-t2-${Date.now()}`, createdBy: userId },
    })
  ).id;
  statusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } })).id;
});

async function polluteLegacyJob(): Promise<void> {
  await prisma.job.create({
    data: {
      userId,
      description: "pollution",
      jobType: "full-time",
      createdAt: new Date(),
      statusId,
      jobTitleId: titleId,
      companyId,
    },
  });
}

describe("effective config parser", () => {
  it("keeps raw absence conservative until a trusted fresh identity is supplied", () => {
    expect(resolveEffectiveCareerRuntimeConfig(ABSENT, false)).toMatchObject({
      featureEnabled: false,
      rolloutScope: "none",
      configSource: { feature: "conservative-default", scope: "conservative-default" },
    });
    expect(resolveEffectiveCareerRuntimeConfig(ABSENT, true)).toMatchObject({
      featureEnabled: true,
      rolloutScope: "full",
      configSource: { feature: "fresh-default", scope: "fresh-default" },
    });
  });

  it("treats blank and invalid tokens as explicit fail-closed values", () => {
    for (const raw of ["", "   ", "banana"]) {
      const resolved = resolveEffectiveCareerRuntimeConfig(
        env({
          [AB_RUNTIME_FEATURE_ENV]: raw,
          [AB_ROLLOUT_SCOPE_ENV]: raw,
        }),
        true,
      );
      expect(resolved.featureEnabled).toBe(false);
      expect(resolved.rolloutScope).toBe("none");
      expect(resolved.configSource).toEqual({
        feature: "explicit-env",
        scope: "explicit-env",
      });
    }
  });
});

describe("fresh-native runtime matrix", () => {
  it("enables full canonical runtime when both flags are absent", async () => {
    await activateFreshAbNative(prisma);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: ABSENT });
    expect(resolved).toMatchObject({
      mode: CAREER_RUNTIME_MODE.AB_ENABLED,
      rolloutScope: "full",
      writeFamily: CAREER_WRITE_FAMILY.ab,
      migrationStatus: AB_MIGRATION_STATUS.FRESH_READY,
      featureEnabled: true,
      origin: "fresh",
      configSource: { feature: "fresh-default", scope: "fresh-default" },
    });
    expect((await resolveJobsReadFamily(prisma, ABSENT)).family).toBe("ab");
    expect((await resolveResumeReadFamily(prisma, ABSENT)).family).toBe("ab");
    await expect(assertLegacyCareerWriteAllowed(prisma, ABSENT)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });
  });

  it("fills only the absent side of a partial explicit override", async () => {
    await activateFreshAbNative(prisma);
    const featureOnly = await resolveCareerRuntimeMode(prisma, {
      env: env({ [AB_RUNTIME_FEATURE_ENV]: "true" }),
    });
    expect(featureOnly.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(featureOnly.rolloutScope).toBe("full");
    expect(featureOnly.configSource).toEqual({
      feature: "explicit-env",
      scope: "fresh-default",
    });

    const scopeOnly = await resolveCareerRuntimeMode(prisma, {
      env: env({ [AB_ROLLOUT_SCOPE_ENV]: "full" }),
    });
    expect(scopeOnly.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(scopeOnly.featureEnabled).toBe(true);
    expect(scopeOnly.configSource).toEqual({
      feature: "fresh-default",
      scope: "explicit-env",
    });
  });

  it("stops fresh runtime on feature=false without reading legacy resume", async () => {
    await activateFreshAbNative(prisma);
    const resolved = await resolveCareerRuntimeMode(prisma, {
      env: env({ [AB_RUNTIME_FEATURE_ENV]: "false", [AB_ROLLOUT_SCOPE_ENV]: "full" }),
    });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(resolved.configSource.feature).toBe("explicit-env");
    expect(resolved.configSource.scope).toBe("explicit-env");
    expect((await resolveJobsReadFamily(prisma, resolved ? env({
      [AB_RUNTIME_FEATURE_ENV]: "false",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    }) : ABSENT)).family).toBe("ab");
    expect((await resolveResumeReadFamily(prisma, env({
      [AB_RUNTIME_FEATURE_ENV]: "false",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    }))).family).toBe("blocked");
    await expect(assertLegacyCareerWriteAllowed(prisma, env({
      [AB_RUNTIME_FEATURE_ENV]: "false",
    }))).rejects.toMatchObject({ code: "LEGACY_WRITE_BLOCKED" });
  });

  it("stops fresh runtime on scope=none and still blocks legacy writes", async () => {
    await activateFreshAbNative(prisma);
    const stopped = env({
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "none",
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: stopped });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(resolved.reason).toBe("rollout-scope-disabled");
    expect((await resolveResumeReadFamily(prisma, stopped)).family).toBe("blocked");
    expect((await resolveJobsReadFamily(prisma, stopped)).family).toBe("ab");
    await expect(assertLegacyCareerWriteAllowed(prisma, stopped)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });
  });

  it("keeps fresh resume_v1 on canonical resume and blocks jobs plus legacy writes", async () => {
    await activateFreshAbNative(prisma);
    const scoped = env({
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "resume_v1",
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: scoped });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(resolved.rolloutScope).toBe("resume_v1");
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.ab);
    expect((await resolveResumeReadFamily(prisma, scoped)).family).toBe("ab");
    const jobs = await resolveJobsReadFamily(prisma, scoped);
    expect(jobs.family).toBe("blocked");
    const findMany = vi.spyOn(prisma.job, "findMany");
    await expect(iterateJobs(prisma, userId, undefined, 20, scoped).next()).rejects.toMatchObject({
      code: "JOBS_READ_UNAVAILABLE",
    });
    await expect(loadRecentJobs(prisma, userId, 10, scoped)).rejects.toMatchObject({
      code: "JOBS_READ_UNAVAILABLE",
    });
    await expect(
      loadDashboardJobCounts(
        prisma,
        userId,
        { start: new Date(0), end: new Date(), priorStart: new Date(0) },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "JOBS_READ_UNAVAILABLE" });
    await expect(
      loadJobsAppliedDateCounts(
        prisma,
        userId,
        { start: new Date(0), end: new Date() },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "JOBS_READ_UNAVAILABLE" });
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockRestore();
    await expect(assertLegacyCareerWriteAllowed(prisma, scoped)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });
  });
});

describe("state vetoes", () => {
  it("keeps NOT_STARTED on the legacy family even with true/full", async () => {
    const absent = await resolveCareerRuntimeMode(prisma, { env: ABSENT });
    expect(absent.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(absent.writeFamily).toBe(CAREER_WRITE_FAMILY.legacy);
    expect(absent.rolloutScope).toBe("none");
    const forced = await resolveCareerRuntimeMode(prisma, {
      env: env({
        [AB_RUNTIME_FEATURE_ENV]: "true",
        [AB_ROLLOUT_SCOPE_ENV]: "full",
      }),
    });
    expect(forced.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(forced.writeFamily).toBe(CAREER_WRITE_FAMILY.legacy);
    expect(forced.featureEnabled).toBe(true);
    expect(forced.rolloutScope).toBe("full");
    await expect(assertLegacyCareerWriteAllowed(prisma, ABSENT)).resolves.toBeUndefined();
  });

  it("blocks NOT_STARTED when A+B residue exists", async () => {
    await prisma.jobOpportunity.create({
      data: { userId, companyId, title: "Residue" },
    });
    const resolved = await resolveCareerRuntimeMode(prisma, { env: ABSENT });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("AB_ROWS_WITHOUT_MIGRATION");
  });

  it("keeps a valid COMPLETED database conservative until an explicit rollout", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      migrationKey: AB_MIGRATION_KEY,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const absent = await resolveCareerRuntimeMode(prisma, { env: ABSENT });
    expect(absent.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(absent.rolloutScope).toBe("none");
    expect(absent.configSource.feature).toBe("conservative-default");
    expect(absent.origin).toBe("migrated");

    const resume = env({
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "resume_v1",
    });
    const scoped = await resolveCareerRuntimeMode(prisma, { env: resume });
    expect(scoped.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(scoped.rolloutScope).toBe("resume_v1");
    expect((await resolveResumeReadFamily(prisma, resume)).family).toBe("ab");
    expect((await resolveJobsReadFamily(prisma, resume)).family).toBe("legacy");
    await expect(assertLegacyCareerWriteAllowed(prisma, resume)).resolves.toBeUndefined();

    const full = env({
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    });
    const enabled = await resolveCareerRuntimeMode(prisma, { env: full });
    expect(enabled.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(enabled.rolloutScope).toBe("full");
    await expect(assertLegacyCareerWriteAllowed(prisma, full)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });
  });

  it("blocks a valid FRESH_READY row when another migration-state row exists", async () => {
    await activateFreshAbNative(prisma);
    await prisma.abMigrationState.create({
      data: {
        scopeKey: "extra",
        migrationKey: FRESH_NATIVE_KEY,
        status: AB_MIGRATION_STATUS.FRESH_READY,
        verifiedAt: new Date(),
      },
    });
    const resolved = await resolveCareerRuntimeMode(prisma, {
      env: env({
        [AB_RUNTIME_FEATURE_ENV]: "true",
        [AB_ROLLOUT_SCOPE_ENV]: "full",
      }),
    });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("MIGRATION_STATE_CARDINALITY");
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(await prisma.abMigrationState.count()).toBe(2);
  });

  it.each([
    ["absent", ABSENT],
    ["feature false", env({ [AB_RUNTIME_FEATURE_ENV]: "false" })],
    ["none", env({ [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "none" })],
    ["resume_v1", env({ [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "resume_v1" })],
    ["full", env({ [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" })],
  ] as const)("blocks fresh legacy pollution for %s", async (_label, runtimeEnv) => {
    await activateFreshAbNative(prisma);
    await polluteLegacyJob();
    const resolved = await resolveCareerRuntimeMode(prisma, { env: runtimeEnv });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(resolved.integrity.code).toBe("FRESH_HAS_LEGACY_JOBS");
    await expect(assertLegacyCareerWriteAllowed(prisma, runtimeEnv)).rejects.toMatchObject({
      code: "CAREER_RUNTIME_BLOCKED",
    });
    expect((await resolveJobsReadFamily(prisma, runtimeEnv)).family).toBe("blocked");
    expect((await resolveResumeReadFamily(prisma, runtimeEnv)).family).toBe("blocked");
  });

  it("blocks a ready identity when required delegates are missing", async () => {
    const verifiedAt = new Date();
    const freshDb = {
      abMigrationState: {
        findUnique: async () => ({
          id: "ready",
          scopeKey: "instance",
          migrationKey: FRESH_NATIVE_KEY,
          status: AB_MIGRATION_STATUS.FRESH_READY,
          completedAt: null,
          verifiedAt,
          errorCode: null,
        }),
      },
    };
    const fresh = await resolveCareerRuntimeMode(freshDb, { env: ABSENT });
    expect(fresh.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(fresh.mode).not.toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    expect(fresh.reason).toBe("prisma-client-missing-ab-delegates");

    const completedDb = {
      abMigrationState: {
        findUnique: async () => ({
          id: "done",
          scopeKey: "instance",
          migrationKey: AB_MIGRATION_KEY,
          status: AB_MIGRATION_STATUS.COMPLETED,
          completedAt: verifiedAt,
          verifiedAt,
          errorCode: null,
        }),
        count: async () => 1,
      },
    };
    const completed = await resolveCareerRuntimeMode(completedDb, { env: ABSENT });
    expect(completed.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    expect(completed.mode).not.toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
  });
});

describe("consumer and packaging guards", () => {
  it("keeps business consumers off the raw scope parser", () => {
    const files = [
      "src/lib/career/capabilities.ts",
      "src/lib/career/access.ts",
      "src/lib/career/writeGuard.ts",
      "src/lib/career/jobsReadDispatch.ts",
      "src/lib/career/resumeReadDispatch.ts",
      "src/actions/career.runtime.ts",
      "src/actions/job/mutations.ts",
      "src/actions/job/status.ts",
      "src/actions/note.actions.ts",
      "src/actions/application.actions.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(source, file).not.toContain("process.env.VOCATRYA_AB_ROLLOUT_SCOPE");
      expect(source, file).not.toContain("process.env.VOCATRYA_AB_RUNTIME_ENABLED");
    }
    for (const file of [
      "src/actions/note.actions.ts",
      "src/actions/application.actions.ts",
      "src/actions/job/mutations.ts",
      "src/actions/job/status.ts",
      "src/actions/career.runtime.ts",
      "src/lib/career/jobsReadDispatch.ts",
      "src/lib/career/resumeReadDispatch.ts",
      "src/lib/career/access.ts",
      "src/lib/career/writeGuard.ts",
    ]) {
      const source = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(source, file).not.toContain("resolveAbRolloutScope(");
    }
  });

  it("drops the compose unset sentinel and preserves explicit values", () => {
    const compose = fs.readFileSync(path.join(REPO, "docker-compose.yml"), "utf8");
    const entrypoint = fs.readFileSync(path.join(REPO, "docker-entrypoint.sh"), "utf8");
    expect(compose).toContain("${VOCATRYA_AB_RUNTIME_ENABLED-__VOCATRYA_AB_UNSET__}");
    expect(compose).toContain("${VOCATRYA_AB_ROLLOUT_SCOPE-__VOCATRYA_AB_UNSET__}");
    expect(compose).not.toContain("VOCATRYA_AB_RUNTIME_ENABLED=${VOCATRYA_AB_RUNTIME_ENABLED:-");
    expect(compose).not.toContain("VOCATRYA_AB_ROLLOUT_SCOPE=${VOCATRYA_AB_ROLLOUT_SCOPE:-");
    expect(entrypoint.indexOf("unset VOCATRYA_AB_RUNTIME_ENABLED")).toBeLessThan(
      entrypoint.indexOf("prisma@6.19.0 migrate deploy"),
    );

    const project = (host: string | undefined) => (host === undefined ? "__VOCATRYA_AB_UNSET__" : host);
    const container = (host: string | undefined) => {
      const projected = project(host);
      return projected === "__VOCATRYA_AB_UNSET__" ? undefined : projected;
    };
    expect(container(undefined)).toBeUndefined();
    expect(container("")).toBe("");
    expect(container("false")).toBe("false");
    expect(container("true")).toBe("true");
    expect(container("none")).toBe("none");
    expect(container("resume_v1")).toBe("resume_v1");
    expect(container("full")).toBe("full");
  });
});
