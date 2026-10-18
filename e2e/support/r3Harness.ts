import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { activateFreshAbNative } from "@/lib/career/freshActivation";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { setupTestUser } from "./setupTestUser";

// The three R3 Playwright configs share one contract: an isolated evidence
// directory and an operator-provisioned, already-migrated legacy SQLite file.
// Both must come from the environment — never from .env — so real developer
// credentials and database paths cannot leak into a suite run.
export function requireR3HarnessEnv() {
  const missing = ["R3_EVIDENCE_DIR", "DATABASE_URL"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(" and ")} to isolated synthetic paths.`,
    );
  }
  return { evidenceDir: path.resolve(process.env.R3_EVIDENCE_DIR!) };
}

// `output: "standalone"` makes `next start` refuse to serve; the R3 servers
// run .next/standalone/server.js instead. Standalone tracing ships only
// server code, so static chunks and public assets are copied beside it —
// without them the suites render pages without CSS or client JS.
export function ensureR3StandaloneAssets(repoRoot: string) {
  const standaloneDir = path.join(repoRoot, ".next", "standalone");
  if (!existsSync(path.join(standaloneDir, "server.js"))) {
    throw new Error(
      "[R3 harness] .next/standalone/server.js is missing. Run `npm run build` before the R3 suites.",
    );
  }
  cpSync(path.join(repoRoot, ".next", "static"), path.join(standaloneDir, ".next", "static"), {
    recursive: true,
  });
  const publicDir = path.join(repoRoot, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, path.join(standaloneDir, "public"), { recursive: true });
  }
}

// One Playwright webServer shape for all three configs. The command goes
// through r3ServerLauncher.mjs, which respawns the standalone server with a
// fixed synthetic environment — Playwright merges webServer.env over the
// operator's process.env, so a dedicated child env is the only way to keep
// real credentials and ambient flags out of the app server. extraEnv adds
// per-server pins (the fresh-native AB gates) as launcher KEY=VALUE args.
export function r3WebServer(
  port: number,
  databaseUrl: string,
  repoRoot: string,
  extraEnv: Record<string, string> = {},
) {
  ensureR3StandaloneAssets(repoRoot);
  const launcher = path.join(repoRoot, "e2e", "support", "r3ServerLauncher.mjs");
  const args = [
    JSON.stringify(process.execPath),
    JSON.stringify(launcher),
    String(port),
    JSON.stringify(databaseUrl),
    ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
  ];
  return {
    cwd: repoRoot,
    command: args.join(" "),
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  };
}

// The Interview Reflection tests need a real fresh-native runtime, and the
// marker lives in abMigrationState, so it must sit in a database nothing
// else reads. The disposable file lives beside the run's other synthetic
// artifacts in R3_EVIDENCE_DIR.
export const R3_FRESH_NATIVE_PORT = 3751;

export function resolveR3FreshNativeDatabase(evidenceDir?: string) {
  const dir = evidenceDir ?? requireR3HarnessEnv().evidenceDir;
  const file = path.join(dir, "fresh-native.db");
  return { path: file, url: `file:${file.replace(/\\/g, "/")}` };
}

// `next start` opens the database during instrumentation, so the file must
// already be a migrated SQLite database before the web server boots; schema
// setup therefore runs synchronously at config load. `migrate deploy` is
// idempotent — a file left by an earlier run just re-verifies.
export function provisionR3FreshNativeSchema(
  fresh: { path: string; url: string },
  repoRoot: string,
) {
  mkdirSync(path.dirname(fresh.path), { recursive: true });
  // Prisma's Windows schema engine requires the SQLite file to exist.
  if (!existsSync(fresh.path)) writeFileSync(fresh.path, "");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "deploy",
        "--schema",
        path.join(repoRoot, "prisma", "schema.prisma"),
      ],
      {
        env: { ...process.env, DATABASE_URL: fresh.url },
        stdio: "pipe",
      },
    );
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr).trim()
        : "";
    throw new Error(
      `[R3 harness] Could not provision the disposable fresh-native database at ${fresh.path}. Delete it (or use a clean R3_EVIDENCE_DIR) and retry.${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

// Seeds the shared fixture identity, then activates through the same code
// path as `ab:init-fresh --confirm` — the eligibility gate is part of what
// makes activation safe. A rejected activation throws with the blocker list,
// so a stale disposable database fails loudly instead of degrading the suite
// to a legacy surface.
export async function provisionR3FreshNativeData(
  prisma: PrismaClient,
  freshPath: string,
) {
  await setupTestUser(prisma);
  try {
    await activateFreshAbNative(prisma);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[R3 harness] Fresh-native activation failed for ${freshPath}: ${detail}. Delete the disposable database and retry.`,
    );
  }
  const resolved = await resolveJobsReadFamily(prisma, {});
  if (resolved.family !== "ab") {
    throw new Error(
      `[R3 harness] fresh-native database resolves jobs read family "${resolved.family}" (${resolved.reason}); expected "ab". Delete ${freshPath} and retry.`,
    );
  }
}

// The shared R3 database must keep its legacy career family: a leaked
// FRESH_READY or migrated marker would silently rewrite which read/write
// surface every page exercises, and a polluted fresh marker blocks the
// instance entirely. Fail setup with the resolved reason instead of
// discovering it as a wrong-surface pass or a confusing blocked page. The
// empty env argument makes the check independent of ambient VOCATRYA_AB_*
// values in the operator's shell.
export async function assertR3LegacyJobsFamily(databaseUrl: string) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const resolved = await resolveJobsReadFamily(prisma, {});
    if (resolved.family !== "legacy") {
      throw new Error(
        `[R3 harness] DATABASE_URL resolves jobs read family "${resolved.family}" (${resolved.reason}); the R3 suites require an unmarked legacy database. Provision a clean migrated SQLite file and retry.`,
      );
    }
    console.log("[E2E setup] Shared database resolves the legacy jobs family.");
  } finally {
    await prisma.$disconnect();
  }
}
