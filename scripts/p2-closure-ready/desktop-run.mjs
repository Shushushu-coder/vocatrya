import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, BASELINE, argumentsFor, localDependencies, json, hash, openDb } from './package.mjs';
import { prepareDesktop, fixtures, login, createContext, executeScenes, checkReopened } from './desktop-scenarios.mjs';
import { sceneDynamicTimezone, sceneBackupExport, sceneClosureReopened, runModeMatrix, runBackupRestore, runLegacyCoverage } from './desktop-closure.mjs';
import { assembleDesktopBackend } from '../../desktop/scripts/assemble.mjs';
import { desktopEnvironment, startDesktop, connectDesktop, stopDesktop, withDeadline } from '../../desktop/e2e/harness.mjs';
import { enforceRunDirLimit, requireFreeSpace } from '../../desktop/e2e/guards.mjs';
import { runDesktopE2E } from '../../desktop/e2e/launcher.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILES = ['package.mjs', 'ts-loader.mjs', 'ui-r6.mjs', 'backend-observer.cjs', 'desktop-scenarios.mjs', 'desktop-closure.mjs', 'desktop-run.mjs'];
function scriptDigest() { return hash(SCRIPT_FILES.map(file => file + '\n' + fs.readFileSync(path.join(HERE, file), 'utf8')).join('\n')); }
function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(); }
async function preflight(input) {
  localDependencies();
  assert.equal(git('rev-parse', 'HEAD'), BASELINE, 'Source baseline changed');
  const { manifest: m, extra: x } = fixtures(input);
  assert(!fs.existsSync(path.join(m.run, 'desktop-execution-claim.json')), 'This fixture run was already claimed for desktop execution; prepare a new run');
  for (const file of SCRIPT_FILES) assert(fs.statSync(path.join(HERE, file)).isFile());
  const db = await openDb(m);
  try {
    const target = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
    assert.equal(target.reflectionCompletedAt, null);
    assert.equal(target.reflectionText, null);
    const triggerCount = await db.$queryRawUnsafe("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='trigger' AND name LIKE '_p2_audit_%'");
    assert.equal(Number(triggerCount[0].value), x.observedTables.length * 3);
    assert.equal(await db.jobOpportunity.count({ where: { userId: m.ids.primaryUser, archivedAt: null } }), 2);
    const row = await db.applicationProcessStep.findUniqueOrThrow({ where: { id: x.ids.upcomingStep } });
    assert(row.scheduledAt > new Date(), 'Upcoming fixture expired; create a fresh run');
  } finally { await db.$disconnect(); }
  return { m, x, scriptDigest: scriptDigest() };
}
function tickHash(appRoot) {
  const ids = new Set();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('tickReminders')) continue;
        for (const match of text.matchAll(/["']([a-f0-9]{40,64})["'][^;\n]{0,350}?["']tickReminders["']/g)) ids.add(match[1]);
      }
    }
  }
  visit(path.join(appRoot, '.next/static/chunks'));
  assert.equal(ids.size, 1, 'Cannot uniquely identify compiled tickReminders action; do not guess Reminder attribution');
  return hash([...ids][0]);
}
async function execute(input) {
  assert.equal(process.platform, 'win32', 'Windows interactive desktop required');
  const prepared = await preflight(input);
  const { m } = prepared;
  const electronExe = require('electron');
  assert(fs.existsSync(electronExe), 'Private Electron runtime missing; prepare through existing repository dependency process');
  const runId = randomUUID();
  json(path.join(m.run, 'desktop-execution-claim.json'), { runId, pid: process.pid, baseline: BASELINE, scripts: prepared.scriptDigest, coordination: 'Caller must have explicit main-window heavy-stage authorization and be the sole executor' });
  const observationLog = path.join(m.run, 'backend-observation.ndjson');
  fs.writeFileSync(observationLog, '', { flag: 'wx' });
  const heavyBase = path.join(ROOT, '.tmp/p2-closure-ready/heavy');
  let assemblyIdentity;
  const result = await runDesktopE2E({
    runId, root: ROOT, runBase: heavyBase,
    deps: {
      fs, execFileSync, spawnImpl: spawn, enforceRunDirLimit, requireFreeSpace,
      buildEnv: ({ dataRoot, runRoot }) => ({ ...desktopEnvironment(process.env, dataRoot), DATABASE_URL: 'file:' + path.join(runRoot, 'build.db').replaceAll('\\', '/'), AUTH_SECRET: 'p2-isolated-synthetic-build-secret' }),
      assemble: options => {
        assert.equal(scriptDigest(), prepared.scriptDigest, 'Preparation scripts changed during build');
        const inventory = assembleDesktopBackend(options);
        const server = path.join(options.outputRoot, 'backend/server.js');
        const original = fs.readFileSync(server);
        const observer = fs.readFileSync(path.join(HERE, 'backend-observer.cjs'));
        fs.writeFileSync(path.join(path.dirname(server), 'p2-observer.cjs'), observer, { flag: 'wx' });
        const prefix = 'require("./p2-observer.cjs").install(' + JSON.stringify({ file: observationLog }) + ');\n';
        fs.writeFileSync(server, Buffer.concat([Buffer.from(prefix), original]));
        assemblyIdentity = { server, originalServerSha256: hash(original), observedServerSha256: hash(fs.readFileSync(server)), observerSha256: hash(observer), scriptsSha256: prepared.scriptDigest, instrumentation: 'Generated backend entry prefix only; product source unchanged; backend non-loopback outbound guarded and observed' };
        json(path.join(path.dirname(options.repoRoot), 'p2-assembly-identity.json'), assemblyIdentity);
        return inventory;
      },
      runScenario: async ({ appRoot, runRoot, state }) => {
        assert.equal(scriptDigest(), prepared.scriptDigest, 'Preparation scripts changed during build');
        const tickActionHash = tickHash(appRoot);
        json(path.join(runRoot, 'p2-observation-identity.json'), { tickActionHash, assemblyIdentity, dataRoot: m.dataRoot, database: m.db, manifest: path.join(m.run, 'manifest.json'), desktopFixtures: path.join(m.run, 'desktop-fixtures.json'), host: 'Windows Electron', mode: 'fresh-native/full', proxy: 'System unchanged; backend test observer refuses non-loopback outbound' });
        const options = { appRoot, dataRoot: m.dataRoot, logDirectory: path.join(runRoot, 'logs'), electronExe };
        state.instance = startDesktop(options);
        await connectDesktop(state.instance);
        await login(state.instance, m);
        await withDeadline(state.instance.page.context().tracing.start({ screenshots: true, snapshots: true }), 'P2 trace start');
        assert(fs.readFileSync(observationLog, 'utf8').includes('observer-ready'), 'Backend observation prelude did not run');
        let context = await createContext(state.instance, m.run, observationLog, tickActionHash);
        let expected;
        let closureState;
        try {
          expected = await executeScenes(context);
          closureState = {
            timezone: await sceneDynamicTimezone(context),
            backup: await sceneBackupExport(context, runRoot),
          };
        }
        finally { await context.db.$disconnect(); }
        await withDeadline(state.instance.page.context().tracing.stop({ path: path.join(runRoot, 'p2-before-quit.zip') }), 'P2 trace stop');
        const first = { pid: state.instance.child.pid, origin: state.instance.origin };
        await stopDesktop(state.instance, { requireGraceful: true });
        state.instance = null;
        json(path.join(runRoot, 'p2-first-graceful-quit.json'), { observedExit: 0, ...first });
        state.instance = startDesktop({ ...options, launchNumber: 2 });
        await connectDesktop(state.instance, { authenticated: true });
        context = await createContext(state.instance, m.run, observationLog, tickActionHash);
        try {
          await checkReopened(context, expected);
          await sceneClosureReopened(context, closureState.timezone);
        }
        finally { await context.db.$disconnect(); }
        await stopDesktop(state.instance, { requireGraceful: true });
        state.instance = null;
        json(path.join(runRoot, 'p2-final-graceful-quit.json'), { observedExit: 0, completedAt: new Date().toISOString() });
        const matrix = await runModeMatrix({ appRoot, runRoot, logDirectory: path.join(runRoot, 'logs'), electronExe, input: m.run, observationLog, tickActionHash });
        json(path.join(runRoot, 'p2-mode-matrix.json'), { completedAt: new Date().toISOString(), matrix });
        const restored = await runBackupRestore({ appRoot, runRoot, logDirectory: path.join(runRoot, 'logs'), electronExe, zipPath: closureState.backup.result.zipPath, launchNumber: 9 });
        json(path.join(runRoot, 'p2-backup-restore.json'), { completedAt: new Date().toISOString(), restored });
      },
      stopDesktop,
      captureFailureArtifacts: async (instance, runRoot) => {
        if (!instance?.page || instance.page.isClosed()) return;
        const operations = [
          () => instance.page.screenshot({ path: path.join(runRoot, 'p2-failure.png'), fullPage: true, timeout: 5000 }),
          () => instance.page.context().tracing.stop({ path: path.join(runRoot, 'p2-failure-trace.zip') })
        ];
        for (const operation of operations) {
          try { await withDeadline(operation(), 'P2 failure evidence'); }
          catch (error) { console.error('P2 failure evidence: ' + error.message); }
        }
      }
    }
  });
  json(path.join(m.run, 'desktop-execution-result.json'), { runId, heavyRun: result.runRoot, ok: result.ok, primaryError: result.primaryError ? String(result.primaryError.stack || result.primaryError) : null, cleanupError: result.cleanupError ? String(result.cleanupError.stack || result.cleanupError) : null, host: 'Windows Electron', mode: 'fresh-native/full', assertions: 'See independently observed step files; absent step evidence means NOT_RUN', instrumentation: assemblyIdentity || 'NOT_RUN' });
  if (!result.ok) process.exitCode = 1;
}
function walkJson(directory, found) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJson(file, found);
    else if (entry.name.endsWith('.json')) found.push(file);
  }
}
async function assertContinuation(input) {
  localDependencies();
  assert.equal(git('rev-parse', 'HEAD'), BASELINE, 'Source baseline changed');
  const dirty = new Set([...git('diff', '--name-only', 'HEAD').split(/\r?\n/), ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/)].filter(Boolean));
  const allowed = new Set(['scripts/p2-closure-ready/desktop-run.mjs', 'scripts/p2-closure-ready/desktop-scenarios.mjs', 'scripts/p2-closure-ready/package.mjs', 'scripts/p2-closure-ready/ui-r6.mjs', 'scripts/p2-closure-ready/desktop-closure.mjs']);
  assert.deepEqual([...dirty].filter(file => !allowed.has(file)), [], 'Continuation refused: product files differ from the built snapshot');
  const { manifest: m, extra: x } = fixtures(input);
  const previous = JSON.parse(fs.readFileSync(path.join(m.run, 'desktop-execution-result.json'), 'utf8'));
  assert.equal(previous.ok, false, 'Continuation is only for the retained failed heavy run');
  const heavy = previous.heavyRun;
  const appRoot = path.join(heavy, 'app');
  assert(fs.existsSync(path.join(appRoot, '.next', 'BUILD_ID')), 'Heavy Next build is incomplete');
  const identity = JSON.parse(fs.readFileSync(path.join(heavy, 'p2-assembly-identity.json'), 'utf8'));
  assert.equal(hash(fs.readFileSync(identity.server)), identity.observedServerSha256, 'Assembled server no longer matches the recorded identity');
  const zipPath = path.join(heavy, 'backup-export.zip');
  assert(fs.statSync(zipPath).size > 1000, 'Recorded backup export is missing');
  const files = [];
  walkJson(path.join(m.run, 'checks'), files);
  const passed = new Set();
  let failed27 = false;
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stepName = body.name || '';
    const number = Number(stepName.slice(0, 2));
    if (body.status === 'PASS' && number >= 1 && number <= 26) passed.add(number);
    if (stepName.startsWith('27-') && body.status === 'FAIL') failed27 = true;
  }
  for (let number = 1; number <= 26; number += 1) assert(passed.has(number), 'Missing PASS evidence for step ' + number);
  assert(failed27, 'Original scene 27 failure record is missing');
  const db = await openDb(m);
  try {
    const detail = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
    assert(detail.reflectionCompletedAt, 'R6 completion from scenes 01-26 is gone');
    const upcoming = await db.applicationProcessStep.findUniqueOrThrow({ where: { id: x.ids.upcomingStep } });
    assert.equal(upcoming.category, 'INTERVIEW');
    assert.equal(upcoming.status, 'PENDING');
    assert(upcoming.scheduledAt > new Date(), 'Upcoming fixture expired; the continued scenes are no longer valid');
    const renamed = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='_p2_injected_AID'");
    assert.equal(renamed.length, 0, 'A previous read-failure injection is still applied');
    const blocked = await db.$queryRawUnsafe("SELECT COUNT(*) AS value FROM AbMigrationState WHERE scopeKey = 'p2-injected-blocked'");
    assert.equal(Number(blocked[0].value), 0, 'A previous blocked-state injection is still applied');
    const settings = JSON.parse((await db.userSettings.findUniqueOrThrow({ where: { userId: m.ids.primaryUser } })).settings);
    assert.equal(settings.settings.general.timeZone, 'Asia/Shanghai');
  } finally { await db.$disconnect(); }
  return { m, x, heavy, appRoot, zipPath, tickActionHash: JSON.parse(fs.readFileSync(path.join(heavy, 'p2-observation-identity.json'), 'utf8')).tickActionHash };
}
async function continueAuthorized(input) {
  assert.equal(process.platform, 'win32', 'Windows interactive desktop required');
  const ready = await assertContinuation(input);
  const electronExe = require('electron');
  const logDirectory = path.join(ready.heavy, 'logs-continue');
  const observationLog = path.join(ready.m.run, 'backend-observation.ndjson');
  const summary = { baseline: BASELINE, scripts: scriptDigest(), heavy: ready.heavy, dataRoot: ready.m.dataRoot, host: 'Windows Electron', reusedBuild: true };
  try {
    const later = [];
    walkJson(path.join(ready.m.run, 'checks'), later);
    walkJson(path.join(ready.heavy, 'checks'), later);
    const passedLater = new Set();
    for (const file of later) {
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (body.status !== 'PASS' || typeof body.name !== 'string') continue;
      const number = Number(body.name.slice(0, 2));
      if (number >= 27 && number <= 37) passedLater.add(number);
    }
    const has = number => passedLater.has(number);
    const start = [27, 28, 29, 30].every(has) ? 'ruleFailure' : 'resumeV1';
    const failures = [];
    const runPhase = async (name, action) => {
      try {
        summary[name] = await action();
      } catch (error) {
        const text = String(error?.stack ?? error);
        failures.push({ phase: name, error: text });
        summary[name + 'Error'] = text;
      }
    };
    // A failed matrix must not skip the still-missing backup import or the
    // legacy/migrated launches. Each phase keeps its own evidence files.
    if (![31].every(has) || !has(32)) {
      await runPhase('matrix', () => runModeMatrix({ appRoot: ready.appRoot, runRoot: ready.heavy, logDirectory, electronExe, input: ready.m.run, observationLog, tickActionHash: ready.tickActionHash, start, labelSuffix: '-continue', skipRecovery: has(32) }));
    }
    if (![33, 34, 35].every(has)) {
      await runPhase('restored', () => runBackupRestore({ appRoot: ready.appRoot, runRoot: ready.heavy, logDirectory, electronExe, zipPath: ready.zipPath, launchNumber: 49, resumeOnly: has(33) }));
    }
    if (!has(37)) {
      await runPhase('legacy', () => runLegacyCoverage({ appRoot: ready.appRoot, evidenceRun: ready.m.run, runRoot: ready.heavy, schemaRoot: path.join(ready.m.run, 'schema'), logDirectory, electronExe, skipLegacyUi: has(36) }));
    }
    summary.failures = failures;
    summary.ok = failures.length === 0;
    if (!summary.ok) throw new Error(failures.map(failure => failure.phase + '\n' + failure.error).join('\n\n'));
  } catch (error) {
    summary.ok = false;
    summary.error = String(error?.stack ?? error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(ready.m.run, 'desktop-continuation-result.json'), JSON.stringify(summary, null, 2) + '\n');
  }
}
try {
  const args = argumentsFor(process.argv.slice(2), ['prepare', 'validate', 'run-authorized', 'continue-authorized']);
  if (args.help) console.log('Usage: node --experimental-strip-types --experimental-transform-types scripts/p2-closure-ready/desktop-run.mjs <prepare|validate|run-authorized|continue-authorized> --run <owned-run>. continue-authorized reuses a complete heavy build and recorded 01-26 evidence; it does not rebuild or rerun those scenes.');
  else if (args.mode === 'prepare') await prepareDesktop(args.run);
  else if (args.mode === 'validate') {
    const prepared = await preflight(args.run);
    console.log(JSON.stringify({ status: 'NON_DESKTOP_PREFLIGHT_OK', baseline: BASELINE, scripts: prepared.scriptDigest, manifest: path.join(prepared.m.run, 'manifest.json'), desktop: 'NOT_RUN', builds: 0, launches: 0 }));
  } else if (args.mode === 'continue-authorized') await continueAuthorized(args.run);
  else await execute(args.run);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
