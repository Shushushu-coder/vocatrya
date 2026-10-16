import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMigrationEnv, listExpectedMigrations, prepareDatabase, resolveMigrationRuntime, runMigration } from "./database-migration.js";
import { runDbTool } from "./db-runner.js";
import { runStartupSequence } from "./startup.js";
import { migrationNamesSha256, readMigrationFingerprint } from "../scripts/release-manifest.mjs";
import { verifyInstalledLayout } from "../scripts/verify-installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Immutable beta.1 history (52 migrations, build 80c0b35b). Never recompute these from the current tree:
// renaming, editing, reordering or removing any baseline migration must fail the contract below.
const BETA1_BASELINE = Object.freeze({
  appVersion: "1.2.0-beta.1",
  buildCommit: "80c0b35b0837da1b68204574e811c8855ab192b9",
  migrationCount: 52,
  migrationNamesSha256: "b753a1af58ca7a953fe07855ff8bd5613fb524feaebf98e59dceacd051f7969a",
  migrationHistorySha256: "4a3e7ffb91b53653c48144cbf189b3fca53c50d2cfcee9402801051768d0a28a",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Digest of every migration's SQL, with CRLF folded to LF so autocrlf checkouts and packaged copies agree.
function migrationHistorySha256(migrationsDir, names) {
  const lines = names.map((name) => `${name} ${sha256(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8").replaceAll("\r\n", "\n"))}`);
  return sha256(lines.join("\n"));
}

function baselineViolation(migrationsDir) {
  const baseline = listExpectedMigrations(migrationsDir).slice(0, BETA1_BASELINE.migrationCount);
  if (baseline.length !== BETA1_BASELINE.migrationCount) return `expected ${BETA1_BASELINE.migrationCount} baseline migrations, found ${baseline.length}`;
  if (migrationNamesSha256(baseline) !== BETA1_BASELINE.migrationNamesSha256) return "baseline migration names differ from beta.1";
  if (migrationHistorySha256(migrationsDir, baseline) !== BETA1_BASELINE.migrationHistorySha256) return "baseline migration SQL differs from beta.1";
  return null;
}

function copyMigrations(fromDir, toDir, names) {
  for (const name of names) {
    fs.mkdirSync(path.join(toDir, name), { recursive: true });
    fs.copyFileSync(path.join(fromDir, name, "migration.sql"), path.join(toDir, name, "migration.sql"));
  }
}

describe("beta.1 migration baseline contract", () => {
  const sourceDir = path.join(repoRoot, "prisma", "migrations");
  const violationAfter = (mutate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-baseline-"));
    try {
      copyMigrations(sourceDir, dir, listExpectedMigrations(sourceDir).slice(0, BETA1_BASELINE.migrationCount));
      mutate(dir);
      return baselineViolation(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const add = (dir, name) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "migration.sql"), "SELECT 1;\n");
  };
  const first = (dir) => listExpectedMigrations(dir)[0];

  it("keeps the beta.1 baseline as an unmodified prefix of the current source set", () => {
    expect(baselineViolation(sourceDir)).toBeNull();
  });

  it("allows migrations appended after the baseline", () => {
    expect(violationAfter((dir) => add(dir, "99990101000000_future"))).toBeNull();
  });

  it.each([
    ["an edited baseline migration", (dir) => fs.appendFileSync(path.join(dir, first(dir), "migration.sql"), "-- edited\n"), /SQL differs/],
    ["a removed baseline migration", (dir) => fs.rmSync(path.join(dir, first(dir)), { recursive: true }), /expected 52 baseline migrations, found 51/],
    ["a renamed baseline migration", (dir) => fs.renameSync(path.join(dir, first(dir)), path.join(dir, "20240101000000_renamed")), /names differ/],
    ["a backdated migration inserted into the baseline range", (dir) => add(dir, "20240101000000_backdated"), /names differ/],
  ])("rejects %s", (_label, mutate, message) => {
    expect(violationAfter(mutate)).toMatch(message);
  });

  it("fingerprints migration SQL by content, not by line endings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-history-"));
    try {
      fs.mkdirSync(path.join(dir, "m"));
      const digest = (sql) => {
        fs.writeFileSync(path.join(dir, "m", "migration.sql"), sql);
        return migrationHistorySha256(dir, ["m"]);
      };
      const lf = digest("A;\nB;\n");
      expect(digest("A;\r\nB;\r\n")).toBe(lf);
      expect(digest("A;\nC;\n")).not.toBe(lf);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Opt-in: exercise the actual built artifact and pinned Node, never a developer DB.
// VOCATRYA_BETA1_APP_DIR (optional) is an unpacked beta.1 build; it is only accepted as the historical
// fixture when it matches BETA1_BASELINE exactly. Without it the beta.1 upgrade test is skipped, not passed.
const appDir = process.env.VOCATRYA_PACKAGED_TEST_APP_DIR;
const beta1AppDir = process.env.VOCATRYA_BETA1_APP_DIR;

function createHarness(app) {
  const backendRoot = path.join(app, "resources", "backend");
  const nodeExecutable = path.join(app, "resources", "runtime", "win32-x64", "node.exe");
  const runtime = resolveMigrationRuntime({ backendRoot });
  const evidenceRoot = path.resolve(".codex-tmp", "lean-phase1");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(evidenceRoot, "packaged-tests-"));
  const attempts = path.join(root, "network-attempts.jsonl");
  const guard = path.join(root, "offline-cli.cjs");
  // Block and record network calls before loading the real packaged CLI.
  // Downloads are initiated by Node's fetch-engine, not the SQLite schema engine.
  fs.writeFileSync(guard, `
const fs = require('node:fs');
function deny() {
  fs.appendFileSync(${JSON.stringify(attempts)}, 'network attempt\\n');
  throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN');
}
for (const [name, keys] of Object.entries({
  http: ['request', 'get'], https: ['request', 'get'],
  net: ['connect', 'createConnection'], tls: ['connect'],
  dns: ['lookup', 'resolve', 'resolve4', 'resolve6'],
})) {
  const mod = require('node:' + name);
  for (const key of keys) mod[key] = deny;
}
require('node:net').Socket.prototype.connect = deny;
require('node:dgram').Socket.prototype.send = deny;
globalThis.fetch = deny;
if (process.argv[2] === '--probe-network') {
  try { require('node:https').get('https://example.invalid'); } catch { process.exit(73); }
}
process.argv[1] = ${JSON.stringify(runtime.cliEntry)};
require('node:module').runMain();
`);
  const offlineRuntime = { ...runtime, cliEntry: guard };
  // The expected set comes from the repository migrations, never from the package under test, so a
  // migration missing from the package cannot shrink both sides of the comparison.
  const source = readMigrationFingerprint(repoRoot);
  const names = listExpectedMigrations(runtime.migrationsDir);
  expect(names, "packaged migrations must equal repository prisma/migrations").toEqual(source.migrationNames);
  function config(label) {
    const profile = path.join(root, label);
    fs.mkdirSync(profile, { recursive: true });
    // Stop Prisma's project-root search before it can discover a developer .env.
    fs.writeFileSync(path.join(profile, "package.json"), '{"private":true}');
    const databasePath = path.join(profile, "data", "fixture.db");
    return { backendRoot, nodeExecutable, databasePath, databaseUrl: `file:${databasePath.replaceAll("\\", "/")}`, tmpDir: path.join(profile, "tmp"), backupsDir: path.join(profile, "backups"), logDirectory: path.join(profile, "logs"), baseEnv: {}, cwd: profile, deps: { runMigration: (options) => runMigration({ ...options, runtime: { ...options.runtime, cliEntry: guard } }) } };
  }
  const tool = (cfg, command, arg) => runDbTool({ ...cfg, dbToolPath: runtime.dbToolPath, command, arg });
  const appliedNames = async (cfg) => (await tool(cfg, "query", "SELECT migration_name FROM _prisma_migrations ORDER BY migration_name;")).rows.map((row) => row.migration_name);
  return { source, backendRoot, nodeExecutable, runtime, root, attempts, guard, offlineRuntime, names, config, tool, appliedNames };
}

describe.skipIf(!appDir)("filtered packaged Prisma startup", () => {
  it("runs fresh, previous-migration upgrade, backup restore and named SQL failure without CLI network access", async () => {
    const app = path.resolve(appDir);
    const layout = verifyInstalledLayout(app);
    const { source, nodeExecutable, runtime, root, attempts, guard, offlineRuntime, names, config, tool, appliedNames } = createHarness(app);
    expect(layout.migrationCount, "installed migration count vs repository prisma/migrations").toBe(source.migrationCount);
    const buildInfo = JSON.parse(fs.readFileSync(path.join(app, "resources", "build-info.json"), "utf8"));
    expect(buildInfo).toMatchObject({ migrationCount: source.migrationCount, migrationNamesSha256: source.migrationNamesSha256 });
    expect(baselineViolation(runtime.migrationsDir)).toBeNull();
    const probe = spawnSync(nodeExecutable, [guard, "--probe-network"], { encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(73);
    expect(fs.readFileSync(attempts, "utf8")).toContain("network attempt");
    fs.unlinkSync(attempts);
    const fresh = config("fresh");
    const events = [];
    const started = await runStartupSequence({
      prepareDatabase: () => prepareDatabase(fresh),
      startBackend: async () => { events.push("backend"); return {}; },
      createWindow: async () => { events.push("window"); },
    });
    expect(started.database.appliedMigrations).toEqual(names);
    expect(started.database.freshNative.result).toBe("ACTIVATED");
    expect(events).toEqual(["backend", "window"]);

    const olderNames = names.slice(0, -1);
    const olderDir = path.join(root, "older-runtime");
    fs.mkdirSync(path.join(olderDir, "migrations"), { recursive: true });
    fs.copyFileSync(runtime.schemaPath, path.join(olderDir, "schema.prisma"));
    fs.copyFileSync(path.join(runtime.migrationsDir, "migration_lock.toml"), path.join(olderDir, "migrations", "migration_lock.toml"));
    for (const name of olderNames) fs.cpSync(path.join(runtime.migrationsDir, name), path.join(olderDir, "migrations", name), { recursive: true });
    const upgrade = config("upgrade");
    fs.mkdirSync(path.dirname(upgrade.databasePath), { recursive: true });
    fs.mkdirSync(upgrade.tmpDir, { recursive: true });
    const env = buildMigrationEnv({ ...upgrade, schemaEnginePath: runtime.schemaEnginePath });
    const older = spawnSync(nodeExecutable, [guard, "migrate", "deploy", "--schema", path.join(olderDir, "schema.prisma")], { env, cwd: upgrade.tmpDir, encoding: "utf8", windowsHide: true });
    expect(older.status, older.stderr).toBe(0);
    expect(await appliedNames(upgrade)).toEqual(olderNames);
    await tool(upgrade, "exec", "CREATE TABLE _lean_sentinel (value TEXT);");
    await tool(upgrade, "exec", "INSERT INTO _lean_sentinel VALUES ('preserved');");
    const upgraded = await prepareDatabase(upgrade);
    expect(upgraded.appliedMigrations).toEqual(names);
    expect(upgraded.integrity).toBe("ok");
    expect((await tool(upgrade, "query", "SELECT value FROM _lean_sentinel;")).rows).toEqual([{ value: "preserved" }]);
    const restored = config("restored");
    fs.mkdirSync(path.dirname(restored.databasePath), { recursive: true });
    fs.copyFileSync(upgraded.backup.backupPath, restored.databasePath);
    const restoredResult = await prepareDatabase(restored);
    expect(restoredResult.appliedMigrations).toEqual(names);
    expect((await tool(restored, "query", "SELECT value FROM _lean_sentinel;")).rows).toEqual([{ value: "preserved" }]);
    const status = spawnSync(nodeExecutable, [guard, "migrate", "status", "--schema", runtime.schemaPath], { env: buildMigrationEnv({ ...upgrade, schemaEnginePath: runtime.schemaEnginePath }), cwd: upgrade.tmpDir, encoding: "utf8", windowsHide: true });
    expect(status.status, status.stderr).toBe(0);

    const failureName = "20990101000000_lean_disposable_failure";
    fs.cpSync(path.join(runtime.migrationsDir, names.at(-1)), path.join(olderDir, "migrations", names.at(-1)), { recursive: true });
    fs.mkdirSync(path.join(olderDir, "migrations", failureName));
    fs.writeFileSync(path.join(olderDir, "migrations", failureName, "migration.sql"), "INSERT INTO _lean_missing_table VALUES (1);");
    const failure = config("failure");
    fs.mkdirSync(path.dirname(failure.databasePath), { recursive: true });
    fs.copyFileSync(upgrade.databasePath, failure.databasePath);
    failure.deps.resolveMigrationRuntime = () => ({ ...offlineRuntime, schemaPath: path.join(olderDir, "schema.prisma"), migrationsDir: path.join(olderDir, "migrations") });
    const failureEvents = [];
    await expect(runStartupSequence({
      prepareDatabase: () => prepareDatabase(failure),
      startBackend: async () => { failureEvents.push("backend"); },
      createWindow: async () => { failureEvents.push("window"); },
      onFailure: async () => { failureEvents.push("failed"); },
    })).rejects.toThrow(/migration failed/);
    expect(failureEvents).toEqual(["failed"]);
    const log = fs.readFileSync(path.join(failure.logDirectory, "migration.log"), "utf8");
    expect(log).not.toContain("Environment variables loaded");
    expect(log).toContain("P3018");
    expect(log).toContain(failureName);
    expect(log).toContain("no such table: _lean_missing_table");
    expect(log).not.toContain("status: success");
    const failedRows = (await tool(failure, "query", `SELECT finished_at FROM _prisma_migrations WHERE migration_name = '${failureName}';`)).rows;
    expect(failedRows).toEqual([{ finished_at: null }]);
    expect(fs.readdirSync(failure.backupsDir).filter((name) => name.endsWith(".db"))).toHaveLength(1);
    expect((await tool(failure, "query", "SELECT value FROM _lean_sentinel;")).rows).toEqual([{ value: "preserved" }]);
    await expect(prepareDatabase(failure)).rejects.toThrow(/P3009/);
    expect(fs.existsSync(attempts)).toBe(false);
    expect(older.stderr).not.toContain("Environment variables loaded");
    expect(status.stderr).not.toContain("Environment variables loaded");
    fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ fresh: started.database, upgrade: upgraded, restored: restoredResult, status: status.stdout, failureLog: log, cliNetworkAttempts: 0 }, null, 2));
  }, 240000);

  it.skipIf(!beta1AppDir)("upgrades the trusted beta.1 baseline (52 migrations) to the current set with data preserved", async () => {
    const { source, nodeExecutable, runtime, root, guard, config, tool, appliedNames } = createHarness(path.resolve(appDir));
    const beta1App = path.resolve(beta1AppDir);
    const fixtureRuntimeDir = path.join(beta1App, "resources", "backend", "prisma-runtime");
    const fixtureMigrationsDir = path.join(fixtureRuntimeDir, "migrations");
    const baselineNames = listExpectedMigrations(fixtureMigrationsDir);
    expect(baselineNames, "fixture must be exactly the beta.1 build").toHaveLength(BETA1_BASELINE.migrationCount);
    expect(baselineViolation(fixtureMigrationsDir)).toBeNull();
    const info = JSON.parse(fs.readFileSync(path.join(beta1App, "resources", "build-info.json"), "utf8"));
    expect(info).toMatchObject({ appVersion: BETA1_BASELINE.appVersion, buildCommit: BETA1_BASELINE.buildCommit, migrationCount: BETA1_BASELINE.migrationCount, migrationNamesSha256: BETA1_BASELINE.migrationNamesSha256 });

    const fixtureDir = path.join(root, "beta1-runtime");
    fs.mkdirSync(path.join(fixtureDir, "migrations"), { recursive: true });
    fs.copyFileSync(path.join(fixtureRuntimeDir, "schema.prisma"), path.join(fixtureDir, "schema.prisma"));
    fs.copyFileSync(path.join(fixtureMigrationsDir, "migration_lock.toml"), path.join(fixtureDir, "migrations", "migration_lock.toml"));
    copyMigrations(fixtureMigrationsDir, path.join(fixtureDir, "migrations"), baselineNames);
    const beta1 = config("beta1");
    fs.mkdirSync(path.dirname(beta1.databasePath), { recursive: true });
    fs.mkdirSync(beta1.tmpDir, { recursive: true });
    const deploy = spawnSync(nodeExecutable, [guard, "migrate", "deploy", "--schema", path.join(fixtureDir, "schema.prisma")], { env: buildMigrationEnv({ ...beta1, schemaEnginePath: runtime.schemaEnginePath }), cwd: beta1.tmpDir, encoding: "utf8", windowsHide: true });
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(await appliedNames(beta1)).toEqual(baselineNames);
    await tool(beta1, "exec", "CREATE TABLE _beta1_sentinel (value TEXT);");
    await tool(beta1, "exec", "INSERT INTO _beta1_sentinel VALUES ('preserved');");

    const upgraded = await prepareDatabase(beta1);
    expect(upgraded.appliedMigrations).toEqual(source.migrationNames);
    expect(upgraded.appliedMigrations.slice(0, BETA1_BASELINE.migrationCount)).toEqual(baselineNames);
    expect(upgraded.integrity).toBe("ok");
    expect((await tool(beta1, "query", "SELECT value FROM _beta1_sentinel;")).rows).toEqual([{ value: "preserved" }]);
    const backup = { ...beta1, databaseUrl: `file:${upgraded.backup.backupPath.replaceAll("\\", "/")}` };
    expect(await appliedNames(backup)).toEqual(baselineNames);
  }, 240000);
});
