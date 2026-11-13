import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import JSZip from 'jszip';
import { openDb, evidenceDirectory, step, json, hash, ROOT } from './package.mjs';
import { fixtures, createContext, login, t } from './desktop-scenarios.mjs';
import { desktopEnvironment, connectDesktop, stopDesktop } from '../../desktop/e2e/harness.mjs';

// Task-C closure driver: everything here supplements the existing scenes
// against the SAME built app. Every launch is a real Electron start; mode
// variants change ONLY the spawned environment (the production desktop env
// template stays the source of truth). Fault injections run while the app is
// stopped, on the owned fixture DB only, and are always reverted.
//
// Launch inventory (one authorized heavy run):
//   launch 1 fresh/full: scenes 01-19 + C1 timezone + C2 export (existing flow)
//   launch 2 fresh/full: scene 19 reopened + closure reopened checks
//   launch 3 READY_DISABLED (feature=false): read surfaces + R6 silent + writes gated
//   launch 4 AB_ENABLED scope=resume_v1: jobs family blocked surfaces
//   launch 5 READY_DISABLED via scope=none: mode + R6 silent
//   launch 6 BLOCKED (injected 2nd AbMigrationState): typed blocked degradation
//   launch 7 fresh/full + injected ApplicationInterviewDetail rename:
//          R6 read failure silent + M9 null-vs-0 + real page error path
//   launch 8 fresh/full recovery after revert
//   launch 9 second data root: real backup import + restored evidence
//   launch 10/11 legacy root (only when a legacy DB can be constructed): LEGACY_ONLY, then migrated-full

export function startDesktopVariant({ appRoot, dataRoot, logDirectory, electronExe, launchNumber, env = {} }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const activePortFile = path.join(dataRoot, 'electron', 'DevToolsActivePort');
  fs.rmSync(activePortFile, { force: true });
  const backendLog = path.join(dataRoot, 'logs', 'backend-stdout.log');
  const offset = fs.existsSync(backendLog) ? fs.statSync(backendLog).size : 0;
  const electronLog = path.join(logDirectory, `electron-${launchNumber}.log`);
  const output = fs.createWriteStream(electronLog);
  const child = spawn(electronExe, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', appRoot], {
    cwd: appRoot,
    env: { ...desktopEnvironment(process.env, dataRoot), ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { child.spawnError = error; });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.once('close', () => output.end());
  return { child, activePortFile, backendLog, offset, electronLog, browser: null, page: null };
}

// Reuses the real connectDesktop handshake, then independently asserts the
// emitted career-runtime line for the expected mode — never relabels a launch.
export async function connectDesktopExpect(instance, { authenticated = true, expected }) {
  let fullModeError = null;
  try {
    await connectDesktop(instance, { authenticated });
  } catch (error) {
    fullModeError = error;
  }
  const log = fs.readFileSync(instance.backendLog).subarray(instance.offset).toString('utf8');
  const match = log.match(/career-runtime state=(\S+) mode=(\S+) feature=(\S+) featureSource=(\S+) scope=(\S+) scopeSource=(\S+) writeFamily=(\S+)/);
  assert(match, 'Backend log lacks the career-runtime line: ' + log.slice(-500));
  const observed = { state: match[1], mode: match[2], feature: match[3], featureSource: match[4], scope: match[5], scopeSource: match[6], writeFamily: match[7] };
  // The shared harness only accepts fresh-native full. Migrated-full is
  // COMPLETED / AB_ENABLED / full, so it must not be relabeled as fresh.
  const expectsHarnessFreshFull = expected.state === 'FRESH_READY' && expected.mode === 'AB_ENABLED' && expected.scope === 'full';
  if (expectsHarnessFreshFull) {
    assert(fullModeError === null, 'fresh/full launch did not satisfy the harness assertion: ' + String(fullModeError?.message ?? fullModeError));
  } else {
    assert(fullModeError !== null && /FRESH_READY \/ AB_ENABLED/.test(String(fullModeError.message)), 'Expected the harness full-mode assertion to fail under mode ' + expected.state + '/' + expected.mode + '/' + expected.scope + ', got: ' + String(fullModeError?.message ?? fullModeError));
  }
  assert.deepEqual({ state: observed.state, mode: observed.mode, scope: observed.scope }, expected, 'career-runtime line mismatch');
  return observed;
}

export async function gracefulQuit(instance, label) {
  const pid = instance.child.pid;
  const origin = instance.origin;
  await stopDesktop(instance, { requireGraceful: true });
  json(path.join(label.runRoot, label.file), { observedExit: 0, pid, origin, at: new Date().toISOString() });
}

// ---------- CAREER-INSIGHTS: dynamic account timezone ----------

// Nivo renders one rect per day. The trend metric counts POSITIONS by their
// first-application day (frozen M3), so both fixture attempts of the same
// position produce a single nonzero bar — the observable timezone effect is
// that bar's DAY LABEL. Pair each bar with its nearest axis tick label.
async function trendBarDayLabels(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="analytics-panel"] svg');
    if (!svg) return null;
    const bars = [...svg.querySelectorAll('rect[fill="#2a7ef0"]')];
    // Day tick labels only: value labels sit above their bars, axis legends
    // sit to the left — restrict to texts below the bar baseline.
    const baseline = Math.max(...bars.map(bar => bar.getBoundingClientRect().bottom), 0);
    const texts = [...svg.querySelectorAll('text')].map(node => ({ rect: node.getBoundingClientRect(), label: node.textContent.trim() })).filter(t => t.label.length > 0 && !/^\d+$/.test(t.label) && t.rect.top >= baseline - 8);
    return bars.map(bar => {
      const box = bar.getBoundingClientRect();
      const cx = box.x + box.width / 2;
      const nearest = texts.reduce((best, t) => (Math.abs(t.rect.x + t.rect.width / 2 - cx) < Math.abs((best?.rect.x ?? 0) + (best?.rect.width ?? 0) / 2 - cx) ? t : best), null);
      return { height: Number(bar.getAttribute('height')), label: nearest?.label ?? null };
    });
  });
}

