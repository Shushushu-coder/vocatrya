import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  listExpectedMigrations,
  prepareDatabase,
  verifyMigrationsApplied,
} from "./database-migration.js";
import { runDbTool } from "./db-runner.js";
import { ensureAssembledRuntime, nodeExecutable, repoMigrationNames, repoRoot } from "./test-runtime.mjs";

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
  };
}

async function queryHelper(databaseUrl, tmpDir, command, arg) {
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

describe("bundled migration integration", () => {
  it("migrates a fresh absent database with the bundled CLI only", async () => {
    const root = makeDisposableRoot("voc-intfresh-");
    try {
      const config = dbConfig(root);
      expect(fs.existsSync(config.databasePath)).toBe(false);
      const result = await prepareDatabase(config);
      expect(result.kind).toBe("fresh-absent");
      expect(result.backup).toBeNull();
      expect(result.integrity).toBe("ok");
      expect(result.missingMigrations).toEqual([]);
      expect(result.failedMigrations).toEqual([]);
      expect(result.appliedMigrations).toEqual(repoMigrationNames());
      expect(fs.existsSync(config.databasePath)).toBe(true);
      expect(fs.existsSync(path.join(config.logDirectory, "migration.log"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);

  it("migrates a zero-byte database into a valid schema", async () => {
    const root = makeDisposableRoot("voc-intzero-");
    try {
      const config = dbConfig(root);
      fs.writeFileSync(config.databasePath, Buffer.alloc(0));
      const result = await prepareDatabase(config);
      expect(result.kind).toBe("fresh-zero-byte");
      expect(result.backup).toBeNull();
      expect(result.integrity).toBe("ok");
      expect(result.appliedMigrations).toEqual(repoMigrationNames());
      expect(fs.statSync(config.databasePath).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);

  it("backs up an existing current database and preserves its data", async () => {
    const root = makeDisposableRoot("voc-intexist-");
    try {
      const seed = dbConfig(root);
      await prepareDatabase(seed);
      await queryHelper(seed.databaseUrl, seed.tmpDir, "exec", "CREATE TABLE _sentinel (id INTEGER PRIMARY KEY, v TEXT);");
      await queryHelper(seed.databaseUrl, seed.tmpDir, "exec", "INSERT INTO _sentinel (v) VALUES ('keep-me');");

      const config = dbConfig(root);
      const result = await prepareDatabase(config);
      expect(result.kind).toBe("existing");
      expect(result.backup).not.toBeNull();
      expect(fs.existsSync(result.backup.backupPath)).toBe(true);
      expect(fs.existsSync(result.backup.manifestPath)).toBe(true);
      expect(result.backup.manifest.sourceDbSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.backup.manifest.backupMethod).toBe("vacuum-into");
      expect(result.integrity).toBe("ok");

      const rows = await queryHelper(config.databaseUrl, config.tmpDir, "query", "SELECT v FROM _sentinel;");
      expect(rows.rows).toEqual([{ v: "keep-me" }]);
      const backupRows = await runDbTool({
        nodeExecutable: nodeExecutable(),
        dbToolPath: runtime.dbToolPath,
        databaseUrl: `file:${result.backup.backupPath.replaceAll("\\", "/")}`,
        tmpDir: config.tmpDir,
        baseEnv: {},
        command: "query",
        arg: "SELECT v FROM _sentinel;",
      });
      expect(backupRows.rows).toEqual([{ v: "keep-me" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  it("upgrades an older-schema database and preserves pre-upgrade data", async () => {
    const root = makeDisposableRoot("voc-intup-");
    try {
      const allNames = repoMigrationNames();
      expect(allNames.length).toBeGreaterThan(1);
      const fixtureNames = allNames.slice(0, -1);
      const dropped = allNames[allNames.length - 1];

      // Fixture history: real migrations N-1 only, under an ignored temp dir.
      const fixtureDir = path.join(root, "fixture");
      fs.mkdirSync(path.join(fixtureDir, "migrations"), { recursive: true });
      fs.copyFileSync(path.join(repoRoot(), "prisma", "schema.prisma"), path.join(fixtureDir, "schema.prisma"));
      for (const name of fixtureNames) {
        fs.cpSync(path.join(repoRoot(), "prisma", "migrations", name), path.join(fixtureDir, "migrations", name), { recursive: true });
      }
      const config = dbConfig(root, "upgrade.db");
      const { buildMigrationEnv } = await import("./database-migration.js");
      const { spawnSync } = await import("node:child_process");
      const fixtureCli = path.join(backendRoot, "prisma-runtime", "node_modules", "prisma", "build", "index.js");
      const fixtureEnv = buildMigrationEnv({
        databaseUrl: config.databaseUrl,
        tmpDir: config.tmpDir,
        baseEnv: {},
        schemaEnginePath: runtime.schemaEnginePath,
      });
      const fixtureResult = spawnSync(
        nodeExecutable(),
        [fixtureCli, "migrate", "deploy", "--schema", path.join(fixtureDir, "schema.prisma")],
        { cwd: config.tmpDir, env: fixtureEnv, encoding: "utf8" },
      );
      expect(fixtureResult.status).toBe(0);

      await queryHelper(config.databaseUrl, config.tmpDir, "exec", "CREATE TABLE _sentinel (id INTEGER PRIMARY KEY, v TEXT);");
      await queryHelper(config.databaseUrl, config.tmpDir, "exec", "INSERT INTO _sentinel (v) VALUES ('pre-upgrade');");

      const before = await queryHelper(config.databaseUrl, config.tmpDir, "query", "SELECT migration_name FROM _prisma_migrations;");
      expect(before.rows.map((entry) => entry.migration_name)).not.toContain(dropped);

      const result = await prepareDatabase(config);
      expect(result.kind).toBe("existing");
      expect(result.backup).not.toBeNull();
      expect(result.appliedMigrations).toEqual(allNames);
      expect(result.missingMigrations).toEqual([]);
      expect(result.integrity).toBe("ok");
      const after = await queryHelper(config.databaseUrl, config.tmpDir, "query", "SELECT v FROM _sentinel;");
      expect(after.rows).toEqual([{ v: "pre-upgrade" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  it("succeeds under a hostile developer environment (RUST_LOG, secrets, dev DATABASE_URL)", async () => {
    const root = makeDisposableRoot("voc-inthostile-");
    try {
      const config = dbConfig(root);
      const result = await prepareDatabase({
        ...config,
        baseEnv: {
          ...process.env,
          RUST_LOG: "warn",
          RUST_BACKTRACE: "1",
          AUTH_SECRET: "dev-secret",
          ENCRYPTION_KEY: "dev-key",
          OPENAI_API_KEY: "sk-dev",
          DATABASE_URL: "file:./prisma/dev.db",
        },
      });
      expect(result.integrity).toBe("ok");
      expect(result.appliedMigrations).toEqual(repoMigrationNames());
      const log = fs.readFileSync(path.join(config.logDirectory, "migration.log"), "utf8");
      expect(log).not.toContain("dev-secret");
      expect(log).not.toContain("sk-dev");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);

  it("fails closed on migration failure and preserves the backup without starting over", async () => {
    const root = makeDisposableRoot("voc-intfail-");
    try {
      const seed = dbConfig(root);
      await prepareDatabase(seed);
      const sourceHash = JSON.parse(
        (await queryHelper(seed.databaseUrl, seed.tmpDir, "query", "SELECT count(*) AS n FROM _prisma_migrations;")).rows[0].n,
      );
      expect(Number(sourceHash)).toBeGreaterThan(0);

      const brokenSchema = path.join(root, "broken-schema.prisma");
      fs.writeFileSync(brokenSchema, "this is not a valid prisma schema");
      const config = dbConfig(root);
      await expect(
        prepareDatabase({
          ...config,
          deps: {
            resolveMigrationRuntime: () => ({ ...runtime, schemaPath: brokenSchema }),
          },
        }),
      ).rejects.toThrow(/migration failed/);
      const backups = fs.readdirSync(config.backupsDir).filter((name) => name.endsWith(".db"));
      expect(backups.length).toBe(1);
      expect(fs.existsSync(path.join(config.logDirectory, "migration.log"))).toBe(true);
      const verification = verifyMigrationsApplied({
        expectedMigrations: listExpectedMigrations(runtime.migrationsDir),
        appliedRows: (await queryHelper(config.databaseUrl, config.tmpDir, "query", "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations;")).rows,
      });
      expect(verification.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);

  it("rejects a tampered database at the integrity gate", async () => {
    const root = makeDisposableRoot("voc-inttamper-");
    try {
      const config = dbConfig(root);
      await prepareDatabase(config);
      const { checkPostMigrationIntegrity } = await import("./database-migration.js");
      const tampered = path.join(root, "data", "tampered.db");
      fs.copyFileSync(config.databasePath, tampered);
      // Zero the SQLite magic header so the file deterministically stops
      // being a readable database.
      const handle = fs.openSync(tampered, "r+");
      fs.writeSync(handle, Buffer.from([0x00, 0x00, 0x00, 0x00]), 0, 4, 0);
      fs.closeSync(handle);
      await expect(
        checkPostMigrationIntegrity({
          nodeExecutable: nodeExecutable(),
          dbToolPath: runtime.dbToolPath,
          databaseUrl: `file:${tampered.replaceAll("\\", "/")}`,
          tmpDir: config.tmpDir,
          baseEnv: {},
        }),
      ).rejects.toThrow(/integrity_check/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240000);
});
