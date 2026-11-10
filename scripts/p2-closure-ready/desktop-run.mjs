import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, BASELINE, argumentsFor, localDependencies, json, hash, openDb } from './package.mjs';
import { prepareDesktop, fixtures, login, createContext, executeScenes, checkReopened } from './desktop-scenarios.mjs';
import { assembleDesktopBackend } from '../../desktop/scripts/assemble.mjs';
import { desktopEnvironment, startDesktop, connectDesktop, stopDesktop, withDeadline } from '../../desktop/e2e/harness.mjs';
import { enforceRunDirLimit, requireFreeSpace } from '../../desktop/e2e/guards.mjs';
import { runDesktopE2E } from '../../desktop/e2e/launcher.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILES = ['package.mjs', 'ts-loader.mjs', 'ui-r6.mjs', 'backend-observer.cjs', 'desktop-scenarios.mjs', 'desktop-run.mjs'];
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
        try { expected = await executeScenes(context); }
        finally { await context.db.$disconnect(); }
        await withDeadline(state.instance.page.context().tracing.stop({ path: path.join(runRoot, 'p2-before-quit.zip') }), 'P2 trace stop');
        const first = { pid: state.instance.child.pid, origin: state.instance.origin };
        await stopDesktop(state.instance, { requireGraceful: true });
        state.instance = null;
        json(path.join(runRoot, 'p2-first-graceful-quit.json'), { observedExit: 0, ...first });
        state.instance = startDesktop({ ...options, launchNumber: 2 });
        await connectDesktop(state.instance, { authenticated: true });
        context = await createContext(state.instance, m.run, observationLog, tickActionHash);
        try { await checkReopened(context, expected); }
        finally { await context.db.$disconnect(); }
        await stopDesktop(state.instance, { requireGraceful: true });
        state.instance = null;
        json(path.join(runRoot, 'p2-final-graceful-quit.json'), { observedExit: 0, completedAt: new Date().toISOString() });
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
try {
  const args = argumentsFor(process.argv.slice(2), ['prepare', 'validate', 'run-authorized']);
  if (args.help) console.log('Usage: node --experimental-strip-types --experimental-transform-types scripts/p2-closure-ready/desktop-run.mjs <prepare|validate|run-authorized> --run <owned-run>. prepare/validate never build or launch. run-authorized requires prior explicit main-window authorization and a sole heavy executor; it builds an explicit snapshot, assembles, runs real Electron and quits/reopens.');
  else if (args.mode === 'prepare') await prepareDesktop(args.run);
  else if (args.mode === 'validate') {
    const prepared = await preflight(args.run);
    console.log(JSON.stringify({ status: 'NON_DESKTOP_PREFLIGHT_OK', baseline: BASELINE, scripts: prepared.scriptDigest, manifest: path.join(prepared.m.run, 'manifest.json'), desktop: 'NOT_RUN', builds: 0, launches: 0 }));
  } else await execute(args.run);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