export async function sceneDynamicTimezone(ctx) {
  const { m, page, instance, check } = ctx;
  const before = await check('20-analytics-trend-before-timezone-change', async () => {
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const bars = await trendBarDayLabels(page);
    const nonzero = bars.filter(bar => bar.height > 0);
    assert.equal(nonzero.length, 1, 'One position has one first-application day — a single nonzero bar is expected');
    assert.match(nonzero[0].label, /Nov 9|11月9/, 'America/Los_Angeles must bucket the boundary submission on 2026-11-09, got: ' + nonzero[0].label);
    return { bars, timezone: m.accountTimeZone };
  });
  const changed = await check('21-account-timezone-change-shifts-day-buckets', async () => {
    await page.goto(instance.origin + '/dashboard/settings', { waitUntil: 'load' });
    await expect(page.getByTestId('settings-timezone-select')).toBeVisible();
    await page.getByTestId('settings-timezone-select').click();
    await page.getByTestId('settings-timezone-search').fill('Shanghai');
    await page.getByTestId('settings-timezone-option-Asia/Shanghai').click();
    const db = ctx.db;
    await expect.poll(async () => {
      const row = await db.userSettings.findUniqueOrThrow({ where: { userId: m.ids.primaryUser } });
      return JSON.parse(row.settings).settings?.general?.timeZone;
    }).toBe('Asia/Shanghai');
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const bars = await trendBarDayLabels(page);
    const nonzero = bars.filter(bar => bar.height > 0);
    assert.equal(nonzero.length, 1, 'Still one position first-application day');
    assert.match(nonzero[0].label, /Nov 10|11月10/, 'Asia/Shanghai must bucket the SAME submission on 2026-11-10, got: ' + nonzero[0].label);
    assert.notEqual(nonzero[0].label, before.result.bars.find(bar => bar.height > 0)?.label, 'Day bucket did not move with the account timezone');
    return { bars, timezone: 'Asia/Shanghai' };
  });
  return { before, changed, accountZoneAfter: 'Asia/Shanghai' };
}

// ---------- JOB-CONNECTIONS: real backup export + privacy scan ----------

// Keys whose VALUES would carry secret material if they leaked into the
// default (non-sensitive) export. Anchored to whole JSON key names — a bare
// substring like "iv" would false-positive on "archivedAt".
const DENIED_EXPORT_KEYS = new Set(['apikey', 'apikeys', 'api_key', 'api_key_id', 'credential', 'credentials', 'encryptedkey', 'iv', 'last4', 'managedsecret', 'password', 'secret', 'token']);
// Benign non-secret key names that share the same stems (credential metadata
// on domain models, never the key material itself).
const ALLOWED_EXPORT_KEYS = new Set(['aicredential', 'credentialbacked', 'credentialtype', 'credentialstate', 'credentialcount', 'credentialstatus']);
const JSON_KEY = /"([^"]{1,64})"\s*:/g;

export async function sceneBackupExport(ctx, runDir) {
  return ctx.check('22-real-backup-export-and-entry-scan', async () => {
    // Default export path: includeSensitiveData is absent (false) — the
    // privacy check proves sensitive tables never leak by default.
    const response = await ctx.page.request.get(ctx.instance.origin + '/api/backup/export');
    assert.equal(response.status(), 200, 'Backup export rejected the authenticated request');
    assert(response.headers()['content-type'].includes('zip'), 'Export did not return a ZIP');
    const bytes = await response.body();
    const zipPath = path.join(runDir, 'backup-export.zip');
    fs.writeFileSync(zipPath, bytes);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert(names.some(name => name.endsWith('data.json')), 'Backup ZIP lacks data.json');
    // Privacy scan must inspect DECOMPRESSED entry contents — the ZIP bytes
    // alone cannot prove what was exported.
    const flagged = [];
    for (const name of names) {
      const content = await zip.files[name].async('string');
      for (const match of content.matchAll(JSON_KEY)) {
        const key = match[1].toLowerCase();
        if (DENIED_EXPORT_KEYS.has(key) && !ALLOWED_EXPORT_KEYS.has(key)) {
          flagged.push({ entry: name, snippet: content.slice(match.index, match.index + 100) });
        }
      }
    }
    assert.deepEqual(flagged, [], 'Sensitive key material present in decompressed backup entries');
    const data = JSON.parse(await zip.file('data.json').async('string'));
    const tables = Object.keys(data.tables ?? data);
    assert(tables.length > 0, 'Backup data payload has no tables');
    return { zipPath, entries: names.length, tables: tables.length, artifactBytesInZip: names.filter(name => name.startsWith('resume-artifacts/')).length, attachmentEntries: names.filter(name => name.startsWith('career-attachments/')).length };
  });
}

// ---------- reopened (launch 2): per-feature persistence ----------

export async function sceneClosureReopened(ctx, tzState) {
  const { m, x, db, page, instance, check } = ctx;
  await check('23-reopen-job-connections-ui-and-download', async () => {
    // Actual job detail must be readable after a real quit/reopen: plan
    // links, submitted facts, relations and a real download.
    const references = await ctx.referencesUi();
    const artifact = m.artifacts.find(row => row.versionId === m.versions[0].id);
    const response = await page.request.get(instance.origin + '/api/profile/resume-artifacts/' + artifact.id);
    assert.equal(response.status(), 200);
    assert.equal(hash(await response.body()), artifact.sha256);
    return { references, downloadedSha256: artifact.sha256 };
  });
  await check('24-reopen-insights-timezone-persisted-buckets', async () => {
    const settings = await db.userSettings.findUniqueOrThrow({ where: { userId: m.ids.primaryUser } });
    assert.equal(JSON.parse(settings.settings).settings?.general?.timeZone, tzState.accountZoneAfter, 'Account timezone did not persist across reopen');
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const bars = await trendBarDayLabels(page);
    const nonzero = bars.filter(bar => bar.height > 0);
    assert.equal(nonzero.length, 1, 'Persisted timezone must reproduce the same single first-application day');
    assert.match(nonzero[0].label, /Nov 10|11月10/, 'Reopen must keep the Asia/Shanghai bucket label, got: ' + nonzero[0].label);
    const card = page.getByTestId('board-total-applied');
    await expect(card).toBeVisible();
    await card.getByRole('link').click();
    await expect(page).toHaveURL(/\/dashboard\/myjobs\?applied=true/);
    await expect(page.getByTestId('applied-filter-badge')).toBeVisible();
    return { bars };
  });
  await check('25-reopen-next-actions-reflect-business-state', async () => {
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    // R6 was completed through the real UI in scene ui-r6 and must not
    // re-enter candidates; the upcoming R5 event is the persisted truth.
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0);
    await expect(page.getByTestId('next-action-R5:' + x.ids.upcomingStep)).toBeVisible();
    const detail = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
    assert(detail.reflectionCompletedAt, 'R6 completion marker lost across reopen');
    return { r6Silent: true, r5Visible: true, completedAt: detail.reflectionCompletedAt };
  });
}

// ---------- mode matrix launches ----------

