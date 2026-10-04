// @vitest-environment node
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { seedAccount } from "./helpers/backupTestDb";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_KEY,
  activateFreshAbNative,
  resolveCareerRuntimeMode,
} from "@/lib/career";

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

vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

let userId: string;

beforeAll(async () => {
  const uploadsDir = `${ctx.dir}/uploads`;
  fs.mkdirSync(`${uploadsDir}/files/resumes`, { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
  userId = await seedAccount(prisma, "phase7-backup@example.com");
  await activateFreshAbNative(prisma);
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

describe("Phase 7 FRESH_READY backup v2", () => {
  it("preserves FRESH_READY and does not auto-enable A+B after restore", async () => {
    const before = await prisma.abMigrationState.findFirstOrThrow();
    expect(before.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(before.migrationKey).toBe(FRESH_NATIVE_KEY);

    const { buffer } = await buildBackupZip(userId, "phase7-backup@example.com");

    await prisma.abMigrationState.updateMany({
      data: {
        status: AB_MIGRATION_STATUS.NOT_STARTED,
        migrationKey: "tampered",
        verifiedAt: null,
      },
    });

    await importBackup(buffer, userId, "phase7-backup@example.com", true);

    const restored = await prisma.abMigrationState.findFirstOrThrow();
    expect(restored.status).toBe(AB_MIGRATION_STATUS.FRESH_READY);
    expect(restored.migrationKey).toBe(FRESH_NATIVE_KEY);
    expect(restored.verifiedAt).not.toBeNull();
    expect(await prisma.dataMigrationRun.count()).toBe(0);

    const absent = { ...process.env };
    delete absent[AB_RUNTIME_FEATURE_ENV];
    delete absent[AB_ROLLOUT_SCOPE_ENV];
    const defaults = await resolveCareerRuntimeMode(prisma, { env: absent });
    expect(defaults.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(defaults.rolloutScope).toBe("full");
    expect(defaults.writeFamily).toBe(CAREER_WRITE_FAMILY.ab);

    const stopped = await resolveCareerRuntimeMode(prisma, {
      env: { ...absent, [AB_RUNTIME_FEATURE_ENV]: "false" },
    });
    expect(stopped.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);

    const on = await resolveCareerRuntimeMode(prisma, {
      env: { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" },
    });
    expect(on.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
  }, 120_000);
});
