// Vocatrya desktop database migration.
//
// Formal desktop startup chain for Prisma/SQLite: classify the database as
// fresh or existing, create a consistent pre-migration backup for existing
// databases, run the bundled offline `prisma migrate deploy`, verify the
// migration state independently of the CLI exit code, and require SQLite
// integrity before the backend is allowed to start. Any backup, migration,
// verification, integrity, or fresh-native activation failure is fail-closed:
// no backend start. Fresh activation runs only after migrate deploy has been
// verified. An ineligible database is left unchanged and startup continues.
//
// The migration child uses the bundled Node runtime plus the bundled Prisma
// CLI / Windows schema engine / schema / migrations assembled under
// `<backend>/prisma-runtime`. It never uses npx, npm, downloads, or Docker,
// and it runs with a minimal controlled environment (explicit DATABASE_URL
// plus desktop TEMP/TMP). In particular RUST_LOG/RUST_BACKTRACE and all
// secrets are stripped: RUST_LOG deterministically breaks the Prisma 6.19
// schema engine with an empty "Schema engine error:".
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildControlledEnv, runChild, runDbTool } = require("./db-runner");
const { createBackup } = require("./database-backup");

const MIGRATION_TIMEOUT_MS = 120000;
const FRESH_NATIVE_TIMEOUT_MS = 120000;

const FRESH_NATIVE_SUCCESS_LOGLINES = new Set([
  "fresh-native activation: activated",
  "fresh-native activation: already-ready",
  "fresh-native activation: skipped-not-eligible",
  "fresh-native activation: skipped-migrated",
]);

const FRESH_NATIVE_LOG_TO_RESULT = {
  "fresh-native activation: activated": "ACTIVATED",
  "fresh-native activation: already-ready": "ALREADY_FRESH_READY",
  "fresh-native activation: skipped-not-eligible": "SKIPPED_NOT_ELIGIBLE",
  "fresh-native activation: skipped-migrated": "SKIPPED_MIGRATED_INSTANCE",
};

const typeScriptSupportCache = new Map();

// Prisma 6.19 documented override for the schema-engine binary. Verified
// against node_modules/prisma/build/index.js (@prisma/fetch-engine env map:
// "schema-engine" -> PRISMA_SCHEMA_ENGINE_BINARY, legacy alias
// PRISMA_MIGRATION_ENGINE_BINARY). Pointing it at the bundled Windows
// executable guarantees the migration never tries to locate or download an
// external engine.
const SCHEMA_ENGINE_ENV_VAR = "PRISMA_SCHEMA_ENGINE_BINARY";

const DB_KIND_FRESH_ABSENT = "fresh-absent";
const DB_KIND_FRESH_ZERO_BYTE = "fresh-zero-byte";
const DB_KIND_EXISTING = "existing";

