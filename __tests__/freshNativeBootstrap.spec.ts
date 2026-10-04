// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_BOOTSTRAP_RESULT,
  FRESH_NATIVE_KEY,
  ensureFreshNativeState,
  ensureFreshNativeStateForActiveDatabase,
  isAbRuntimeFeatureEnabled,
  resolveAbRolloutScope,
  resolveCareerRuntimeMode,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  makeTestDbUrl,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const DISABLED_ENV = {
  NODE_ENV: "test",
  VOCATRYA_AB_RUNTIME_ENABLED: "",
  VOCATRYA_AB_ROLLOUT_SCOPE: "",
} as NodeJS.ProcessEnv;

const DEFAULT_ENV = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

function deployMigrations(url: string): void {
  const prismaCli = path.join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `migration deploy failed: exit ${result.status ?? "unknown"}\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

beforeAll(() => {
  deployMigrations(ctx.url);
}, 240_000);

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
});

async function stateRow() {
  return prisma.abMigrationState.findUnique({ where: { scopeKey: "instance" } });
}

async function expectUntouched(before: {
  id: string;
  status: string;
  migrationKey: string;
  completedAt: Date | null;
  verifiedAt: Date | null;
  errorCode: string | null;
  updatedAt: Date;
} | null) {
  const after = await stateRow();
  if (before === null) {
    expect(after).toBeNull();
    return;
  }
  expect(after).not.toBeNull();
  expect(after?.id).toBe(before.id);
  expect(after?.status).toBe(before.status);
  expect(after?.migrationKey).toBe(before.migrationKey);
  expect(after?.completedAt?.getTime() ?? null).toBe(before.completedAt?.getTime() ?? null);
  expect(after?.verifiedAt?.getTime() ?? null).toBe(before.verifiedAt?.getTime() ?? null);
  expect(after?.errorCode).toBe(before.errorCode);
  expect(after?.updatedAt.getTime()).toBe(before.updatedAt.getTime());
}

describe("ensureFreshNativeState", () => {
  it("activates a migrated database with no career rows", async () => {
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED,
      mutated: true,
    });
    const row = await stateRow();
    expect(row?.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(row?.migrationKey).toBe(FRESH_NATIVE_KEY);
    expect(row?.completedAt).toBeNull();
    expect(row?.verifiedAt).not.toBeNull();
    expect(await prisma.abMigrationState.count()).toBe(1);
  });

  it("is a no-op on the second startup", async () => {
    await ensureFreshNativeState(prisma);
    const before = await stateRow();
    const second = await ensureFreshNativeState(prisma);
    expect(second).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
      mutated: false,
    });
    await expectUntouched(before);
    expect(await prisma.abMigrationState.count()).toBe(1);
  });

  it("does not activate or rewrite a database that already has a legacy career root", async () => {
    const userId = await seedAccount(prisma, `legacy-${Date.now()}@example.com`);
    const title = await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-${Date.now()}`, createdBy: userId },
    });
    const company = await prisma.company.create({
      data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userId },
    });
    const status = await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } });
    await prisma.job.create({
      data: {
        userId,
        description: "Keep this legacy row",
        jobType: "full-time",
        createdAt: new Date(),
        statusId: status.id,
        jobTitleId: title.id,
        companyId: company.id,
      },
    });
    const beforeJobs = await prisma.job.count();
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_LEGACY_DATA,
      mutated: false,
    });
    expect(await prisma.job.count()).toBe(beforeJobs);
    expect(await prisma.abMigrationState.count()).toBe(0);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: DISABLED_ENV });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
  });

  it("does not activate when migration bookkeeping exists", async () => {
    const userId = await seedAccount(prisma, `map-${Date.now()}@example.com`);
    await prisma.legacyMigrationMap.create({
      data: {
        userId,
        legacyEntityType: "Job",
        legacyEntityId: "legacy-1",
        targetEntityType: "JobOpportunity",
        targetEntityId: "target-1",
        migrationVersion: AB_MIGRATION_KEY,
      },
    });
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE);
    expect(outcome.mutated).toBe(false);
    expect(await prisma.legacyMigrationMap.count()).toBe(1);
    expect(await prisma.abMigrationState.count()).toBe(0);

    await resetDisposableDb(prisma);
    const again = await seedAccount(prisma, `run-${Date.now()}@example.com`);
    await prisma.dataMigrationRun.create({
      data: {
        userId: again,
        version: AB_MIGRATION_KEY,
        mode: "apply",
        status: "COMPLETED",
      },
    });
    const second = await ensureFreshNativeState(prisma);
    expect(second.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE);
    expect(await prisma.dataMigrationRun.count()).toBe(1);
    expect(await prisma.abMigrationState.count()).toBe(0);
  });

  it("does not fabricate state over partial A+B residue", async () => {
    const userId = await seedAccount(prisma, `residue-${Date.now()}@example.com`);
    const company = await prisma.company.create({
      data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userId },
    });
    await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "Orphan opportunity" },
    });
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE,
      mutated: false,
    });
    expect(await prisma.jobOpportunity.count()).toBe(1);
    expect(await prisma.abMigrationState.count()).toBe(0);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: DISABLED_ENV });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
  });

  it("does not convert a COMPLETED migrated instance", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      migrationKey: AB_MIGRATION_KEY,
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
      verifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const before = await stateRow();
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_MIGRATED_INSTANCE,
      mutated: false,
    });
    await expectUntouched(before);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: DISABLED_ENV });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.migrationStatus).toBe(AB_MIGRATION_STATUS.COMPLETED);
  });

  it("does not repair a malformed FRESH_READY row", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FRESH_READY,
      migrationKey: "not-the-fresh-key",
      verifiedAt: new Date("2026-02-01T00:00:00.000Z"),
      completedAt: null,
    });
    const before = await stateRow();
    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome).toEqual({
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE,
      mutated: false,
    });
    await expectUntouched(before);
    const resolved = await resolveCareerRuntimeMode(prisma, { env: DISABLED_ENV });
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
  });

  it("leaves IN_PROGRESS and unverified FRESH_READY rows unchanged", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
      errorCode: null,
    });
    const inProgress = await stateRow();
    const first = await ensureFreshNativeState(prisma);
    expect(first.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE);
    await expectUntouched(inProgress);
    expect((await resolveCareerRuntimeMode(prisma, { env: DISABLED_ENV })).mode).toBe(
      CAREER_RUNTIME_MODE.BLOCKED,
    );

    await resetDisposableDb(prisma);
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FRESH_READY,
      migrationKey: FRESH_NATIVE_KEY,
      verifiedAt: null,
      completedAt: null,
    });
    const unverified = await stateRow();
    const second = await ensureFreshNativeState(prisma);
    expect(second.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE);
    await expectUntouched(unverified);
  });

  it("still activates when only shared catalogs are present", async () => {
    const userId = await seedAccount(prisma, `catalog-${Date.now()}@example.com`);
    const company = await prisma.company.create({
      data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userId },
    });
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-${Date.now()}`, createdBy: userId },
    });
    await prisma.location.create({
      data: { label: "Remote", value: `remote-${Date.now()}`, createdBy: userId },
    });
    await prisma.tag.create({
      data: { label: "Priority", value: `priority-${Date.now()}`, createdBy: userId },
    });
    await prisma.contact.create({
      data: { name: "Ada", createdBy: userId },
    });
    await prisma.question.create({
      data: { question: "Why this team?", createdBy: userId },
    });
    await prisma.task.create({
      data: { userId, title: "Follow up" },
    });
    const activityType = await prisma.activityType.create({
      data: { label: "Research", value: `research-${Date.now()}`, createdBy: userId },
    });
    await prisma.activity.create({
      data: {
        userId,
        activityName: "Read the posting",
        startTime: new Date(),
        activityTypeId: activityType.id,
      },
    });

    const outcome = await ensureFreshNativeState(prisma);
    expect(outcome.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED);
    expect(await prisma.company.count()).toBe(1);
    expect(company.id).toBeTruthy();
    expect((await stateRow())?.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
  });

  it("fails closed when an eligible activation write throws", async () => {
    const lines: string[] = [];
    const proxy = new Proxy({} as Record<string, unknown>, {
      get(_target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(receiver);
        }
        if (prop === "abMigrationState") {
          return {
            findUnique: async () => null,
            count: async () => 0,
            upsert: async () => {
              throw new Error("disk full");
            },
          };
        }
        if (typeof prop !== "string") return undefined;
        return {
          count: async () => 0,
          findMany: async () => [],
          findUnique: async () => null,
        };
      },
    });

    await expect(ensureFreshNativeStateForActiveDatabase({
      db: proxy as unknown as PrismaClient,
      log: (line) => lines.push(line),
    })).rejects.toThrow(/disk full/);
    expect(lines).toEqual(["fresh-native activation: failed"]);
    expect(lines.join("\n")).not.toContain("file:");
  });

  it("logs skip and failure outcomes without a database path", async () => {
    const lines: string[] = [];
    const skipped = await ensureFreshNativeStateForActiveDatabase({
      db: prisma,
      log: (line) => lines.push(line),
    });
    expect(skipped.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED);
    expect(lines).toEqual(["fresh-native activation: activated"]);

    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.FAILED,
      errorCode: "ROOT_FAILURE",
    });
    lines.length = 0;
    const failedState = await ensureFreshNativeStateForActiveDatabase({
      db: prisma,
      log: (line) => lines.push(line),
    });
    expect(failedState.result).toBe(FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE);
    expect(lines).toEqual(["fresh-native activation: skipped-not-eligible"]);
    expect(JSON.stringify(lines)).not.toContain("file:");
  });

  it("keeps current runtime defaults disabled after FRESH_READY", async () => {
    await ensureFreshNativeState(prisma);
    expect(isAbRuntimeFeatureEnabled(DEFAULT_ENV)).toBe(false);
    expect(resolveAbRolloutScope(DEFAULT_ENV)).toBe("none");
    const resolved = await resolveCareerRuntimeMode(prisma, { env: DEFAULT_ENV });
    expect(resolved.migrationStatus).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(resolved.writeFamily).toBe(CAREER_WRITE_FAMILY.blocked);
    expect(resolved.reason).toBe("feature-disabled");
  });

  it("settles concurrent first startups on one FRESH_READY row", async () => {
    const other = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      await other.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      const settled = await Promise.allSettled([
        ensureFreshNativeState(prisma),
        ensureFreshNativeState(other),
      ]);
      const row = await stateRow();
      expect(await prisma.abMigrationState.count()).toBe(1);
      expect(row?.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
      expect(row?.migrationKey).toBe(FRESH_NATIVE_KEY);
      expect(row?.completedAt).toBeNull();
      expect(row?.verifiedAt).not.toBeNull();
      const fulfilled = settled.filter((item) => item.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThan(0);
      for (const item of fulfilled) {
        if (item.status !== "fulfilled") continue;
        expect([
          FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED,
          FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
        ]).toContain(item.value.result);
      }
    } finally {
      await other.$disconnect();
    }
  });
});

describe("fresh-native startup entrypoints", () => {
  it("keeps Docker and Desktop flag defaults unchanged", () => {
    const entrypoint = fs.readFileSync(path.join(REPO_ROOT, "docker-entrypoint.sh"), "utf8");
    const migrateAt = entrypoint.indexOf("prisma@6.19.0 migrate deploy");
    const activateAt = entrypoint.indexOf("fresh-native-runtime/ensure-fresh-native.cjs");
    const serverAt = entrypoint.indexOf("node server.js");
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(activateAt).toBeGreaterThan(migrateAt);
    expect(serverAt).toBeGreaterThan(activateAt);
    expect(entrypoint).not.toContain("VOCATRYA_AB_RUNTIME_ENABLED");
    expect(entrypoint).not.toContain("VOCATRYA_AB_ROLLOUT_SCOPE");

    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("node scripts/build-fresh-native-bootstrap.mjs");
    expect(dockerfile).toContain("fresh-native-runtime");

    const runtime = fs.readFileSync(path.join(REPO_ROOT, "desktop", "main", "runtime.js"), "utf8");
    expect(runtime).toContain('VOCATRYA_AB_ROLLOUT_SCOPE: "none"');
    expect(runtime).not.toMatch(/VOCATRYA_AB_RUNTIME_ENABLED:\s*"true"/);
    expect(runtime).not.toMatch(/VOCATRYA_AB_ROLLOUT_SCOPE:\s*"full"/);

    const compose = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toContain("VOCATRYA_AB_RUNTIME_ENABLED=${VOCATRYA_AB_RUNTIME_ENABLED:-false}");
    expect(compose).toContain("VOCATRYA_AB_ROLLOUT_SCOPE=${VOCATRYA_AB_ROLLOUT_SCOPE:-none}");

    const example = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    expect(example).toContain("VOCATRYA_AB_ROLLOUT_SCOPE=none");
    expect(example).not.toMatch(/VOCATRYA_AB_RUNTIME_ENABLED=true/);
  });

  it("bootstraps a migrated database through the Node 20 entry and then no-ops", async () => {
    const built = spawnSync(process.execPath, ["scripts/build-fresh-native-bootstrap.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (built.status !== 0) {
      throw new Error(built.stderr || built.stdout || "bootstrap build failed");
    }
    const entryPath = path.join(REPO_ROOT, "fresh-native-runtime", "ensure-fresh-native.cjs");
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "voc-fresh-proof-"));
    const dbPath = path.join(proofDir, "app.db");
    const databaseUrl = `file:${dbPath.replace(/\\/g, "/")}`;
    try {
      deployMigrations(databaseUrl);
      const run = (extraArgs: string[] = []) =>
        spawnSync(process.execPath, [entryPath, ...extraArgs], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          encoding: "utf8",
          timeout: 120_000,
        });

      const refused = run(["--db", dbPath]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain("fresh-native activation: failed");
      expect(refused.stderr).toContain("does not accept arguments");

      const proof = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        expect(await proof.abMigrationState.count()).toBe(0);
        const first = run();
        expect(first.status).toBe(0);
        expect(first.stdout.trim()).toBe("fresh-native activation: activated");
        const row = await proof.abMigrationState.findFirstOrThrow();
        expect(row.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
        expect(row.migrationKey).toBe(FRESH_NATIVE_KEY);
        expect(row.completedAt).toBeNull();
        expect(row.verifiedAt).not.toBeNull();

        const second = run();
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("fresh-native activation: already-ready");
        const again = await proof.abMigrationState.findFirstOrThrow();
        expect(await proof.abMigrationState.count()).toBe(1);
        expect(again.updatedAt.getTime()).toBe(row.updatedAt.getTime());
        expect(again.verifiedAt?.getTime()).toBe(row.verifiedAt?.getTime());
      } finally {
        await proof.$disconnect();
      }
    } finally {
      fs.rmSync(proofDir, { recursive: true, force: true });
    }
  }, 240_000);
});
