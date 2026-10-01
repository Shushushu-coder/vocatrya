import { loadEnvConfig } from "@next/env";
import { realpathSync } from "node:fs";
import path from "node:path";

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

export function configureE2EDatabase() {
  loadEnvConfig(process.cwd(), true);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL before running E2E setup.");
  const database = resolveE2EDatabase(databaseUrl);
  process.env.DATABASE_URL = database.url;
  return database;
}