async function launchCycle({ appRoot, dataRoot, logDirectory, electronExe, launchNumber, env, expected, input, observationLog, tickActionHash, scenes, runRoot, label }) {
  const instance = startDesktopVariant({ appRoot, dataRoot, logDirectory, electronExe, launchNumber, env });
  try {
    const runtime = await connectDesktopExpect(instance, { authenticated: true, expected });
    const ctx = await createContext(instance, input, observationLog, tickActionHash);
    const observed = { runtime, scenes: {} };
    try {
      for (const [name, scene] of Object.entries(scenes)) observed.scenes[name] = await scene(ctx);
    } finally {
      await ctx.db.$disconnect();
    }
    return observed;
  } finally {
    await stopDesktop(instance, { requireGraceful: true });
    json(path.join(runRoot, `p2-${label}-graceful-quit.json`), { observedExit: 0, pid: instance.child.pid, at: new Date().toISOString() });
  }
}

async function sceneReadyDisabled(ctx) {
  const { m, db, page, instance, check } = ctx;
  await check('26-ready-disabled-read-surface-write-gated', async () => {
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const card = page.getByTestId('board-total-applied');
    await expect(card).toBeVisible();
    await expect(card.locator('p.text-2xl')).toHaveText('1');
    // M9 stays readable on the read-only surface (contract D3 keeps R6
    // silent but the metric itself remains a real read). R6 was completed in
    // scene ui-r6, so the true value here is a real 0 — not an absent card.
    const awaiting = page.getByTestId('board-total-awaitingReflection');
    await expect(awaiting).toBeVisible();
    await expect(awaiting.locator('p.text-2xl')).toHaveText('0');
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    // reflectionWriteEnabled=false -> R6 silent; R5 remains a real read.
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0);
    await expect(page.getByTestId('next-action-R5:' + ctx.x.ids.upcomingStep)).toBeVisible();
    // Canonical writes must be gated: the read-only surface keeps the
    // reflection entry (contract keeps read viewing) but the dialog must be
    // read-only — no save affordance.
    await page.goto(instance.origin + '/dashboard/myjobs/' + m.ids.job + '?tab=timeline', { waitUntil: 'load' });
    await expect(page.getByTestId('application-timeline')).toBeVisible();
    const row = page.getByTestId('application-process-step').filter({ hasText: m.r6Label });
    await expect(row).toHaveCount(1);
    await row.getByTestId('interview-reflection-entry').click();
    await expect(page.getByTestId('interview-reflection-dialog')).toBeVisible();
    await expect(page.getByTestId('interview-reflection-save')).toHaveCount(0);
    await expect(page.getByTestId('interview-reflection-overall')).toHaveAttribute('readonly', '');
    return { awaiting: '1', r5Visible: true, r6Silent: true, reflectionDialog: 'read-only' };
  });
}

function observedRuntime(instance) {
  const backend = fs.readFileSync(instance.backendLog).subarray(instance.offset).toString('utf8');
  const electron = instance.electronLog && fs.existsSync(instance.electronLog) ? fs.readFileSync(instance.electronLog, 'utf8') : '';
  const migrationLog = path.join(path.dirname(instance.backendLog), 'migration.log');
  const migration = fs.existsSync(migrationLog) ? fs.readFileSync(migrationLog, 'utf8') : '';
  const log = backend + '\n' + electron + '\n' + migration;
  const match = log.match(/career-runtime state=(\S+) mode=(\S+) feature=(\S+) featureSource=(\S+) scope=(\S+) scopeSource=(\S+) writeFamily=(\S+)/);
  assert(match, 'career-runtime line missing from this launch');
  return {
    state: match[1], mode: match[2], feature: match[3], featureSource: match[4],
    scope: match[5], scopeSource: match[6], writeFamily: match[7],
    activation: (log.match(/fresh-native activation: \S+/) || [null])[0],
  };
}

async function sceneResumeV1BlockedJobs(ctx) {
  const { m, page, instance, check } = ctx;
  await check('27-resume-v1-jobs-family-blocked-surfaces', async () => {
    const runtime = observedRuntime(instance);
    assert.equal(runtime.mode, 'AB_ENABLED');
    assert.equal(runtime.scope, 'resume_v1');
    assert.equal(runtime.scopeSource, 'explicit-env');
    assert.equal(runtime.writeFamily, 'ab');
    await page.goto(instance.origin + '/dashboard/myjobs', { waitUntil: 'load' });
    // The jobs list surfaces the typed unavailability as a load error — never
    // as a fabricated empty table; the runtime notice marks writes read-only.
    await expect(page.getByTestId('jobs-load-error')).toBeVisible();
    await expect(page.getByTestId('jobs-load-error')).toContainText(t('errors.careerJobsUnavailable'));
    await expect(page.getByRole('alert').filter({ hasText: t('career.jobsReadOnlyTitle') })).toBeVisible();
    await expect(page.getByTestId('job-row-number')).toHaveCount(0);
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    for (const rule of ['R3', 'R4', 'R5', 'R6']) {
      assert.equal(await page.locator('[data-testid^="next-action-' + rule + ':"]').count(), 0, 'Job-family suggestion ' + rule + ' surfaced while the family is blocked');
    }
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    const notices = page.getByTestId('jobs-unavailable-notice');
    assert(await notices.count() >= 1, 'Blocked analytics must show the unavailable notice');
    await expect(notices.first()).toBeVisible();
    await expect(page.getByTestId('board-total-applied').locator('p.text-2xl')).toHaveText('—');
    await expect(page.getByTestId('board-total-awaitingReflection')).toHaveCount(0);
    // Family-independent M7 must still be real data, never a fabricated 0.
    const openTasks = await ctx.db.task.count({ where: { userId: m.ids.primaryUser, status: { notIn: ['complete', 'cancelled'] } } });
    assert(openTasks > 0, 'Fixture has no open task, so M7 cannot prove a real value');
    await expect(page.getByTestId('board-total-openTasks').locator('p.text-2xl')).toHaveText(String(openTasks));
    return { runtime, myjobsBlocked: true, dashboardJobRulesSilent: true, analyticsUnavailableNotZero: true, openTasks };
  });
}

async function sceneReadyDisabledScopeNone(ctx) {
  const { m, page, instance, check } = ctx;
  await check('28-scope-none-ready-disabled-equivalence', async () => {
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0);
    await expect(page.getByTestId('next-action-R5:' + ctx.x.ids.upcomingStep)).toBeVisible();
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('board-total-applied')).toBeVisible();
    const runtime = observedRuntime(instance);
    assert.equal(runtime.mode, 'AB_READY_DISABLED');
    assert.equal(runtime.scope, 'none');
    assert.equal(runtime.scopeSource, 'explicit-env');
    assert.equal(runtime.writeFamily, 'blocked');
    return { runtime, r6Silent: true, r5Visible: true, readsAvailable: true };
  });
}

