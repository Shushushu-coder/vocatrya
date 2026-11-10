import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { runDesktopE2E } from '../../desktop/e2e/launcher.mjs';
import { desktopEnvironment, connectDesktop, stopDesktop, withDeadline } from '../../desktop/e2e/harness.mjs';
import { assembleDesktopBackend } from '../../desktop/scripts/assemble.mjs';
import { runManagedScenario } from './managed-desktop-scenario.mjs';
const require = createRequire(import.meta.url);
const fixtureApi = require('./fixture.cjs');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '../..');
const task = path.join(root, '.tmp/managed-closure-ready');
const hash = value => createHash('sha256').update(value).digest('hex');
const INPUTS = ['src', 'public', 'prisma/schema.prisma', 'prisma/migrations', 'desktop/main', 'desktop/assets', 'scripts/build-fresh-native-bootstrap.mjs', 'next.config.mjs', 'next-env.d.ts', 'eslint.config.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'postcss.config.mjs'];
const SUPPORT = ['desktop/e2e/launcher.mjs', 'desktop/e2e/harness.mjs', 'desktop/e2e/guards.mjs', 'desktop/e2e/scenario.mjs', 'desktop/scripts/assemble.mjs', 'desktop/scripts/scan-managed-secrets.mjs', 'desktop/scripts/prisma-runtime-filter.cjs', 'scripts/managed-closure-ready/fixture.cjs', 'scripts/managed-closure-ready/managed-desktop.mjs', 'scripts/managed-closure-ready/managed-desktop-scenario.mjs'];
const FIXTURE_ENV = ['VOCATRYA_HOSTED_ENDPOINT', 'VOCATRYA_DESKTOP_DATA_ROOT', 'VOCATRYA_AB_RUNTIME_ENABLED', 'VOCATRYA_AB_ROLLOUT_SCOPE'];
function invariant(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function safeExisting(parent, candidate) {
  invariant(inside(parent, candidate), 'PATH_OUTSIDE_TASK');
  invariant(inside(fs.realpathSync(parent), fs.realpathSync(candidate)), 'LINK_OUTSIDE_TASK');
}
function sourcePlan() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...INPUTS], { cwd: root, windowsHide: true }).toString().split('\0').filter(Boolean))].sort();
  invariant(files.length > 0, 'EMPTY_SOURCE_LIST');
  const digest = createHash('sha256');
  const hashes = {};
  for (const file of files) {
    invariant(inside(root, path.join(root, file)), 'INVALID_SOURCE_PATH');
    invariant(!file.split(/[\\/]/).some(part => part === '.tmp' || part === '.private' || part.startsWith('.env')), 'FORBIDDEN_SOURCE_FILE');
    const absolute = path.join(root, file);
    let content = '<deleted>';
    if (fs.existsSync(absolute)) {
      invariant(fs.lstatSync(absolute).isFile(), 'SOURCE_MUST_BE_REGULAR_FILE');
      content = fs.readFileSync(absolute);
      hashes[file] = hash(content);
    } else hashes[file] = null;
    digest.update(file); digest.update(content);
  }
  return { inputs: INPUTS, files, hashes, digest: digest.digest('hex') };
}
function configuration(id, selected) {
  const directory = fixtureApi.runDir(id);
  safeExisting(task, directory);
  const manifest = fixtureApi.read(path.join(directory, 'manifest.json'));
  invariant(manifest.runId === id && manifest.status === 'READY', 'FIXTURE_MANIFEST_NOT_READY');
  invariant(path.resolve(manifest.runDir) === directory, 'FIXTURE_ROOT_MISMATCH');
  invariant(path.resolve(manifest.nativeRoot) === path.join(directory, 'native'), 'NATIVE_ROOT_MISMATCH');
  const environment = manifest.desktopEnv;
  invariant(environment && Object.keys(environment).sort().join() === [...FIXTURE_ENV].sort().join(), 'UNEXPECTED_FIXTURE_ENVIRONMENT');
  const endpoint = new URL(environment.VOCATRYA_HOSTED_ENDPOINT);
  invariant(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port && endpoint.pathname === '/' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'FIXTURE_ENDPOINT_MUST_BE_LOOPBACK');
  invariant(environment.VOCATRYA_HOSTED_ENDPOINT === manifest.hosted, 'HOSTED_ENDPOINT_MISMATCH');
  invariant(environment.VOCATRYA_DESKTOP_DATA_ROOT === manifest.nativeRoot && environment.VOCATRYA_AB_RUNTIME_ENABLED === 'true' && environment.VOCATRYA_AB_ROLLOUT_SCOPE === 'full', 'FIXTURE_ENVIRONMENT_CONTRACT');
  const modules = path.join(root, 'node_modules');
  invariant(fs.existsSync(modules), 'OWN_DEPENDENCIES_MISSING');
  invariant(inside(root, fs.realpathSync(modules)), 'SHARED_NODE_MODULES_FORBIDDEN');
  const electronExe = path.join(modules, 'electron', 'dist', 'electron.exe');
  for (const file of [electronExe, path.join(modules, 'next/dist/bin/next'), path.join(modules, '@playwright/test/package.json'), path.join(modules, '.prisma/client/index.js')]) {
    invariant(fs.existsSync(file), 'REQUIRED_LOCAL_DEPENDENCY_MISSING');
    invariant(inside(root, fs.realpathSync(file)), 'DEPENDENCY_OUTSIDE_WORKTREE');
  }
  for (const [relative, expected] of Object.entries(manifest.sourceHashes || {})) {
    invariant(inside(root, path.join(root, relative)), 'INVALID_FIXTURE_SOURCE_PATH');
    invariant(hash(fs.readFileSync(path.join(root, relative))) === expected, 'FIXTURE_SOURCE_CHANGED_RESTART_FRESH_FIXTURE');
  }
  const sources = sourcePlan();
  const supportHashes = Object.fromEntries(SUPPORT.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  invariant(head === manifest.baseline.head, 'FIXTURE_HEAD_DIFFERS_FROM_DESKTOP_HEAD');
  const executionDigest = hash(JSON.stringify({ head, sourceDigest: sources.digest, supportHashes, fixtureId: id, hosted: manifest.hosted, nativeRoot: manifest.nativeRoot, selected }));
  return { id, directory, manifest, sources, supportHashes, head, executionDigest, electronExe, selected };
}
function launchOwned({ appRoot, dataRoot, logDirectory, electronExe, environment, number }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'electron'), { recursive: true });
  const activePortFile = path.join(dataRoot, 'electron', 'DevToolsActivePort');
  fs.rmSync(activePortFile, { force: true });
  const backendLog = path.join(dataRoot, 'logs', 'backend-stdout.log');
  const offset = fs.existsSync(backendLog) ? fs.statSync(backendLog).size : 0;
  const output = fs.createWriteStream(path.join(logDirectory, 'electron-' + number + '.log'));
  const child = spawn(electronExe, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', appRoot], { cwd: appRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { child.spawnError = error; });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  child.once('close', () => output.end());
  return { child, activePortFile, backendLog, offset, browser: null, page: null };
}
async function execute(plan, owner) {
  invariant(process.platform === 'win32', 'WINDOWS_REQUIRED');
  invariant(owner && owner.trim().length > 0, 'COORDINATOR_SERIAL_OWNER_REQUIRED');
  const mutex = path.join(task, 'desktop-heavy.lock');
  const ownership = { pid: process.pid, nonce: randomUUID(), owner, fixtureId: plan.id };
  const descriptor = fs.openSync(mutex, 'wx');
  fs.writeFileSync(descriptor, JSON.stringify(ownership)); fs.closeSync(descriptor);
  try {
    await fixtureApi.rpc(plan.id, 'health');
    const initial = await fixtureApi.rpc(plan.id, 'state');
    invariant(initial.heldCount === 0 && initial.mode === 'success' && initial.usage.length === 0 && initial.upstreamCount === 0, 'FRESH_UNUSED_FIXTURE_REQUIRED');
    invariant(!fs.existsSync(plan.manifest.nativeRoot), 'FRESH_NATIVE_ROOT_MUST_NOT_EXIST');
    const key = fixtureApi.read(plan.manifest.defaultKeyFile);
    invariant(key.hostedUserId === 'desktop-beta' && key.expiresAt > Date.now() + 600000, 'FRESH_DEFAULT_SESSION_REQUIRED');
    const subscription = initial.subscriptions.find(row => row.hostedUserId === 'desktop-beta');
    invariant(subscription?.status === 'ACTIVE' && subscription.planKey === 'beta' && subscription.periodEnd > Date.now() + 600000, 'DEFAULT_BETA_ENTITLEMENT_REQUIRED');
    const heavyRunId = randomUUID();
    const runBase = path.join(task, 'desktop-runs');
    const runRoot = path.join(runBase, heavyRunId);
    const launches = [];
    let launchNumber = 0;
    const result = await runDesktopE2E({
      runId: heavyRunId, root, runBase,
      deps: {
        onLog: line => console.log(line.startsWith('PASS Windows Electron fresh-native E2E') ? 'PASS selected managed desktop checks: ' + plan.selected.join(',') : line),
        buildEnv: ({ dataRoot, runRoot: current }) => {
          const temporary = path.join(current, 'temp'); fs.mkdirSync(temporary, { recursive: true });
          return { ...desktopEnvironment(process.env, dataRoot), ...plan.manifest.desktopEnv, VOCATRYA_DESKTOP_DATA_ROOT: dataRoot, TEMP: temporary, TMP: temporary, DATABASE_URL: 'file:' + path.join(current, 'build.db').replaceAll('\\', '/'), AUTH_SECRET: 'managed-desktop-synthetic-build-only', NODE_ENV: 'production' };
        },
        spawnImpl: (executable, args, options) => {
          const copied = {};
          for (const [relative, expected] of Object.entries(plan.sources.hashes)) {
            const file = path.join(options.cwd, relative);
            if (expected === null) { invariant(!fs.existsSync(file), 'DELETED_SOURCE_PRESENT_IN_SNAPSHOT'); copied[relative] = null; }
            else { copied[relative] = hash(fs.readFileSync(file)); invariant(copied[relative] === expected, 'SNAPSHOT_HASH_MISMATCH'); }
          }
          fixtureApi.save(path.join(runRoot, 'snapshot-manifest.json'), { host: 'WINDOWS_ELECTRON', mode: 'fresh-native', head: plan.head, sourceDigest: plan.sources.digest, executionDigest: plan.executionDigest, sourceInputs: INPUTS, sourceHashes: copied, supportHashes: plan.supportHashes, fixtureId: plan.id, fixtureSourceHashes: plan.manifest.sourceHashes, build: 'RUNNING', desktop: 'NOT_RUN', selected: plan.selected, owner });
          const output = fs.createWriteStream(path.join(runRoot, 'build.log'));
          const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
          child.once('close', () => output.end());
          console.log(JSON.stringify({ stage: 'build', pid: child.pid, cwd: options.cwd, log: path.join(runRoot, 'build.log') }));
          return child;
        },
        assemble: options => {
          assembleDesktopBackend(options);
          const file = path.join(runRoot, 'snapshot-manifest.json');
          const current = fixtureApi.read(file);
          fixtureApi.save(file, { ...current, build: 'PASS', assembly: 'PASS', buildId: fs.readFileSync(path.join(options.repoRoot, '.next', 'BUILD_ID'), 'utf8').trim(), appRoot: options.repoRoot, assembledRoot: options.outputRoot });
        },
        runScenario: async ({ appRoot, runRoot: current, state }) => {
          const dataRoot = plan.manifest.nativeRoot;
          const environment = { ...desktopEnvironment(process.env, dataRoot), ...plan.manifest.desktopEnv, TEMP: path.join(current, 'temp'), TMP: path.join(current, 'temp') };
          for (const name of FIXTURE_ENV) invariant(environment[name] === plan.manifest.desktopEnv[name], 'RUNTIME_FIXTURE_ENV_DROPPED');
          fixtureApi.save(path.join(current, 'runtime-config.json'), { fixtureId: plan.id, fixturePid: initial.pid, environment: Object.fromEntries(FIXTURE_ENV.map(name => [name, environment[name]])), dataRoot, launches, selected: plan.selected, systemProxy: 'UNCHANGED', realAI: 'NOT_RUN' });
          async function start(authenticated = false) {
            invariant(!state.instance, 'PREVIOUS_INSTANCE_NOT_RELEASED');
            const instance = launchOwned({ appRoot, dataRoot, logDirectory: path.join(current, 'logs'), electronExe: plan.electronExe, environment, number: ++launchNumber });
            state.instance = instance;
            const entry = { number: launchNumber, electronPid: instance.child.pid, status: 'STARTING', dataRoot };
            launches.push(entry);
            fixtureApi.save(path.join(current, 'processes.json'), launches);
            await connectDesktop(instance, { authenticated });
            entry.origin = instance.origin; entry.status = 'CONNECTED';
            fixtureApi.save(path.join(current, 'processes.json'), launches);
            return instance;
          }
          async function stop() {
            const instance = state.instance;
            invariant(instance, 'NO_OWNED_INSTANCE');
            await stopDesktop(instance, { requireGraceful: true });
            const entry = launches.find(row => row.electronPid === instance.child.pid);
            if (entry) { entry.status = 'QUIT_IPC_EXITED_BACKEND_PORT_CLOSED'; entry.exitCode = instance.child.exitCode; }
            fixtureApi.save(path.join(current, 'processes.json'), launches);
            state.instance = null;
          }
          await runManagedScenario({ root, runRoot: current, dataRoot, state, fixtureId: plan.id, fixture: plan.manifest, selected: plan.selected, start, stop });
        },
        stopDesktop: instance => stopDesktop(instance, { requireGraceful: true }),
        captureFailureArtifacts: async instance => {
          if (instance?.page && !instance.page.isClosed()) await withDeadline(instance.page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {}), 'failure screenshot', 10000).catch(() => {});
        }
      }
    });
    if (fs.existsSync(runRoot)) fixtureApi.save(path.join(runRoot, 'launcher-result.json'), { ok: result.ok, fixtureId: plan.id, heavyRunId, fixturePidStillOwnedByMain: initial.pid, selected: plan.selected, primaryError: result.primaryError ? { name: result.primaryError.name, code: result.primaryError.code || null } : null, cleanupError: result.cleanupError ? { name: result.cleanupError.name, code: result.cleanupError.code || null } : null, sourceDigest: plan.sources.digest, executionDigest: plan.executionDigest, realAI: 'NOT_RUN', deployment: 'NOT_RUN' });
    console.log(JSON.stringify({ ok: result.ok, heavyRunId, runRoot, fixturePid: initial.pid, fixtureKeptRunning: true, selected: plan.selected }));
    if (!result.ok) process.exitCode = 1;
  } finally {
    const present = JSON.parse(fs.readFileSync(mutex, 'utf8'));
    invariant(present.pid === ownership.pid && present.nonce === ownership.nonce, 'LOCAL_HEAVY_LOCK_OWNERSHIP_CHANGED');
    fs.unlinkSync(mutex);
  }
}
async function main() {
  const [command = 'help', requestedId, ...options] = process.argv.slice(2);
  if (command === 'help') { console.log('validate <fixture-run-id> [--case=all|lifecycle|quota|entitlement]; execute additionally requires --serial-owner=NAME --expected-source=DIGEST. execute is a future heavy-phase command, not authorized by preparation.'); return; }
  invariant(['validate', 'execute'].includes(command), 'INVALID_COMMAND');
  const values = {};
  for (const option of options) {
    const match = /^--(case|serial-owner|expected-source)=(.+)$/.exec(option);
    invariant(match && values[match[1]] === undefined, 'INVALID_OPTION'); values[match[1]] = match[2];
  }
  const choice = values.case || 'all';
  invariant(['all', 'lifecycle', 'quota', 'entitlement'].includes(choice), 'INVALID_CASE');
  const selected = choice === 'all' ? ['quota', 'entitlement', 'lifecycle'] : [choice];
  const id = fixtureApi.runId(requestedId);
  const plan = configuration(id, selected);
  if (command === 'validate') {
    console.log(JSON.stringify({ status: 'VALID_CONFIG_ONLY', fixtureId: id, fixtureManifestStatus: plan.manifest.status, fixtureEndpoint: plan.manifest.hosted, nativeRoot: plan.manifest.nativeRoot, nativeRootExists: fs.existsSync(plan.manifest.nativeRoot), head: plan.head, sourceInputs: INPUTS, sourceCount: plan.sources.files.length, sourceDigest: plan.sources.digest, executionDigest: plan.executionDigest, selected, supportHashes: plan.supportHashes, runtimeHealth: 'NOT_RUN', snapshot: 'NOT_RUN', productionBuild: 'NOT_RUN', assembly: 'NOT_RUN', electron: 'NOT_RUN', scenario: 'NOT_RUN' }, null, 2));
    return;
  }
  invariant(values['expected-source'] === plan.executionDigest, 'VALIDATED_EXECUTION_DIGEST_REQUIRED');
  await execute(plan, values['serial-owner']);
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', error: error.code || error.name })); process.exitCode = 1; });
