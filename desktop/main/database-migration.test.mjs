import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DB_KIND_EXISTING,
  DB_KIND_FRESH_ABSENT,
  DB_KIND_FRESH_ZERO_BYTE,
  SCHEMA_ENGINE_ENV_VAR,
  buildMigrationArgs,
  buildMigrationEnv,
  classifyDatabase,
  listExpectedMigrations,
  prepareDatabase,
  verifyMigrationsApplied,
} from "./database-migration.js";
import { buildControlledEnv } from "./db-runner.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRuntime(overrides = {}) {
  return {
    root: "C:\\runtime\\prisma-runtime",
    schemaPath: "C:\\runtime\\prisma-runtime\\schema.prisma",
    migrationsDir: "C:\\runtime\\prisma-runtime\\migrations",
    cliEntry: "C:\\runtime\\prisma-runtime\\node_modules\\prisma\\build\\index.js",
    schemaEnginePath: "C:\\runtime\\prisma-runtime\\node_modules\\@prisma\\engines\\schema-engine-windows.exe",
    dbToolPath: "C:\\runtime\\db-tool.cjs",
    ...overrides,
  };
}

describe("database classification", () => {
  it("treats an absent database as fresh", () => {
    const dir = makeTempDir("voc-class-");
    const result = classifyDatabase(path.join(dir, "vocatrya.db"));
    expect(result.kind).toBe(DB_KIND_FRESH_ABSENT);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats a zero-byte database as fresh", () => {
    const dir = makeTempDir("voc-class-");
    const db = path.join(dir, "vocatrya.db");
    fs.writeFileSync(db, Buffer.alloc(0));
    expect(classifyDatabase(db).kind).toBe(DB_KIND_FRESH_ZERO_BYTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats a non-empty database as existing", () => {
    const dir = makeTempDir("voc-class-");
    const db = path.join(dir, "vocatrya.db");
    fs.writeFileSync(db, Buffer.from("not-empty"));
    const result = classifyDatabase(db);
    expect(result.kind).toBe(DB_KIND_EXISTING);
    expect(result.size).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-file database path", () => {
    const dir = makeTempDir("voc-class-");
    expect(() => classifyDatabase(dir)).toThrow(/not a file/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("expected migration listing", () => {
  it("lists migration directories and ignores migration_lock.toml", () => {
    const dir = makeTempDir("voc-miglist-");
    fs.mkdirSync(path.join(dir, "20240101000000_first"));
    fs.mkdirSync(path.join(dir, "20240202000000_second"));
    fs.writeFileSync(path.join(dir, "migration_lock.toml"), 'provider = "sqlite"\n');
    expect(listExpectedMigrations(dir)).toEqual(["20240101000000_first", "20240202000000_second"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("migration command construction", () => {
  it("builds a direct argument array for migrate deploy (no shell strings)", () => {
    const runtime = makeRuntime();
    const args = buildMigrationArgs(runtime);
    expect(args).toEqual([runtime.cliEntry, "migrate", "deploy", "--schema", runtime.schemaPath]);
    expect(args.join(" ")).not.toMatch(/\bnpx\b/);
    expect(args.join(" ")).not.toMatch(/\bnpm\b/);
  });
});

describe("migration child environment", () => {
  const hostileBase = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    DATABASE_URL: "file:./prisma/dev.db",
    AUTH_SECRET: "dev-auth",
    ENCRYPTION_KEY: "dev-enc",
    OPENAI_API_KEY: "sk-dev",
    RUST_LOG: "warn",
    RUST_BACKTRACE: "1",
  };

  it("overrides DATABASE_URL and pins desktop TEMP/TMP", () => {
    const env = buildMigrationEnv({
      databaseUrl: "file:C:/data/vocatrya.db",
      tmpDir: "C:\\data\\tmp",
      baseEnv: hostileBase,
      schemaEnginePath: "C:\\runtime\\schema-engine-windows.exe",
    });
    expect(env.DATABASE_URL).toBe("file:C:/data/vocatrya.db");
    expect(env.TEMP).toBe("C:\\data\\tmp");
    expect(env.TMP).toBe("C:\\data\\tmp");
  });

  it("points the documented schema-engine variable at the bundled engine", () => {
    const env = buildMigrationEnv({
      databaseUrl: "file:C:/data/vocatrya.db",
      tmpDir: "C:\\data\\tmp",
      baseEnv: hostileBase,
      schemaEnginePath: "C:\\runtime\\schema-engine-windows.exe",
    });
    expect(SCHEMA_ENGINE_ENV_VAR).toBe("PRISMA_SCHEMA_ENGINE_BINARY");
    expect(env.PRISMA_SCHEMA_ENGINE_BINARY).toBe("C:\\runtime\\schema-engine-windows.exe");
  });

  it("never exposes secrets or engine contaminants", () => {
    const env = buildMigrationEnv({
      databaseUrl: "file:C:/data/vocatrya.db",
      tmpDir: "C:\\data\\tmp",
      baseEnv: hostileBase,
      schemaEnginePath: "C:\\runtime\\schema-engine-windows.exe",
    });
    for (const key of ["AUTH_SECRET", "ENCRYPTION_KEY", "OPENAI_API_KEY", "RUST_LOG", "RUST_BACKTRACE"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });

  it("buildControlledEnv strips secrets even when passed via extra", () => {
    const env = buildControlledEnv({
      databaseUrl: "file:C:/x.db",
      tmpDir: "C:\\t",
      baseEnv: {},
      extra: { AUTH_SECRET: "oops" },
    });
    expect(env.AUTH_SECRET).toBeUndefined();
  });
});

describe("migration verification", () => {
  const expected = ["20240101000000_first", "20240202000000_second"];

  function row(name, { finished = true, rolledBack = false } = {}) {
    return {
      migration_name: name,
      finished_at: finished ? "2024-01-01T00:00:00.000Z" : null,
      rolled_back_at: rolledBack ? "2024-01-02T00:00:00.000Z" : null,
    };
  }

  it("accepts a fully applied history", () => {
    const result = verifyMigrationsApplied({ expectedMigrations: expected, appliedRows: [row(expected[0]), row(expected[1])] });
    expect(result.ok).toBe(true);
    expect(result.missingMigrations).toEqual([]);
    expect(result.failedMigrations).toEqual([]);
    expect(result.appliedMigrations).toEqual(expected);
  });

  it("reports missing migrations", () => {
    const result = verifyMigrationsApplied({ expectedMigrations: expected, appliedRows: [row(expected[0])] });
    expect(result.ok).toBe(false);
    expect(result.missingMigrations).toEqual([expected[1]]);
  });

  it("treats unfinished migrations as failed", () => {
    const result = verifyMigrationsApplied({
      expectedMigrations: expected,
      appliedRows: [row(expected[0]), row(expected[1], { finished: false })],
    });
    expect(result.ok).toBe(false);
    expect(result.failedMigrations).toEqual([expected[1]]);
  });

  it("treats rolled-back migrations as failed, never as applied", () => {
    const result = verifyMigrationsApplied({
      expectedMigrations: expected,
      appliedRows: [row(expected[0]), row(expected[1], { rolledBack: true })],
    });
    expect(result.ok).toBe(false);
    expect(result.failedMigrations).toEqual([expected[1]]);
    expect(result.appliedMigrations).toEqual([expected[0]]);
  });
});

describe("prepareDatabase orchestration", () => {
  function baseOptions(overrides = {}) {
    const dir = makeTempDir("voc-prep-");
    return {
      dir,
      options: {
        backendRoot: "C:\\backend",
        databasePath: path.join(dir, "data", "vocatrya.db"),
        databaseUrl: "file:C:/backend-data/vocatrya.db",
        tmpDir: path.join(dir, "tmp"),
        backupsDir: path.join(dir, "backups"),
        logDirectory: path.join(dir, "logs"),
        appVersion: "1.1.20",
        nodeExecutable: "C:\\runtime\\node.exe",
        baseEnv: {},
        ...overrides,
      },
    };
  }

  function successDeps() {
    const calls = { backup: 0, migrate: 0, query: 0, integrity: 0, fk: 0 };
    return {
      calls,
      deps: {
        resolveMigrationRuntime: () => makeRuntime(),
        createBackup: async () => {
          calls.backup += 1;
          return { backupPath: "C:\\backups\\b.db", manifestPath: "C:\\backups\\b.db.json", manifest: {} };
        },
        runMigration: async () => {
          calls.migrate += 1;
          return { exitCode: 0, durationMs: 5, logPath: "C:\\logs\\migration.log" };
        },
        queryAppliedMigrations: async () => {
          calls.query += 1;
          return appliedFirstRow();
        },
        checkPostMigrationIntegrity: async () => {
          calls.integrity += 1;
          return "ok";
        },
        checkPostMigrationForeignKeys: async () => {
          calls.fk += 1;
          return [];
        },
      },
    };
  }

  it("skips backup for a fresh database and verifies an empty history", async () => {
    const { dir, options } = baseOptions();
    const { calls, deps } = successDeps();
    const result = await prepareDatabase({
      ...options,
      deps: {
        ...deps,
        resolveMigrationRuntime: () => makeRuntime({ migrationsDir: makeFakeMigrationsDir(dir) }),
      },
    });
    expect(result.kind).toBe(DB_KIND_FRESH_ABSENT);
    expect(calls.backup).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(result.integrity).toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeFakeMigrationsDir(dir) {
    const migrationsDir = path.join(dir, "migrations");
    fs.mkdirSync(path.join(migrationsDir, "20240101000000_first"), { recursive: true });
    return migrationsDir;
  }

  function appliedFirstRow() {
    return [{ migration_name: "20240101000000_first", finished_at: "2024-01-01T00:00:00.000Z", rolled_back_at: null }];
  }

  it("backs up an existing database exactly once before migrating", async () => {
    const { dir, options } = baseOptions();
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    fs.writeFileSync(options.databasePath, Buffer.from("existing-db-bytes"));
    const { calls, deps } = successDeps();
    const result = await prepareDatabase({
      ...options,
      deps: {
        ...deps,
        resolveMigrationRuntime: () => makeRuntime({ migrationsDir: makeFakeMigrationsDir(dir) }),
      },
    });
    expect(result.kind).toBe(DB_KIND_EXISTING);
    expect(calls.backup).toBe(1);
    expect(calls.migrate).toBe(1);
    expect(result.backup.backupPath).toBe("C:\\backups\\b.db");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never runs migration when backup fails and leaves the source untouched", async () => {
    const { dir, options } = baseOptions();
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    fs.writeFileSync(options.databasePath, Buffer.from("existing-db-bytes"));
    const { calls, deps } = successDeps();
    const failing = {
      ...deps,
      resolveMigrationRuntime: () => makeRuntime({ migrationsDir: makeFakeMigrationsDir(dir) }),
      createBackup: async () => {
        calls.backup += 1;
        throw new Error("backup unavailable");
      },
    };
    await expect(prepareDatabase({ ...options, deps: failing })).rejects.toThrow(/backup/);
    expect(calls.backup).toBe(1);
    expect(calls.migrate).toBe(0);
    expect(fs.readFileSync(options.databasePath, "utf8")).toBe("existing-db-bytes");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when migration exits non-zero", async () => {
    const { dir, options } = baseOptions();
    const { calls, deps } = successDeps();
    const failing = {
      ...deps,
      resolveMigrationRuntime: () => makeRuntime({ migrationsDir: makeFakeMigrationsDir(dir) }),
      runMigration: async () => {
        calls.migrate += 1;
        throw new Error("database migration failed with exit code 1");
      },
    };
    await expect(prepareDatabase({ ...options, deps: failing })).rejects.toThrow(/exit code 1/);
    expect(calls.query).toBe(0);
    expect(calls.integrity).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on verification gaps and on integrity failure", async () => {
    const { dir, options } = baseOptions();
    const { deps } = successDeps();
    const migrationsDir = path.join(dir, "migrations");
    fs.mkdirSync(path.join(migrationsDir, "20240101000000_first"), { recursive: true });
    const withGap = {
      ...deps,
      resolveMigrationRuntime: () => makeRuntime({ migrationsDir }),
      queryAppliedMigrations: async () => [],
    };
    await expect(prepareDatabase({ ...options, deps: withGap })).rejects.toThrow(/verification failed/);

    const withBadIntegrity = {
      ...deps,
      resolveMigrationRuntime: () => makeRuntime({ migrationsDir: makeFakeMigrationsDir(path.join(dir, "other")) }),
      queryAppliedMigrations: async () => [{ migration_name: "20240101000000_first", finished_at: "2024-01-01T00:00:00.000Z", rolled_back_at: null }],
      checkPostMigrationIntegrity: async () => {
        throw new Error("post-migration integrity_check failed");
      },
    };
    await expect(prepareDatabase({ ...options, deps: withBadIntegrity })).rejects.toThrow(/integrity_check/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