async function sceneBlocked(ctx) {
  const { page, instance, check } = ctx;
  await check('29-blocked-runtime-degrades-without-fabrication', async () => {
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    for (const rule of ['R3', 'R4', 'R5', 'R6']) {
      assert.equal(await page.locator('[data-testid^="next-action-' + rule + ':"]').count(), 0);
    }
    const runtime = observedRuntime(instance);
    assert.equal(runtime.mode, 'BLOCKED');
    assert.equal(runtime.writeFamily, 'blocked');
    assert.equal(runtime.state, 'FRESH_READY');
    await page.goto(instance.origin + '/dashboard/myjobs', { waitUntil: 'load' });
    await expect(page.getByRole('alert').filter({ hasText: t('career.runtimeBlockedTitle') })).toBeVisible();
    await expect(page.getByTestId('jobs-load-error')).toBeVisible();
    await expect(page.getByTestId('jobs-load-error')).toContainText(t('errors.careerJobsUnavailable'));
    await expect(page.getByTestId('job-row-number')).toHaveCount(0);
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    const notices = page.getByTestId('jobs-unavailable-notice');
    assert(await notices.count() >= 1, 'Blocked analytics must show the unavailable notice');
    await expect(notices.first()).toBeVisible();
    // Typed-blocked metrics render as "—" (unavailable), never a fabricated 0.
    await expect(page.getByTestId('board-total-applied').locator('p.text-2xl')).toHaveText('—');
    await expect(page.getByTestId('board-total-openTasks').locator('p.text-2xl')).not.toHaveText('—');
    await expect(page.getByTestId('board-total-awaitingReflection')).toHaveCount(0);
    return { runtime, dashboardUsable: true, jobRulesSilent: true, blockedNotice: true, noFabricatedZero: true };
  });
}

async function sceneRuleFailure(ctx) {
  const { m, page, instance, check } = ctx;
  await check('30-injected-r6-read-failure-silent-degradation', async () => {
    // Injection (done while stopped): ApplicationInterviewDetail renamed.
    // Contract: the rule emits nothing; other homepage blocks stay usable;
    // no fabricated 'nothing to debrief', no writes, no AI calls.
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0);
    await expect(page.getByTestId('next-action-R5:' + ctx.x.ids.upcomingStep)).toBeVisible();
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    // M9 must be ABSENT (unavailable/null), never rendered as numeric 0.
    await expect(page.getByTestId('board-total-awaitingReflection')).toHaveCount(0);
    const applied = page.getByTestId('board-total-applied');
    await expect(applied).toBeVisible();
    await expect(applied.locator('p.text-2xl')).toHaveText('1');
    return { runtime: observedRuntime(instance), r6Silent: true, homepageUsable: true, m9AbsentNotZero: true, appliedStillReal: '1' };
  });
  await check('31-real-page-error-path-and-navigation-recovery', async () => {
    // AID is already renamed. The timeline client read includes that relation.
    // The first paint is only the tab placeholder ("Loading..."); wait until
    // the server action settles before judging the surface.
    const timeline = page.getByTestId('application-timeline');
    const toast = page.locator('[data-sonner-toast]');
    const posts = [];
    const onResponse = (response) => {
      const request = response.request();
      if (request.method() !== 'POST') return;
      posts.push({
        url: response.url(),
        status: response.status(),
        nextAction: Boolean(request.headers()['next-action']),
      });
    };
    page.on('response', onResponse);
    let response;
    let timelineSurface = 'pending';
    try {
      response = await page.goto(instance.origin + '/dashboard/myjobs/' + m.ids.job + '?tab=timeline', { waitUntil: 'load' });
      try {
        await expect.poll(async () => {
          if (await timeline.isVisible().catch(() => false)) return 'timeline';
          const toastText = (await toast.allInnerTexts().catch(() => [])).join(' ');
          if (/does not exist|Failed to load|P2021|ApplicationInterviewDetail|exception|Server Error/i.test(toastText)) return 'toast';
          const text = await page.locator('body').innerText();
          if (/Application error|server-side exception|Internal Server Error|digest/i.test(text)) return 'error-page';
          return 'pending';
        }, { timeout: 20000 }).not.toBe('pending');
      } catch (error) {
        const faultText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800);
        assert.fail('Timeline read did not settle within 20s: ' + faultText + ' posts=' + JSON.stringify(posts.slice(-6)) + ' cause=' + error.message);
      }
      if (await timeline.isVisible().catch(() => false)) timelineSurface = 'timeline';
      else if ((await toast.count()) > 0) timelineSurface = 'toast';
      else timelineSurface = 'error-page';
    } finally {
      page.off('response', onResponse);
    }
    const toastText = (await toast.allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ').slice(0, 500);
    const timelineFaultText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800);
    assert(timelineSurface !== 'timeline', 'Faulted timeline still rendered: ' + timelineFaultText);
    assert(posts.some(post => post.nextAction), 'Renamed ApplicationInterviewDetail did not produce a server action from the timeline page: ' + JSON.stringify(posts.slice(-6)));
    assert(/does not exist|Failed to load|P2021|ApplicationInterviewDetail|exception|Server Error|Application error|server-side exception|digest/i.test(toastText + ' ' + timelineFaultText), 'No recognizable timeline failure after the action settled: toast=' + toastText + ' page=' + timelineFaultText);

    // V8: a non-blocked read exception must throw out of the analytics page.
    // Renaming a domain table that fresh-native integrity counts
    // (JobOpportunity) fails closed into BLOCKED ("—"), which is not this
    // path. Task is outside that integrity set and is read uncaught by
    // loadDueTaskFollowUps. Rename it only for this navigation, then put it
    // back before the homepage recovery check.
    await ctx.db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await ctx.db.$executeRawUnsafe('ALTER TABLE "Task" RENAME TO "_p2_injected_Task"');
    let analyticsFaultText = '';
    try {
      const analyticsResponse = await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
      await expect.poll(async () => {
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        if (/Application error|server-side exception|Internal Server Error|digest/i.test(text)) return 'error-page';
        if (await page.getByTestId('board-total-applied').count()) return 'board';
        return 'pending';
      }, { timeout: 20000 }).not.toBe('pending');
      analyticsFaultText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800);
      assert.equal(await page.getByTestId('board-total-applied').count(), 0, 'Faulted analytics still rendered board totals: ' + analyticsFaultText);
      assert(/Application error|server-side exception|Internal Server Error|digest/i.test(analyticsFaultText), 'Analytics read failure did not reach a page error boundary: ' + analyticsFaultText);
      assert(analyticsResponse === null || analyticsResponse.status() >= 400 || /Application error|server-side exception|digest/i.test(analyticsFaultText), 'Analytics navigation did not fail closed');
    } finally {
      await ctx.db.$executeRawUnsafe('ALTER TABLE "_p2_injected_Task" RENAME TO "Task"');
      const restored = await ctx.db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='Task'");
      assert.equal(restored.length, 1, 'Task rename was not reverted');
    }
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    return {
      targetStatus: response ? response.status() : null,
      timelineSurface,
      timelineToast: toastText,
      timelineFaultText,
      timelinePosts: posts.slice(-6),
      analyticsFaultText,
      errorBoundary: true,
      recoveryNavigationUsable: true,
    };
  });
}

