import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
export const AB_FOUNDATION_MIGRATION = "add_vocatrya_ab_foundation";

export function makeAbTestDbUrl(): { url: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-ab-schema-"));
  const dbPath = path.join(dir, "test.db").replace(/\\/g, "/");
  return { url: `file:${dbPath}`, dir };
}

function copyMigrations(dest: string, excludeSuffix?: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (excludeSuffix && name.endsWith(excludeSuffix)) continue;
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dest, name), {
      recursive: true,
    });
  }
}

export function preparePrismaProject(
  dir: string,
  options: { excludeFoundation?: boolean } = {},
): string {
  const schemaPath = path.join(dir, "schema.prisma");
  fs.copyFileSync(SCHEMA_PATH, schemaPath);
  copyMigrations(
    path.join(dir, "migrations"),
    options.excludeFoundation ? AB_FOUNDATION_MIGRATION : undefined,
  );
  return schemaPath;
}

export function migrateDeploy(url: string, schemaPath: string): void {
  const prismaCli = path.join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "migrate", "deploy", "--schema", schemaPath],
    {
      env: { ...process.env, DATABASE_URL: url },
      cwd: REPO_ROOT,
      stdio: "pipe",
    },
  );
}

export function copyFoundationMigrationInto(projectDir: string): void {
  const source = fs
    .readdirSync(MIGRATIONS_DIR)
    .find((name) => name.endsWith(AB_FOUNDATION_MIGRATION));
  if (!source) {
    throw new Error(`Missing ${AB_FOUNDATION_MIGRATION} migration`);
  }
  fs.cpSync(
    path.join(MIGRATIONS_DIR, source),
    path.join(projectDir, "migrations", source),
    { recursive: true },
  );
}
