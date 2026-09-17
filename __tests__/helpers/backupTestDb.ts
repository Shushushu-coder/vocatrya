import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { CONTACT_ROLES, JOB_SOURCES, JOB_STATUSES } from "@/lib/constants";

const DB_FILE_NAME = "test.db";
const TEMP_DIR_PREFIX = "jobsync-backup-";
const LOCK_POLL_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_AGE_MS = 5 * 60_000;

type LockOwner = {
  pid: number;
  token: string;
  createdAt: string;
};

export function makeTestDbUrl(): { url: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const dbPath = path.join(dir, DB_FILE_NAME).replace(/\\/g, "/");
  return { url: `file:${dbPath}`, dir };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function disposableDbPath(url: string): string {
  if (!url.startsWith("file:")) {
    throw new Error(`Test database must use a file: URL, received ${url}`);
  }

  const dbPath = path.resolve(url.slice("file:".length));
  const relativeToTemp = path.relative(path.resolve(os.tmpdir()), dbPath);
  const parentName = path.basename(path.dirname(dbPath));
  const isUnderTemp =
    relativeToTemp !== "" &&
    relativeToTemp !== ".." &&
    !relativeToTemp.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeToTemp);

  if (
    !isUnderTemp ||
    parentName.length <= TEMP_DIR_PREFIX.length ||
    !parentName.startsWith(TEMP_DIR_PREFIX) ||
    path.basename(dbPath) !== DB_FILE_NAME
  ) {
    throw new Error(
      `Refusing to initialize a non-disposable test database: ${dbPath}`,
    );
  }

  return dbPath;
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    if (
      typeof owner.pid !== "number" ||
      typeof owner.token !== "string" ||
      typeof owner.createdAt !== "string"
    ) {
      return null;
    }
    return owner as LockOwner;
  } catch {
    return null;
  }
}

function lockOwnerIsAlive(owner: LockOwner | null): boolean {
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function schemaPushLockDir(): string {
  const repoKey = createHash("sha256")
    .update(path.resolve(__dirname, "..", "..").toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `vocatrya-prisma-db-push-${repoKey}.lock`);
}

function acquireSchemaPushLock(): () => void {
  const lockDir = schemaPushLockDir();
  const startedAt = Date.now();
  const token = randomUUID();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        } satisfies LockOwner),
        "utf8",
      );
      return () => {
        if (readLockOwner(lockDir)?.token !== token) return;
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // A later caller can recover this lock after the owner exits.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      let lockAge = 0;
      try {
        lockAge = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        continue;
      }

      const owner = readLockOwner(lockDir);
      const canRecover =
        lockAge >= LOCK_MAX_AGE_MS ||
        (lockAge >= LOCK_STALE_MS && !lockOwnerIsAlive(owner));
      if (canRecover) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Another worker may have recovered it first.
        }
        continue;
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for Prisma schema initialization lock: ${lockDir}`,
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

// db push rather than migrate deploy: the round-trip asserts against the
// current schema, not the migration history, and push is much faster.
export function pushSchema(url: string): void {
  const dbPath = disposableDbPath(url);
  const template = process.env.VOCATRYA_TEST_DB_TEMPLATE;
  if (template && fs.existsSync(template)) {
    fs.copyFileSync(template, dbPath);
    return;
  }

  const prismaCli = path.join(
    __dirname,
    "..",
    "..",
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  const args = [
    prismaCli,
    "db",
    "push",
    "--skip-generate",
    "--accept-data-loss",
  ];
  const releaseLock = acquireSchemaPushLock();

  try {
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" },
      encoding: "utf8",
    });
    if (result.status === 0) return;

    const command = [process.execPath, ...args].join(" ");
    throw new Error(
      [
        "Prisma schema initialization failed.",
        `Command: ${command}`,
        `DATABASE_URL: file:${dbPath}`,
        `Exit code: ${result.status ?? "unknown"}`,
        `Signal: ${result.signal ?? "none"}`,
        `Spawn error: ${result.error?.message ?? "none"}`,
        `stdout:\n${result.stdout || "<empty>"}`,
        `stderr:\n${result.stderr || "<empty>"}`,
      ].join("\n"),
    );
  } finally {
    releaseLock();
  }
}

// Mirrors what signup() seeds, so "empty account" means the same thing here as
// it does in the app.
export async function seedAccount(
  prisma: PrismaClient,
  email: string,
): Promise<string> {
  for (const status of JOB_STATUSES) {
    await prisma.jobStatus.upsert({
      where: { value: status.value },
      update: {},
      create: { label: status.label, value: status.value },
    });
  }

  const user = await prisma.user.create({
    data: { id: randomUUID(), name: "Test User", email, password: "x" },
  });

  for (const source of JOB_SOURCES) {
    await prisma.jobSource.create({
      data: { label: source.label, value: source.value, createdBy: user.id },
    });
  }

  await prisma.contactRole.createMany({
    data: CONTACT_ROLES.map((role) => ({
      label: role.label,
      value: role.value,
      createdBy: user.id,
    })),
  });

  return user.id;
}