async function sceneRecovery(ctx) {
  const { m, page, instance, check } = ctx;
  await check('32-revert-fault-fresh-read-restores-state', async () => {
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0, 'R6 already completed; it must not return after recovery');
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    const awaiting = page.getByTestId('board-total-awaitingReflection');
    await expect(awaiting).toBeVisible();
    await expect(awaiting.locator('p.text-2xl')).toHaveText('0');
    await page.goto(instance.origin + '/dashboard/myjobs/' + m.ids.job + '?tab=timeline', { waitUntil: 'load' });
    await expect(page.getByTestId('application-timeline')).toBeVisible();
    return { runtime: observedRuntime(instance), recoveredFreshRead: true, m9TrueZero: '0', timelineReadable: true };
  });
}

// ---------- second data root: real backup import ----------

const ZIP_FIELD = 'file';

export async function runBackupRestore({ appRoot, runRoot, logDirectory, electronExe, zipPath, launchNumber, resumeOnly = false }) {
  const dataRootB = path.join(runRoot, 'data-root-restore');
  const dbPathB = path.join(dataRootB, 'data', 'vocatrya.db');
  const instance = startDesktopVariant({ appRoot, dataRoot: dataRootB, logDirectory, electronExe, launchNumber });
  const evidence = evidenceDirectory(runRoot, 'backup-restore');
  try {
    const runtime = await connectDesktopExpect(instance, { authenticated: resumeOnly, expected: { state: 'FRESH_READY', mode: 'AB_ENABLED', scope: 'full' } });
    const page = instance.page;
    const origin = instance.origin;
    const identity = { name: 'P2 Restore User', email: 'p2-restore@example.test', password: 'P2restoreSynthetic1!' };
    let restored = null;
    if (!resumeOnly) {
    restored = await step(evidence, '33-second-root-signup-and-real-import', async () => {
      await page.context().addCookies([{ name: 'vocatrya_locale', value: 'en', url: origin }]);
      await page.context().addInitScript(() => localStorage.setItem('vocatrya-locale-preference', 'en'));
      await page.goto(origin + '/signup', { waitUntil: 'load' });
      await page.getByPlaceholder('Full Name', { exact: true }).fill(identity.name);
      await page.getByPlaceholder('id@example.com', { exact: true }).fill(identity.email);
      await page.getByLabel('Password', { exact: true }).fill(identity.password);
      await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      await expect(page).toHaveURL(origin + '/dashboard');
      const response = await page.request.post(origin + '/api/backup/import', {
        multipart: { [ZIP_FIELD]: { name: 'backup.zip', mimeType: 'application/zip', buffer: fs.readFileSync(zipPath) }, confirmWipe: 'true' },
      });
      const payload = await response.json();
      assert.equal(response.status(), 200, 'Import rejected: ' + JSON.stringify(payload).slice(0, 400));
      return { runtime, importResult: payload };
    });
    } else {
      await expect(page).toHaveURL(origin + '/dashboard');
    }
    const dbB = await openDb({ db: dbPathB });
    let idsB;
    try {
      idsB = await step(evidence, '34-restored-relations-ownership-snapshots', async () => {
        const user = await dbB.user.findUniqueOrThrow({ where: { email: identity.email } });
        const jobs = await dbB.jobOpportunity.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' }, include: { applicationAttempts: { include: { submittedResumeVersion: { include: { resumeVariant: true } }, submittedResumeArtifact: true, submittedAgainstJdVersion: { include: { jobOpportunity: true } } } } } });
        const active = jobs.filter(job => !job.archivedAt);
        const archived = jobs.filter(job => job.archivedAt);
        assert.equal(active.length, 2, 'Restored root must contain both active positions');
        assert.equal(archived.length, 1, 'Archived position must restore as archived');
        const attempts = active.flatMap(job => job.applicationAttempts);
        assert.equal(attempts.filter(attempt => attempt.submittedAt).length, 2, 'Both submitted attempts must restore');
        for (const attempt of attempts) {
          assert(attempt.submittedResumeVersion?.resumeVariant?.userId === user.id, 'Submitted resume version not remapped to the restoring user');
          assert(attempt.submittedAgainstJdVersion?.jobOpportunity?.userId === user.id, 'Submitted JD version not remapped to the restoring user');
        }
        const variants = await dbB.resumeVariant.findMany({ where: { userId: user.id }, include: { versions: true } });
        assert(variants.some(variant => variant.targetJobOpportunityId === active[0].id || variant.targetJobOpportunityId === active[1].id), 'Planned-resume binding did not restore to a remapped job id');
        const detail = await dbB.applicationInterviewDetail.findFirst({ where: { processStep: { applicationAttempt: { userId: user.id } } } });
        assert(detail?.reflectionCompletedAt, 'R6 completion marker did not restore');
        const artifacts = await dbB.resumeArtifact.findMany({ where: { version: { resumeVariant: { userId: user.id } } } });
        assert(artifacts.length >= 2, 'Resume artifact metadata missing after restore');
        return { userId: user.id, jobs: jobs.map(job => job.id), attempts: attempts.map(attempt => attempt.id), variants: variants.map(variant => variant.id), artifacts: artifacts.map(artifact => artifact.id), detailId: detail.id };
      });
    } finally { await dbB.$disconnect(); }
    const ui = await step(evidence, '35-restored-ui-readable-missing-bytes-nodrift', async () => {
      const dbUi = await openDb({ db: dbPathB });
      try {
        const attemptJob = await dbUi.jobOpportunity.findFirstOrThrow({ where: { userId: idsB.userId, archivedAt: null, applicationAttempts: { some: { submittedAt: { not: null } } } } });
        await page.goto(origin + '/dashboard/myjobs/' + attemptJob.id + '?tab=timeline', { waitUntil: 'load' });
        await expect(page.getByTestId('application-timeline')).toBeVisible();
        await expect(page.getByTestId('job-connections-summary')).toBeVisible();
        const sections = await page.locator('[data-attempt-id]').count();
        assert.equal(sections, 2, 'Restored timeline must show both attempt sections');
        const facts = page.locator('[data-testid="submitted-material-facts"]');
        await expect(facts.first()).toBeVisible();
        // Contract: ResumeArtifact bytes are intentionally NOT in the backup.
        // The restored UI must still show the historical file name, and the
        // visible download link must return the typed missing-bytes error.
        const attemptsWithArtifact = await dbUi.applicationAttempt.findMany({ where: { jobOpportunityId: attemptJob.id, submittedResumeArtifactId: { not: null } }, include: { submittedResumeArtifact: true } });
        assert(attemptsWithArtifact.length >= 2, 'Both submitted artifacts must be visible on the restored job');
        const downloads = [];
        for (const attempt of attemptsWithArtifact) {
          await expect(facts.filter({ hasText: attempt.submittedResumeArtifact.fileName }).first()).toBeVisible();
          const link = facts.filter({ hasText: attempt.submittedResumeArtifact.fileName }).first().getByTestId('download-submitted-artifact');
          const href = await link.getAttribute('href');
          const fetched = await page.evaluate(async (url) => {
            const response = await fetch(url, { credentials: 'same-origin' });
            const body = await response.json();
            return { status: response.status, body };
          }, href);
          assert.equal(fetched.status, 404, 'Restored artifact download status for ' + attempt.submittedResumeArtifact.fileName);
          assert.equal(fetched.body.code, 'ARTIFACT_BYTES_MISSING');
          downloads.push({ fileName: attempt.submittedResumeArtifact.fileName, status: fetched.status, code: fetched.body.code });
        }
        // Editing the restored current resume must not drift submitted facts.
        const factSelect = { submittedResumeVersionId: true, submittedResumeArtifactId: true, submittedAgainstJdVersionId: true };
        const before = JSON.stringify(await dbUi.applicationAttempt.findMany({ where: { jobOpportunityId: attemptJob.id }, select: factSelect }));
        const variant = await dbUi.resumeVariant.findFirstOrThrow({ where: { userId: idsB.userId, versions: { some: {} } }, include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } } });
        await page.goto(origin + '/dashboard/profile/resumes/' + variant.id + '?version=' + variant.versions[0].id, { waitUntil: 'load' });
        const name = page.getByLabel(t('resumeVariants.fieldFullName'), { exact: true });
        await expect(name).toBeEnabled();
        await name.fill('Restored-root current edit');
        await name.locator('xpath=../..').getByRole('button', { name: t('common.save'), exact: true }).click();
        await expect.poll(async () => JSON.stringify(await dbUi.resumeVariantVersion.findUniqueOrThrow({ where: { id: variant.versions[0].id }, select: { headerSnapshot: true } }))).toContain('Restored-root current edit');
        assert.equal(JSON.stringify(await dbUi.applicationAttempt.findMany({ where: { jobOpportunityId: attemptJob.id }, select: factSelect })), before, 'Editing the current draft rewrote submitted facts on the restored root');
        return { jobId: attemptJob.id, attemptSections: sections, downloads, missingBytesCode: 'ARTIFACT_BYTES_MISSING', submittedFactsStable: true };
      } finally { await dbUi.$disconnect(); }
    });
    return { restored, idsB, ui };
  } finally {
    await stopDesktop(instance, { requireGraceful: true });
    json(path.join(runRoot, 'p2-restore-root-graceful-quit.json'), { observedExit: 0, pid: instance.child.pid, at: new Date().toISOString() });
  }
}