function classifyDatabase(databasePath) {
  let stat = null;
  try {
    stat = fs.statSync(databasePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { kind: DB_KIND_FRESH_ABSENT, size: 0, exists: false };
    }
    throw new Error(`cannot inspect database path ${databasePath}: ${error.message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`database path is not a file: ${databasePath}`);
  }
  if (stat.size === 0) return { kind: DB_KIND_FRESH_ZERO_BYTE, size: 0, exists: true };
  return { kind: DB_KIND_EXISTING, size: stat.size, exists: true };
}

function resolveMigrationRuntime({ backendRoot, platform = process.platform }) {
  if (!backendRoot) throw new Error("backendRoot is required");
  if (platform !== "win32") {
    throw new Error("the packaged desktop migration runtime is only prepared for Windows x64");
  }
  const prismaRuntimeDir = path.join(backendRoot, "prisma-runtime");
  const runtime = {
    root: prismaRuntimeDir,
    schemaPath: path.join(prismaRuntimeDir, "schema.prisma"),
    migrationsDir: path.join(prismaRuntimeDir, "migrations"),
    cliEntry: path.join(prismaRuntimeDir, "node_modules", "prisma", "build", "index.js"),
    schemaEnginePath: path.join(
      prismaRuntimeDir,
      "node_modules",
      "@prisma",
      "engines",
      "schema-engine-windows.exe",
    ),
    dbToolPath: path.join(backendRoot, "db-tool.cjs"),
  };
  const missing = [];
  for (const [label, filePath] of [
    ["schema.prisma", runtime.schemaPath],
    ["Prisma CLI entry", runtime.cliEntry],
    ["schema engine", runtime.schemaEnginePath],
    ["db-tool", runtime.dbToolPath],
  ]) {
    if (!fs.existsSync(filePath)) missing.push(`${label}: ${filePath}`);
  }
  if (!fs.existsSync(runtime.migrationsDir)) {
    missing.push(`migrations directory: ${runtime.migrationsDir}`);
  } else {
    const entries = fs.readdirSync(runtime.migrationsDir, { withFileTypes: true });
    const hasMigration = entries.some((entry) => entry.isDirectory());
    if (!hasMigration) missing.push(`migrations directory is empty: ${runtime.migrationsDir}`);
  }
  if (missing.length > 0) {
    throw new Error(`incomplete desktop migration runtime, refusing to migrate:\n${missing.join("\n")}`);
  }
  return runtime;
}

function listExpectedMigrations(migrationsDir) {
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function buildMigrationArgs(runtime) {
  // Direct argument array (no shell command strings), verified against
  // Prisma 6.19.0 (`migrate deploy --schema <path>`).
  return [runtime.cliEntry, "migrate", "deploy", "--schema", runtime.schemaPath];
}

function buildMigrationEnv({ databaseUrl, tmpDir, baseEnv = process.env, schemaEnginePath }) {
  if (!schemaEnginePath) throw new Error("schemaEnginePath is required");
  return buildControlledEnv({
    databaseUrl,
    tmpDir,
    baseEnv,
    extra: {
      [SCHEMA_ENGINE_ENV_VAR]: schemaEnginePath,
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      CHECKPOINT_DISABLE: "1",
    },
  });
}

function appendMigrationLog({ logDirectory, lines }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, "migration.log");
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  return logPath;
}

async function runMigration({
  nodeExecutable,
  runtime,
  databaseUrl,
  tmpDir,
  logDirectory,
  appVersion,
  dbKind,
  baseEnv = process.env,
  cwd,
  timeoutMs = MIGRATION_TIMEOUT_MS,
  onChild,
}) {
  if (!nodeExecutable) throw new Error("nodeExecutable is required");
  if (!runtime) throw new Error("migration runtime is required");
  if (!databaseUrl) throw new Error("databaseUrl is required");
  if (!tmpDir) throw new Error("tmpDir is required");
  if (!logDirectory) throw new Error("logDirectory is required");

  const args = buildMigrationArgs(runtime);
  const env = buildMigrationEnv({ databaseUrl, tmpDir, baseEnv, schemaEnginePath: runtime.schemaEnginePath });
  const result = await runChild({ executable: nodeExecutable, args, env, cwd, timeoutMs, onChild });
  const header = [
    `--- migration ${new Date().toISOString()} app=${appVersion || "unknown"} db=${dbKind || "unknown"} ---`,
    `command: ${nodeExecutable} ${args.join(" ")}`,
    `schemaEngine: ${runtime.schemaEnginePath}`,
    `exitCode: ${result.exitCode} signal: ${result.signal || "-"} durationMs: ${result.durationMs}`,
  ];
  let logPath = null;
  if (result.spawnError) {
    logPath = appendMigrationLog({ logDirectory, lines: [...header, `spawnError: ${result.spawnError}`] });
    throw new Error(`database migration could not start (see ${logPath}): ${result.spawnError}`);
  }
  if (result.exitCode !== 0) {
    const tail = [result.stdout.trim().split(/\r?\n/).slice(-15).join("\n"), result.stderr.trim().split(/\r?\n/).slice(-15).join("\n")]
      .filter(Boolean)
      .join("\n");
    logPath = appendMigrationLog({ logDirectory, lines: [...header, "stdout-tail:", result.stdout.slice(-4000), "stderr-tail:", result.stderr.slice(-4000)] });
    throw new Error(`database migration failed with exit code ${result.exitCode} (see ${logPath}):\n${tail.slice(0, 1500)}`);
  }
  logPath = appendMigrationLog({ logDirectory, lines: [...header, "status: success"] });
  return { ...result, logPath };
}

async function queryAppliedMigrations({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv = process.env, cwd }) {
  const parsed = await runDbTool({
    nodeExecutable,
    dbToolPath,
    databaseUrl,
    tmpDir,
    baseEnv,
    command: "query",
    arg: "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations;",
    cwd,
  });
  return parsed.rows || [];
}

function verifyMigrationsApplied({ expectedMigrations, appliedRows }) {
  const applied = new Map();
  const failed = [];
  for (const row of appliedRows || []) {
    const name = String(row.migration_name || "");
    const finished = row.finished_at !== null && row.finished_at !== undefined;
    const rolledBack = row.rolled_back_at !== null && row.rolled_back_at !== undefined;
    // Explicit rolled-back handling: a rolled-back migration is NOT counted
    // as applied; it is reported as failed so startup stays fail-closed
    // instead of silently accepting a partially migrated database.
    if (finished && !rolledBack) {
      applied.set(name, row);
    } else {
      failed.push(name || "(unnamed)");
    }
  }
  const appliedMigrations = [...applied.keys()].sort();
  const missingMigrations = (expectedMigrations || []).filter((name) => !applied.has(name));
  const failedMigrations = failed.sort();
  return {
    expectedMigrations: [...(expectedMigrations || [])].sort(),
    appliedMigrations,
    missingMigrations,
    failedMigrations,
    ok: missingMigrations.length === 0 && failedMigrations.length === 0,
  };
}

async function checkPostMigrationIntegrity({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv = process.env, cwd }) {
  let parsed;
  try {
    parsed = await runDbTool({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv, command: "integrity", cwd });
  } catch (error) {
    throw new Error(`post-migration integrity_check failed: ${error.message}`);
  }
  const rows = parsed.rows || [];
  const first = rows[0] || {};
  const value = String(first.integrity_check ?? Object.values(first)[0] ?? "").toLowerCase();
  if (value !== "ok") {
    throw new Error(`post-migration integrity_check failed: ${JSON.stringify(rows).slice(0, 300)}`);
  }
  return "ok";
}

function redactSensitiveBootstrapText(text) {
  return String(text || "")
    .replace(/file:[^\s)'"]+/gi, "file:[redacted]")
    .replace(/[A-Za-z]:\\[^\s)'"]+/g, "[path]")
    .replace(/\/(?:data|app|home|Users|tmp|var)\/[^\s)'"]+/g, "[path]")
    .slice(0, 500);
}

function probeNodeTypeScriptSupport(nodeExecutable) {
  if (!nodeExecutable) return false;
  if (typeScriptSupportCache.has(nodeExecutable)) {
    return typeScriptSupportCache.get(nodeExecutable);
  }
  const probe = spawnSync(nodeExecutable, ["--experimental-strip-types", "-e", "process.exit(0)"], {
    windowsHide: true,
    timeout: 15000,
    stdio: "ignore",
  });
  const supported = probe.status === 0;
  typeScriptSupportCache.set(nodeExecutable, supported);
  return supported;
}

function resolveFreshNativeBootstrap({
  backendRoot,
  nodeExecutable,
  probe = probeNodeTypeScriptSupport,
  repoRoot = path.resolve(__dirname, "..", ".."),
}) {
  const packagedEntry = path.join(backendRoot || "", "fresh-native-runtime", "ensure-fresh-native.cjs");
  if (backendRoot && fs.existsSync(packagedEntry)) {
    return { kind: "packaged-cjs", cwd: backendRoot, args: [packagedEntry] };
  }

  const repoScript = path.join(repoRoot, "scripts", "ensure-fresh-native.mts");
  if (fs.existsSync(repoScript) && probe(nodeExecutable)) {
    return {
      kind: "repo-mts",
      cwd: repoRoot,
      args: [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "--experimental-transform-types",
        repoScript,
      ],
    };
  }

  const compiledEntry = path.join(repoRoot, "fresh-native-runtime", "ensure-fresh-native.cjs");
  if (fs.existsSync(compiledEntry)) {
    return { kind: "repo-cjs", cwd: repoRoot, args: [compiledEntry] };
  }

  throw new Error("fresh-native activation bootstrap is unavailable");
}

function parseFreshNativeChildResult({ exitCode, stdout }) {
  const known = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => FRESH_NATIVE_SUCCESS_LOGLINES.has(line) || line === "fresh-native activation: failed");
  if (exitCode !== 0 || known.length !== 1 || known[0] === "fresh-native activation: failed") {
    return { ok: false, logLine: "fresh-native activation: failed", result: null };
  }
  return {
    ok: true,
    logLine: known[0],
    result: FRESH_NATIVE_LOG_TO_RESULT[known[0]],
  };
}

function buildFreshNativeChildEnv({ databaseUrl, tmpDir, baseEnv = process.env }) {
  const osEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT", "OS"]) {
    if (baseEnv[key]) osEnv[key] = baseEnv[key];
    else if (process.env[key]) osEnv[key] = process.env[key];
  }
  return buildControlledEnv({ databaseUrl, tmpDir, baseEnv: osEnv });
}

// Runs the shared fresh-native bootstrap against the database URL this
// process already resolved. The child receives no path argument.
async function runFreshNativeBootstrap({
  nodeExecutable,
  databaseUrl,
  backendRoot,
  tmpDir,
  baseEnv = process.env,
  probe,
}) {
  if (!nodeExecutable) throw new Error("nodeExecutable is required");
  if (!databaseUrl) throw new Error("databaseUrl is required");
  if (!tmpDir) throw new Error("tmpDir is required");
  const plan = resolveFreshNativeBootstrap({ backendRoot, nodeExecutable, probe });
  const env = buildFreshNativeChildEnv({ databaseUrl, tmpDir, baseEnv });
  const result = await runChild({
    executable: nodeExecutable,
    args: plan.args,
    env,
    cwd: plan.cwd,
    timeoutMs: FRESH_NATIVE_TIMEOUT_MS,
  });
  const parsed = parseFreshNativeChildResult(result);
  if (!parsed.ok) {
    const detail = redactSensitiveBootstrapText(result.stderr || result.spawnError || "");
    const error = new Error("fresh-native activation failed");
    error.detail = detail;
    throw error;
  }
  return { logLine: parsed.logLine, result: parsed.result };
}

async function checkPostMigrationForeignKeys({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv = process.env, cwd }) {
  const parsed = await runDbTool({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv, command: "fk-check", cwd });
  const rows = parsed.rows || [];
  if (rows.length > 0) {
    throw new Error(`post-migration foreign_key_check found ${rows.length} violation(s): ${JSON.stringify(rows).slice(0, 500)}`);
  }
  return [];
}

// Full per-launch database preparation. Called ONCE per app launch, after
// primary-instance ownership and before the backend spawn loop.
async function prepareDatabase({
  backendRoot,
  databasePath,
  databaseUrl,
  tmpDir,
  backupsDir,
  logDirectory,
  appVersion,
  nodeExecutable,
  baseEnv = process.env,
  cwd,
  timeoutMs,
  onMigrationChild,
  deps = {},
}) {
  const resolveRuntime = deps.resolveMigrationRuntime || resolveMigrationRuntime;
  const runMigrationStep = deps.runMigration || runMigration;
  const backupStep = deps.createBackup || createBackup;
  const queryStep = deps.queryAppliedMigrations || queryAppliedMigrations;
  const integrityStep = deps.checkPostMigrationIntegrity || checkPostMigrationIntegrity;
  const fkStep = deps.checkPostMigrationForeignKeys || checkPostMigrationForeignKeys;
  const freshStep = deps.runFreshNativeBootstrap || runFreshNativeBootstrap;

  const runtime = resolveRuntime({ backendRoot });
  const classification = classifyDatabase(databasePath);
  if (!tmpDir) throw new Error("tmpDir is required");
  if (!backupsDir) throw new Error("backupsDir is required");
  if (!logDirectory) throw new Error("logDirectory is required");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  // The migration child requires TEMP/TMP to exist (Prisma tempy lstats it),
  // so ensure desktop tmp/log/backups directories before spawning anything.
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(logDirectory, { recursive: true });

  let backup = null;
  if (classification.kind === DB_KIND_EXISTING) {
    // Backup failure aborts before the source database is touched.
    backup = await backupStep({
      databasePath,
      backupsDir,
      appVersion,
      nodeExecutable,
      dbToolPath: runtime.dbToolPath,
      databaseUrl,
      tmpDir,
      baseEnv,
      cwd,
    });
  }

  const migration = await runMigrationStep({
    nodeExecutable,
    runtime,
    databaseUrl,
    tmpDir,
    logDirectory,
    appVersion,
    dbKind: classification.kind,
    baseEnv,
    cwd,
    timeoutMs,
    onChild: onMigrationChild,
  });

  const expectedMigrations = listExpectedMigrations(runtime.migrationsDir);
  const appliedRows = await queryStep({
    nodeExecutable,
    dbToolPath: runtime.dbToolPath,
    databaseUrl,
    tmpDir,
    baseEnv,
    cwd,
  });
  const verification = verifyMigrationsApplied({ expectedMigrations, appliedRows });
  if (!verification.ok) {
    throw new Error(
      `database migration verification failed: missing=[${verification.missingMigrations.join(", ").slice(0, 500)}] ` +
        `failed=[${verification.failedMigrations.join(", ").slice(0, 500)}] (see ${migration.logPath})`,
    );
  }

  const integrity = await integrityStep({ nodeExecutable, dbToolPath: runtime.dbToolPath, databaseUrl, tmpDir, baseEnv, cwd });
  await fkStep({ nodeExecutable, dbToolPath: runtime.dbToolPath, databaseUrl, tmpDir, baseEnv, cwd });

  let freshNative;
  try {
    freshNative = await freshStep({
      nodeExecutable,
      databaseUrl,
      backendRoot,
      tmpDir,
      baseEnv,
      cwd,
      logDirectory,
    });
  } catch (error) {
    const detail = redactSensitiveBootstrapText(error && error.detail ? error.detail : "");
    appendMigrationLog({
      logDirectory,
      lines: [
        `--- fresh-native ${new Date().toISOString()} ---`,
        "fresh-native activation: failed",
        detail ? `detail: ${detail}` : "detail: unavailable",
      ],
    });
    throw new Error("fresh-native activation failed");
  }
  if (!freshNative || !FRESH_NATIVE_SUCCESS_LOGLINES.has(freshNative.logLine)) {
    appendMigrationLog({
      logDirectory,
      lines: [`--- fresh-native ${new Date().toISOString()} ---`, "fresh-native activation: failed"],
    });
    throw new Error("fresh-native activation failed");
  }
  appendMigrationLog({
    logDirectory,
    lines: [`--- fresh-native ${new Date().toISOString()} ---`, freshNative.logLine],
  });
  console.log(freshNative.logLine);

  return {
    kind: classification.kind,
    backup,
    migration: { exitCode: migration.exitCode, durationMs: migration.durationMs, logPath: migration.logPath },
    expectedMigrations: verification.expectedMigrations,
    appliedMigrations: verification.appliedMigrations,
    missingMigrations: verification.missingMigrations,
    failedMigrations: verification.failedMigrations,
    integrity,
    freshNative,
  };
}

module.exports = {
  DB_KIND_EXISTING,
  DB_KIND_FRESH_ABSENT,
  DB_KIND_FRESH_ZERO_BYTE,
  FRESH_NATIVE_SUCCESS_LOGLINES,
  FRESH_NATIVE_TIMEOUT_MS,
  MIGRATION_TIMEOUT_MS,
  SCHEMA_ENGINE_ENV_VAR,
  buildFreshNativeChildEnv,
  buildMigrationArgs,
  buildMigrationEnv,
  checkPostMigrationForeignKeys,
  checkPostMigrationIntegrity,
  classifyDatabase,
  listExpectedMigrations,
  parseFreshNativeChildResult,
  prepareDatabase,
  queryAppliedMigrations,
  redactSensitiveBootstrapText,
  resolveFreshNativeBootstrap,
  resolveMigrationRuntime,
  runFreshNativeBootstrap,
  runMigration,
  verifyMigrationsApplied,
};
