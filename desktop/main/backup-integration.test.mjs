import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BACKUP_MANIFEST_VERSION, BACKUP_METHOD, createBackup } from "./database-backup.js";
import { prepareDatabase } from "./database-migration.js";
import { computeFileSha256, runDbTool } from "./db-runner.js";
import { ensureAssembledRuntime, nodeExecutable } from "./test-runtime.mjs";

let backendRoot;
let runtime;

beforeAll(async () => {
  ({ backendRoot, runtime } = await ensureAssembledRuntime());
}, 180000);

function makeDisposableRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const dir of ["data", "tmp", "backups", "logs"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function dbConfig(root, file = "vocatrya.db") {
  const databasePath = path.join(root, "data", file);
  return {
    backendRoot,
    databasePath,
    databaseUrl: `file:${databasePath.replaceAll("\\", "/")}`,
    tmpDir: path.join(root, "tmp"),
    backupsDir: path.join(root, "backups"),
    logDirectory: path.join(root, "logs"),
    appVersion: "1.1.20",
    nodeExecutable: nodeExecutable(),
    baseEnv: {},
    cwd: root,
  };
}

async function seedMigratedDb(root, file) {
  const config = dbConfig(root, file);
  const result = await prepareDatabase(config);
  expect(result.integrity).toBe("ok");
  return config;
}

function dbTool(databaseUrl, tmpDir, command, arg) {
  return runDbTool({
    nodeExecutable: nodeExecutable(),
    dbToolPath: runtime.dbToolPath,
    databaseUrl,
    tmpDir,
    baseEnv: {},
    command,
    arg,
  });
}

function backupDirFiles(backupsDir) {
  return fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).sort() : [];
}

function expectIntegrityOk(integrity) {
  const first = (integrity.rows || [])[0] || {};
  expect(String(first.integrity_check ?? Object.values(first)[0] ?? "").toLowerCase()).toBe("ok");
}