// ---------- injections (app stopped, owned fixture DB only) ----------

const BLOCKED_SCOPE = 'p2-injected-blocked';
export async function injectBlockedState(m) {
  const db = await openDb(m);
  try {
    await db.$executeRawUnsafe(`INSERT INTO "AbMigrationState" (id, scopeKey, migrationKey, status, createdAt, updatedAt) VALUES ('p2-injected-blocked-row', '${BLOCKED_SCOPE}', 'p2-injection', 'COMPLETED', datetime('now'), datetime('now'))`);
  } finally { await db.$disconnect(); }
}
export async function revertBlockedState(m) {
  const db = await openDb(m);
  try {
    await db.$executeRawUnsafe(`DELETE FROM "AbMigrationState" WHERE scopeKey = '${BLOCKED_SCOPE}'`);
  } finally { await db.$disconnect(); }
}
const RENAMED_TABLE = 'ApplicationInterviewDetail';
const RENAMED_TO = '_p2_injected_AID';
export async function injectReadFailure(m) {
  const db = await openDb(m);
  try {
    await db.$executeRawUnsafe(`ALTER TABLE "${RENAMED_TABLE}" RENAME TO "${RENAMED_TO}"`);
  } finally { await db.$disconnect(); }
}
export async function revertReadFailure(m) {
  const db = await openDb(m);
  try {
    await db.$executeRawUnsafe(`ALTER TABLE "${RENAMED_TO}" RENAME TO "${RENAMED_TABLE}"`);
  } finally { await db.$disconnect(); }
}

