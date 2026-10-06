import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildMigrationEnv, prepareDatabase, resolveMigrationRuntime, runMigration } from "./database-migration.js";
import { runDbTool } from "./db-runner.js";
import { runStartupSequence } from "./startup.js";
import { verifyInstalledLayout } from "../scripts/verify-installer.mjs";

// Opt-in: exercise the actual built artifact and pinned Node, never a developer DB.
const appDir = process.env.VOCATRYA_PACKAGED_TEST_APP_DIR;
describe.skipIf(!appDir)("filtered packaged Prisma startup", () => {
  it("runs fresh, older upgrade, backup restore and named SQL failure without CLI network access", async () => {
    const app = path.resolve(appDir);
    expect(verifyInstalledLayout(app).migrationCount).toBe(52);
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
    const probe = spawnSync(nodeExecutable, [guard, "--probe-network"], { encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(73);
    expect(fs.readFileSync(attempts, "utf8")).toContain("network attempt");
    fs.unlinkSync(attempts);
    const offlineRuntime = { ...runtime, cliEntry: guard };
    const names = fs.readdirSync(runtime.migrationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    function config(label) {
      const profile = path.join(root, label);
      fs.mkdirSync(profile, { recursive: true });
      // Stop Prisma's project-root search before it can discover a developer .env.
      fs.writeFileSync(path.join(profile, "package.json"), '{"private":true}');
      const databasePath = path.join(profile, "data", "fixture.db");
      return { backendRoot, nodeExecutable, databasePath, databaseUrl: `file:${databasePath.replaceAll("\\", "/")}`, tmpDir: path.join(profile, "tmp"), backupsDir: path.join(profile, "backups"), logDirectory: path.join(profile, "logs"), baseEnv: {}, cwd: profile, deps: { runMigration: (options) => runMigration({ ...options, runtime: { ...options.runtime, cliEntry: guard } }) } };
    }
    const tool = (cfg, command, arg) => runDbTool({ ...cfg, dbToolPath: runtime.dbToolPath, command, arg });
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

    const olderDir = path.join(root, "older-runtime");
    fs.mkdirSync(path.join(olderDir, "migrations"), { recursive: true });
    fs.copyFileSync(runtime.schemaPath, path.join(olderDir, "schema.prisma"));
    fs.copyFileSync(path.join(runtime.migrationsDir, "migration_lock.toml"), path.join(olderDir, "migrations", "migration_lock.toml"));
    for (const name of names.slice(0, -1)) fs.cpSync(path.join(runtime.migrationsDir, name), path.join(olderDir, "migrations", name), { recursive: true });
    const upgrade = config("upgrade");
    fs.mkdirSync(path.dirname(upgrade.databasePath), { recursive: true });
    fs.mkdirSync(upgrade.tmpDir, { recursive: true });
    const env = buildMigrationEnv({ ...upgrade, schemaEnginePath: runtime.schemaEnginePath });
    const older = spawnSync(nodeExecutable, [guard, "migrate", "deploy", "--schema", path.join(olderDir, "schema.prisma")], { env, cwd: upgrade.tmpDir, encoding: "utf8", windowsHide: true });
    expect(older.status, older.stderr).toBe(0);
    expect(Number((await tool(upgrade, "query", "SELECT count(*) AS n FROM _prisma_migrations;")).rows[0].n)).toBe(51);
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
});
