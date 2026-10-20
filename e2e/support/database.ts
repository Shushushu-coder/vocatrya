import { loadEnvConfig } from "@next/env";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  assertConsistentReuseServerDatabase,
  assertIsolatedE2EDatabase,
  resolveE2EIsolationContext,
} from "./isolation";

// The checkout that owns this harness. Isolation topology is always
// evaluated against it -- never the ambient cwd -- so a config or spec run
// from another directory still protects this repository's real databases.
const E2E_REPO_ROOT = path.resolve(__dirname, "..", "..");

// Match next dev's environment loading. Resolve before creating any Prisma
// client, including when node_modules is shared with another worktree.
export function resolveE2EDatabase(databaseUrl: string, projectDir = process.cwd()) {
  if (!databaseUrl.startsWith("file:") || databaseUrl.includes("?") || databaseUrl === "file::memory:") {
    throw new Error("E2E setup requires a local, migrated SQLite file DATABASE_URL.");
  }
  const file = databaseUrl.slice("file:".length);
  if (!file) throw new Error("E2E DATABASE_URL must name a SQLite file.");
  // Fail before writing if the database has not been provisioned by migrations.
  const databasePath = realpathSync(path.resolve(projectDir, "prisma", file));
  return { path: databasePath, url: `file:${databasePath.replace(/\\/g, "/")}` };
}

// Resolves DATABASE_URL and proves the target passes the shared isolation
// contract (e2e/support/isolation.ts) before returning it. This is the
// write gate every harness entry point inherits: playwright.config.ts runs
// it at module load -- before the webServer boots and before R3 fresh
// provisioning -- global setup runs it before opening PrismaClient, and
// direct spec clients call it before any write. Under
// E2E_REUSE_EXISTING_SERVER the declared server database must pass the
// same gate and be the same file; that proves the declared endpoints only,
// never which database a running server actually opened.
export function resolveIsolatedE2EDatabase(
  databaseUrl: string,
  projectDir = process.cwd(),
  env: Record<string, string | undefined> = process.env,
) {
  const database = resolveE2EDatabase(databaseUrl, projectDir);
  const context = resolveE2EIsolationContext(E2E_REPO_ROOT, env);
  assertIsolatedE2EDatabase(database.path, context);
  if (env.E2E_REUSE_EXISTING_SERVER === "1") {
    const serverUrl = env.E2E_SERVER_DATABASE_URL;
    let serverPath: string | null = null;
    if (serverUrl) {
      try {
        serverPath = resolveE2EDatabase(serverUrl, projectDir).path;
      } catch (error) {
        throw new Error(
          `E2E_SERVER_DATABASE_URL "${serverUrl}" does not resolve to a migrated SQLite file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    assertConsistentReuseServerDatabase(database.path, serverPath, context);
  }
  return database;
}

export function configureE2EDatabase(options?: { loadDotEnv?: boolean }) {
  // The R3 harness (R3_EVIDENCE_DIR set) requires a fully explicit synthetic
  // environment: DATABASE_URL must already be in the environment and .env
  // files are never consulted.
  const loadDotEnv = options?.loadDotEnv ?? !process.env.R3_EVIDENCE_DIR;
  if (loadDotEnv) loadEnvConfig(process.cwd(), true);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL before running E2E setup.");
  const database = resolveIsolatedE2EDatabase(databaseUrl);
  process.env.DATABASE_URL = database.url;
  return database;
}