export async function runModeMatrix({ appRoot, runRoot, logDirectory, electronExe, input, observationLog, tickActionHash, start = 'readyDisabled', labelSuffix = '', skipRecovery = false }) {
  const out = {};
  const opts = { appRoot, logDirectory, electronExe, input, observationLog, tickActionHash, runRoot };
  const { manifest: m } = fixtures(input);
  const label = name => name + labelSuffix;
  if (start !== 'readyDisabled') assert(labelSuffix.length > 0, 'A continued matrix needs a distinct evidence label');
  if (start === 'readyDisabled') {
    out.readyDisabledFeatureOff = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: 3, env: { VOCATRYA_AB_RUNTIME_ENABLED: 'false' }, expected: { state: 'FRESH_READY', mode: 'AB_READY_DISABLED', scope: 'full' }, scenes: { readyDisabled: sceneReadyDisabled }, label: label('ready-disabled') });
  }
  if (start !== 'ruleFailure') {
    out.resumeV1 = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: start === 'readyDisabled' ? 4 : 40, env: { VOCATRYA_AB_ROLLOUT_SCOPE: 'resume_v1' }, expected: { state: 'FRESH_READY', mode: 'AB_ENABLED', scope: 'resume_v1' }, scenes: { resumeV1: sceneResumeV1BlockedJobs }, label: label('resume-v1') });
    out.scopeNone = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: start === 'readyDisabled' ? 5 : 41, env: { VOCATRYA_AB_ROLLOUT_SCOPE: 'none' }, expected: { state: 'FRESH_READY', mode: 'AB_READY_DISABLED', scope: 'none' }, scenes: { scopeNone: sceneReadyDisabledScopeNone }, label: label('scope-none') });
    await injectBlockedState(m);
    try {
      out.blocked = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: start === 'readyDisabled' ? 6 : 42, expected: { state: 'FRESH_READY', mode: 'BLOCKED', scope: 'full' }, scenes: { blocked: sceneBlocked }, label: label('blocked') });
    } finally {
      await revertBlockedState(m);
    }
  }
  await injectReadFailure(m);
  let ruleError = null;
  try {
    out.ruleFailure = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: start === 'readyDisabled' ? 7 : 43, expected: { state: 'FRESH_READY', mode: 'AB_ENABLED', scope: 'full' }, scenes: { ruleFailure: sceneRuleFailure }, label: label('rule-failure') });
  } catch (error) {
    ruleError = error;
  } finally {
    await revertReadFailure(m);
  }
  if (!skipRecovery) {
  try {
    out.recovery = await launchCycle({ ...opts, dataRoot: m.dataRoot, launchNumber: start === 'readyDisabled' ? 8 : 44, expected: { state: 'FRESH_READY', mode: 'AB_ENABLED', scope: 'full' }, scenes: { recovery: sceneRecovery }, label: label('recovery') });
  } catch (error) {
    if (ruleError) throw new Error(String(ruleError.stack || ruleError) + '\n--- recovery ---\n' + String(error.stack || error));
    throw error;
  }
  }
  if (ruleError) throw ruleError;
  return out;
}

function migrationEnvironment(dbPath) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.DATABASE_URL = 'file:' + dbPath.replaceAll('\\', '/');
  return env;
}

async function checkpointAndCopy(dbPath, destination) {
  const db = await openDb({ db: dbPath });
  try {
    await db.$queryRawUnsafe('PRAGMA wal_checkpoint(FULL)');
  } finally {
    await db.$disconnect();
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(dbPath, destination);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix) && fs.statSync(dbPath + suffix).size > 0) fs.copyFileSync(dbPath + suffix, destination + suffix);
  }
}

