import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
export const AB_FOUNDATION_MIGRATION = "add_vocatrya_ab_foundation";
export const PROCESS_STEP_DEADLINE_MIGRATION = "add_process_step_deadline_at";
export const CAMPUS_CORE_FIELDS_MIGRATION = "add_campus_core_fields";
export const INTERVIEW_REFLECTION_MIGRATION = "add_interview_reflection_items";
export const CANDIDATE_PROFILE_MIGRATION =
  "rename_resume_contact_profile_to_candidate_profile";
export const PHASE3A_INTERVIEW_MIGRATION = "phase3a_interview_schema";
export const ACCOUNT_LOGIN_FOUNDATION_MIGRATION =
  "phase_account_login_connection_foundation";
export const RESUME_TITLE_SNAPSHOT_MIGRATION = "resume_material_title_snapshot";

export function makeAbTestDbUrl(): { url: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-ab-schema-"));
  const dbPath = path.join(dir, "test.db").replace(/\\/g, "/");
  // Prisma migrate deploy on Windows requires an existing disposable file.
  fs.writeFileSync(dbPath, "");
  return { url: `file:${dbPath}`, dir };
}

function copyMigrations(dest: string, excludeSuffixes: string[] = []): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (excludeSuffixes.some((suffix) => name.endsWith(suffix))) continue;
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dest, name), {
      recursive: true,
    });
  }
}

export function preparePrismaProject(
  dir: string,
  options: { excludeFoundation?: boolean; excludeSuffix?: string | string[] } = {},
): string {
  const schemaPath = path.join(dir, "schema.prisma");
  fs.copyFileSync(SCHEMA_PATH, schemaPath);
  const excludeSuffixes = [
    ...(options.excludeFoundation ? [AB_FOUNDATION_MIGRATION] : []),
    ...(options.excludeSuffix
      ? Array.isArray(options.excludeSuffix)
        ? options.excludeSuffix
        : [options.excludeSuffix]
      : []),
  ];
  copyMigrations(path.join(dir, "migrations"), excludeSuffixes);
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

export function copyMigrationBySuffix(projectDir: string, suffix: string): void {
  const source = fs
    .readdirSync(MIGRATIONS_DIR)
    .find((name) => name.endsWith(suffix));
  if (!source) {
    throw new Error(`Missing ${suffix} migration`);
  }
  fs.cpSync(
    path.join(MIGRATIONS_DIR, source),
    path.join(projectDir, "migrations", source),
    { recursive: true },
  );
}

export function copyFoundationMigrationInto(projectDir: string): void {
  copyMigrationBySuffix(projectDir, AB_FOUNDATION_MIGRATION);
}

export function listMigrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Prepare a project containing only the migrations up to and including the
 * one whose name ends with `cutoffSuffix` (timestamp order). This models the
 * database "as of" that migration; later migrations may rebuild tables, so a
 * prior state must never mix newer migrations in and apply older ones later.
 */
export function preparePrismaProjectThrough(
  dir: string,
  cutoffSuffix: string,
): string {
  const names = listMigrationNames();
  const cutoff = names.findIndex((name) => name.endsWith(cutoffSuffix));
  if (cutoff < 0) {
    throw new Error(`Missing ${cutoffSuffix} migration`);
  }
  const schemaPath = path.join(dir, "schema.prisma");
  fs.copyFileSync(SCHEMA_PATH, schemaPath);
  const dest = path.join(dir, "migrations");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of names.slice(0, cutoff + 1)) {
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dest, name), {
      recursive: true,
    });
  }
  return schemaPath;
}

/** Copy every migration not yet present in the project (the upgrade wave). */
export function copyRemainingMigrations(projectDir: string): void {
  const dest = path.join(projectDir, "migrations");
  for (const name of listMigrationNames()) {
    if (fs.existsSync(path.join(dest, name))) continue;
    fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dest, name), {
      recursive: true,
    });
  }
}