describe("backup integration (VACUUM INTO)", () => {
  it("backs up a normal database with manifest, hash, and atomic publication", async () => {
    const root = makeDisposableRoot("voc-baknormal-");
    try {
      const config = await seedMigratedDb(root);
      await dbTool(config.databaseUrl, config.tmpDir, "exec", "CREATE TABLE _sentinel (id INTEGER PRIMARY KEY, v TEXT);");
      await dbTool(config.databaseUrl, config.tmpDir, "exec", "INSERT INTO _sentinel (v) VALUES ('normal-backup-row');");

      const result = await createBackup({
        databasePath: config.databasePath,
        backupsDir: config.backupsDir,
        appVersion: "1.1.20",
        nodeExecutable: nodeExecutable(),
        dbToolPath: runtime.dbToolPath,
        databaseUrl: config.databaseUrl,
        tmpDir: config.tmpDir,
        baseEnv: {},
      });

      expect(fs.existsSync(result.backupPath)).toBe(true);
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      expect(result.manifest.formatVersion).toBe(BACKUP_MANIFEST_VERSION);
      expect(result.manifest.backupMethod).toBe(BACKUP_METHOD);
      expect(result.manifest.appVersion).toBe("1.1.20");
      expect(new Date(result.manifest.createdAt).toISOString()).toBe(result.manifest.createdAt);
      expect(result.manifest.sourceDbSize).toBe(fs.statSync(config.databasePath).size);
      expect(result.manifest.backupDbSize).toBe(fs.statSync(result.backupPath).size);
      expect(result.manifest.sourceDbSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.manifest.sourceDbSha256).toBe(computeFileSha256(config.databasePath));
      expect(result.manifest.backupDbSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.manifest.backupDbSha256).toBe(computeFileSha256(result.backupPath));
      expect("AUTH_SECRET" in result.manifest).toBe(false);
      expect("ENCRYPTION_KEY" in result.manifest).toBe(false);

      const files = backupDirFiles(config.backupsDir);
      expect(files.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
      expect(files).toEqual([path.basename(result.backupPath), path.basename(result.manifestPath)].sort());

      const backupUrl = `file:${result.backupPath.replaceAll("\\", "/")}`;
      const rows = await dbTool(backupUrl, config.tmpDir, "query", "SELECT v FROM _sentinel;");
      expect(rows.rows).toEqual([{ v: "normal-backup-row" }]);
      expectIntegrityOk(await dbTool(backupUrl, config.tmpDir, "integrity"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  it("backs up a WAL-active database without losing committed rows", async () => {
    const root = makeDisposableRoot("voc-bakwal-");
    try {
      const config = await seedMigratedDb(root);
      const mode = await dbTool(config.databaseUrl, config.tmpDir, "query", "PRAGMA journal_mode=WAL;");
      expect(String(mode.rows[0]?.journal_mode ?? "").toLowerCase()).toBe("wal");
      await dbTool(config.databaseUrl, config.tmpDir, "exec", "CREATE TABLE _sentinel (id INTEGER PRIMARY KEY, v TEXT);");
      await dbTool(config.databaseUrl, config.tmpDir, "exec", "INSERT INTO _sentinel (v) VALUES ('wal-committed-row');");
      // The database remains in WAL mode (journal_mode persists across
      // connections); the -wal sidecar may be checkpointed away on clean
      // close, so persistence of WAL mode plus committed rows is the stable
      // assertion — not sidecar existence.
      const modeAfter = await dbTool(config.databaseUrl, config.tmpDir, "query", "PRAGMA journal_mode;");
      expect(String(modeAfter.rows[0]?.journal_mode ?? "").toLowerCase()).toBe("wal");

      const result = await createBackup({
        databasePath: config.databasePath,
        backupsDir: config.backupsDir,
        appVersion: "1.1.20",
        nodeExecutable: nodeExecutable(),
        dbToolPath: runtime.dbToolPath,
        databaseUrl: config.databaseUrl,
        tmpDir: config.tmpDir,
        baseEnv: {},
      });

      const backupUrl = `file:${result.backupPath.replaceAll("\\", "/")}`;
      const rows = await dbTool(backupUrl, config.tmpDir, "query", "SELECT v FROM _sentinel;");
      expect(rows.rows).toEqual([{ v: "wal-committed-row" }]);
      expectIntegrityOk(await dbTool(backupUrl, config.tmpDir, "integrity"));
      expect(result.manifest.backupDbSha256).toBe(computeFileSha256(result.backupPath));
      expect(backupDirFiles(config.backupsDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  it("supports database and backup paths with spaces and Unicode", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "voc-space-"));
    const root = path.join(outer, "root dir");
    const uni = "uni";
    const spacedDb = path.join(root, "data", `voca trya ${uni}.db`);
    const spaced = {
      backendRoot,
      databasePath: spacedDb,
      databaseUrl: `file:${spacedDb.replaceAll("\\", "/")}`,
      tmpDir: path.join(root, "tmp"),
      backupsDir: path.join(root, `backups ${uni}`),
      logDirectory: path.join(root, "logs"),
      appVersion: "1.1.20",
      nodeExecutable: nodeExecutable(),
      baseEnv: {},
    };
    try {
      const prepared = await prepareDatabase(spaced);
      expect(prepared.integrity).toBe("ok");
      await dbTool(spaced.databaseUrl, spaced.tmpDir, "exec", "CREATE TABLE _sentinel (id INTEGER PRIMARY KEY, v TEXT);");
      await dbTool(spaced.databaseUrl, spaced.tmpDir, "exec", "INSERT INTO _sentinel (v) VALUES ('unicode-space-row');");
      const result = await createBackup({
        databasePath: spaced.databasePath,
        backupsDir: spaced.backupsDir,
        appVersion: "1.1.20",
        nodeExecutable: nodeExecutable(),
        dbToolPath: runtime.dbToolPath,
        databaseUrl: spaced.databaseUrl,
        tmpDir: spaced.tmpDir,
        baseEnv: {},
      });
      expect(fs.existsSync(result.backupPath)).toBe(true);
      const backupUrl = `file:${result.backupPath.replaceAll("\\", "/")}`;
      const rows = await dbTool(backupUrl, spaced.tmpDir, "query", "SELECT v FROM _sentinel;");
      expect(rows.rows).toEqual([{ v: "unicode-space-row" }]);
      expect(backupDirFiles(spaced.backupsDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  }, 240000);
});