export async function prepareLegacyFixture({ schemaRoot, evidence }) {
  const stamp = randomUUID();
  const base = path.join(os.tmpdir(), 'vocatrya-p2-legacy-' + stamp);
  const dataRoot = path.join(base, 'data-root');
  const dbPath = path.join(dataRoot, 'data', 'vocatrya.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const schema = path.join(schemaRoot, 'prisma', 'schema.prisma');
  assert(fs.existsSync(schema), 'Owned schema snapshot missing');
  const migrate = execFileSync(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema], {
    cwd: schemaRoot, env: migrationEnvironment(dbPath), encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(evidence, 'legacy-migrate.stdout.txt'), migrate);
  const bcrypt = (await import('bcryptjs')).default;
  const password = await bcrypt.hash('P2-Isolated-Only-2026!', 10);
  const db = await openDb({ db: dbPath });
  const ids = {};
  try {
    await db.$transaction(async tx => {
      for (const [value, label] of [['draft', 'Draft'], ['interview', 'Interview']]) {
        await tx.jobStatus.upsert({ where: { value }, create: { value, label }, update: {} });
      }
      const user = await tx.user.create({ data: { name: 'P2 legacy synthetic', email: 'p2-legacy@example.test', password } });
      ids.userId = user.id;
      await tx.userSettings.create({ data: { userId: user.id, settings: JSON.stringify({ settings: { general: { timeZone: 'Asia/Shanghai', locale: 'en' } } }) } });
      const company = await tx.company.create({ data: { label: 'P2 Legacy Company', value: 'p2-legacy-company', createdBy: user.id } });
      const title = await tx.jobTitle.create({ data: { label: 'P2 legacy role', value: 'p2-legacy-role', createdBy: user.id } });
      const draft = await tx.jobStatus.findUniqueOrThrow({ where: { value: 'draft' } });
      const interview = await tx.jobStatus.findUniqueOrThrow({ where: { value: 'interview' } });
      const applied = await tx.job.create({ data: { userId: user.id, description: 'P2 legacy applied position', jobType: 'Full-time', createdAt: new Date('2026-11-01T00:00:00Z'), applied: true, appliedDate: new Date('2026-11-02T00:00:00Z'), statusId: interview.id, jobTitleId: title.id, companyId: company.id } });
      const unapplied = await tx.job.create({ data: { userId: user.id, description: 'P2 legacy unapplied position', jobType: 'Full-time', createdAt: new Date('2026-11-03T00:00:00Z'), applied: false, statusId: draft.id, jobTitleId: title.id, companyId: company.id } });
      const profile = await tx.profile.create({ data: { userId: user.id } });
      const resume = await tx.resume.create({ data: { profileId: profile.id, title: 'P2 legacy resume' } });
      const task = await tx.task.create({ data: { userId: user.id, title: 'P2 legacy open task', status: 'in-progress' } });
      Object.assign(ids, { appliedJobId: applied.id, unappliedJobId: unapplied.id, resumeId: resume.id, taskId: task.id });
      assert.equal(await tx.jobOpportunity.count(), 0);
      assert.equal(await tx.abMigrationState.count(), 0);
    });
  } finally {
    await db.$disconnect();
  }
  return {
    base, dataRoot, dbPath,
    manifest: { credentials: { primaryEmail: 'p2-legacy@example.test', syntheticPassword: 'P2-Isolated-Only-2026!' }, ids: { primaryUser: ids.userId } },
    ids,
  };
}

async function sceneLegacy(ctx) {
  const { page, instance, check } = ctx;
  await check('36-legacy-only-next-actions-and-insights', async () => {
    const runtime = observedRuntime(instance);
    assert.equal(runtime.state, 'NOT_STARTED');
    assert.equal(runtime.mode, 'LEGACY_ONLY');
    assert.equal(runtime.scope, 'full');
    assert.equal(runtime.scopeSource, 'explicit-env');
    assert.equal(runtime.feature, 'enabled');
    assert.equal(runtime.featureSource, 'explicit-env');
    assert.equal(runtime.writeFamily, 'legacy');
    assert.equal(runtime.activation, 'fresh-native activation: skipped-not-eligible');
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    for (const rule of ['R5', 'R6']) {
      assert.equal(await page.locator('[data-testid^="next-action-' + rule + ':"]').count(), 0, rule + ' must stay silent on legacy jobs');
    }
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const interviews = page.getByTestId('board-total-interviews');
    await expect(interviews).toContainText(t('dashboard.statInterviewingPositions'));
    await expect(interviews.locator('p.text-2xl')).toHaveText('1');
    await expect(page.getByTestId('board-total-interviewScheduled')).toHaveCount(0);
    await expect(page.getByTestId('board-total-applied').locator('p.text-2xl')).toHaveText('1');
    await expect(page.getByTestId('board-total-offers').locator('p.text-2xl')).toHaveText('0');
    await expect(page.getByTestId('board-total-openTasks').locator('p.text-2xl')).toHaveText('1');
    await expect(page.getByTestId('board-total-awaitingReflection')).toHaveCount(0);
    await expect(page.getByTestId('jobs-unavailable-notice')).toHaveCount(0);
    return { runtime, legacyInterviewUnit: 'positions', m9Absent: true, realOfferZero: '0' };
  });
}

async function sceneMigrated(ctx) {
  const { page, instance, check } = ctx;
  await check('37-migrated-full-rounds-and-m9-zero', async () => {
    const runtime = observedRuntime(instance);
    assert.equal(runtime.state, 'COMPLETED');
    assert.equal(runtime.mode, 'AB_ENABLED');
    assert.equal(runtime.scope, 'full');
    assert.equal(runtime.scopeSource, 'explicit-env');
    assert.equal(runtime.writeFamily, 'ab');
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    assert.equal(await page.locator('[data-testid^="next-action-R6:"]').count(), 0, 'EVIDENCED migration steps must not become R6');
    assert.equal(await page.locator('[data-testid^="next-action-R5:"]').count(), 0, 'Migration must not invent an upcoming interview');
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    const rounds = page.getByTestId('board-total-interviews');
    await expect(rounds).toContainText(t('dashboard.statInterviewRoundsDone'));
    await expect(rounds.locator('p.text-2xl')).toHaveText('0');
    await expect(page.getByTestId('board-total-interviewScheduled')).toBeVisible();
    const awaiting = page.getByTestId('board-total-awaitingReflection');
    await expect(awaiting).toBeVisible();
    await expect(awaiting.locator('p.text-2xl')).toHaveText('0');
    await expect(page.getByTestId('board-insights-footnotes')).toContainText(t('dashboard.insightsMigratedRounds'));
    await expect(page.getByTestId('jobs-unavailable-notice')).toHaveCount(0);
    return { runtime, completedRounds: '0', m9TrueZero: '0', migratedFootnote: true };
  });
}

export async function runLegacyCoverage({ appRoot, evidenceRun, runRoot, schemaRoot, logDirectory, electronExe, skipLegacyUi = false }) {
  const evidence = evidenceDirectory(evidenceRun, 'legacy-family');
  const prepared = await step(evidence, '36-prepare-legacy-fixture', async () => prepareLegacyFixture({ schemaRoot, evidence }), 'NON_DESKTOP');
  if (!skipLegacyUi) {
  const legacy = startDesktopVariant({ appRoot, dataRoot: prepared.dataRoot, logDirectory, electronExe, launchNumber: 50 });
  try {
    await connectDesktopExpect(legacy, { authenticated: false, expected: { state: 'NOT_STARTED', mode: 'LEGACY_ONLY', scope: 'full' } });
    await login(legacy, prepared.manifest);
    const ctx = { page: legacy.page, instance: legacy, check: async (name, action) => step(evidence, name, async () => {
      const result = await action();
      await legacy.page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true });
      return { result, screenshot: name + '.png', url: legacy.page.url() };
    }, 'WINDOWS_ELECTRON') };
    await sceneLegacy(ctx);
  } finally {
    await stopDesktop(legacy, { requireGraceful: true });
    json(path.join(runRoot, 'p2-legacy-only-graceful-quit.json'), { observedExit: 0, pid: legacy.child.pid, at: new Date().toISOString() });
  }
  }
  const migratedDb = path.join(os.tmpdir(), 'vocatrya-p2-migrated-' + randomUUID(), 'data-root', 'data', 'vocatrya.db');
  await checkpointAndCopy(prepared.dbPath, migratedDb);
  const phase3Dir = path.join(path.dirname(path.dirname(path.dirname(migratedDb))), 'phase3');
  const { executeLegacyMigrationCommand } = await import(pathToFileURL(path.join(ROOT, 'src/lib/legacy-migration/command.ts')).href);
  // DATABASE_URL must not point at this copy. The writable gate treats
  // DATABASE_URL as configured_production and would refuse the disposable file.
  const migrationEnv = migrationEnvironment(migratedDb);
  delete migrationEnv.DATABASE_URL;
  const migration = await executeLegacyMigrationCommand({
    argv: ['migrate', '--db', migratedDb, '--confirm-writable', '--allow-disposable-copy', '--output', phase3Dir],
    repoRoot: ROOT,
    env: migrationEnv,
  });
  fs.writeFileSync(path.join(evidence, 'phase3.stdout.txt'), migration.stdout + '\n' + JSON.stringify(migration.report?.preflight ?? null, null, 2));
  const reportFile = path.join(phase3Dir, 'phase3-report.json');
  if (fs.existsSync(reportFile)) fs.copyFileSync(reportFile, path.join(evidence, 'phase3-report.json'));
  assert.equal(migration.exitCode, 0, 'Real legacy migrator did not pass: ' + migration.stdout + '\n' + JSON.stringify(migration.report?.preflight ?? null));
  assert.equal(migration.report?.phaseResult, 'PASS');
  const migratedRoot = path.dirname(path.dirname(migratedDb));
  const migrated = startDesktopVariant({ appRoot, dataRoot: migratedRoot, logDirectory, electronExe, launchNumber: 51 });
  try {
    await connectDesktopExpect(migrated, { authenticated: false, expected: { state: 'COMPLETED', mode: 'AB_ENABLED', scope: 'full' } });
    await login(migrated, prepared.manifest);
    const ctx = { page: migrated.page, instance: migrated, check: async (name, action) => step(evidence, name, async () => {
      const result = await action();
      await migrated.page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true });
      return { result, screenshot: name + '.png', url: migrated.page.url() };
    }, 'WINDOWS_ELECTRON') };
    await sceneMigrated(ctx);
  } finally {
    await stopDesktop(migrated, { requireGraceful: true });
    json(path.join(runRoot, 'p2-migrated-full-graceful-quit.json'), { observedExit: 0, pid: migrated.child.pid, at: new Date().toISOString() });
  }
  return { legacyDb: prepared.dbPath, migratedDb, migrationStdout: migration.stdout };
}
