// Vocatrya desktop pre-migration backup.
//
// Creates SQLite-consistent backups of the desktop database before any
// migration runs. Method: VACUUM INTO through the already-bundled Prisma
// query engine (no additional native SQLite dependency, no file-copy of a
// possibly WAL-dirty database). Every backup is integrity-checked, hashed,
// published atomically, and described by a sidecar manifest. Backups are
// never deleted or restored automatically; retention and restore are explicit
// future operations.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { computeFileSha256, runDbTool, utcBackupTimestamp } = require("./db-runner");

const BACKUP_MANIFEST_VERSION = 1;
const BACKUP_METHOD = "vacuum-into";

function sanitizeVersionForFilename(version) {
  const cleaned = String(version || "")
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/^[._]+|[._]+$/g, "");
  return cleaned || "unknown";
}

function buildBackupFilename({ appVersion, now = new Date() }) {
  return `pre-migration-${sanitizeVersionForFilename(appVersion)}-${utcBackupTimestamp(now)}.db`;
}

function buildManifestFilename(backupFilename) {
  return `${backupFilename}.json`;
}

function removeQuietly(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort only.
  }
}

async function verifyBackupIntegrity({ nodeExecutable, dbToolPath, backupDatabaseUrl, tmpDir, baseEnv, cwd }) {
  const parsed = await runDbTool({
    nodeExecutable,
    dbToolPath,
    databaseUrl: backupDatabaseUrl,
    tmpDir,
    baseEnv,
    command: "integrity",
    cwd,
  });
  const rows = parsed.rows || [];
  const first = rows[0] || {};
  const value = String(first.integrity_check ?? Object.values(first)[0] ?? "").toLowerCase();
  if (value !== "ok") {
    throw new Error(`backup integrity_check failed: ${JSON.stringify(rows).slice(0, 200)}`);
  }
  return "ok";
}

async function createBackup({
  databasePath,
  backupsDir,
  appVersion,
  nodeExecutable,
  dbToolPath,
  databaseUrl,
  tmpDir,
  baseEnv = process.env,
  cwd,
  now = new Date(),
}) {
  if (!databasePath) throw new Error("databasePath is required");
  if (!backupsDir) throw new Error("backupsDir is required");
  if (!nodeExecutable) throw new Error("nodeExecutable is required");
  if (!dbToolPath) throw new Error("dbToolPath is required");
  if (!databaseUrl) throw new Error("databaseUrl is required");
  if (!tmpDir) throw new Error("tmpDir is required");

  let sourceStat;
  try {
    sourceStat = fs.statSync(databasePath);
  } catch {
    throw new Error(`cannot back up: source database is missing: ${databasePath}`);
  }
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`cannot back up: source database is empty or not a file: ${databasePath}`);
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  const backupFilename = buildBackupFilename({ appVersion, now });
  const backupPath = path.join(backupsDir, backupFilename);
  if (path.basename(backupPath) !== backupFilename || backupFilename.includes("..")) {
    throw new Error("refusing to write backup outside the backups directory");
  }
  if (fs.existsSync(backupPath)) {
    throw new Error(`backup target already exists, refusing to overwrite: ${backupPath}`);
  }

  const stagingPath = path.join(backupsDir, `.tmp-${crypto.randomBytes(8).toString("hex")}.db`);
  try {
    // VACUUM INTO fails if the destination exists, so the staging file must
    // be fresh (random suffix) and must not be pre-created.
    removeQuietly(stagingPath);
    await runDbTool({
      nodeExecutable,
      dbToolPath,
      databaseUrl,
      tmpDir,
      baseEnv,
      command: "vacuum-into",
      arg: stagingPath,
      cwd,
    });
    const backupDatabaseUrl = `file:${path.resolve(stagingPath).replaceAll("\\", "/")}`;
    await verifyBackupIntegrity({ nodeExecutable, dbToolPath, backupDatabaseUrl, tmpDir, baseEnv, cwd });
    const sourceHash = computeFileSha256(databasePath);
    const backupHash = computeFileSha256(stagingPath);
    const backupStat = fs.statSync(stagingPath);
    // Atomic publication: the final filename appears only after creation,
    // integrity verification, and hashing all succeeded.
    fs.renameSync(stagingPath, backupPath);
    const manifest = {
      formatVersion: BACKUP_MANIFEST_VERSION,
      createdAt: now.toISOString(),
      appVersion: String(appVersion || "unknown"),
      sourcePath: databasePath,
      sourceDbSize: sourceStat.size,
      sourceDbSha256: sourceHash,
      backupDbSize: backupStat.size,
      backupDbSha256: backupHash,
      backupMethod: BACKUP_METHOD,
    };
    const manifestPath = path.join(backupsDir, buildManifestFilename(backupFilename));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { backupPath, manifestPath, manifest };
  } catch (error) {
    removeQuietly(stagingPath);
    throw new Error(`pre-migration backup failed, source database left untouched: ${error.message}`);
  }
}

module.exports = {
  BACKUP_MANIFEST_VERSION,
  BACKUP_METHOD,
  buildBackupFilename,
  buildManifestFilename,
  createBackup,
  sanitizeVersionForFilename,
  verifyBackupIntegrity,
};
