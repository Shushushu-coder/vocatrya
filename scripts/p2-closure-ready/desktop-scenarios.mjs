import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { loadManifest, openDb, evidenceDirectory, step, json, hash, ROOT } from './package.mjs';
import { runR6 } from './ui-r6.mjs';
import { withDeadline } from '../../desktop/e2e/harness.mjs';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/messages/en.json'), 'utf8'));
export function t(key, values = {}) {
  const text = key.split('.').reduce((current, part) => current?.[part], messages);
  assert.equal(typeof text, 'string', 'Missing English key ' + key);
  return text.replace(/\{(\w+)\}/g, (match, name) => name in values ? String(values[name]) : match);
}
export function fixtures(input) {
  const manifest = loadManifest(input);
  const extra = JSON.parse(fs.readFileSync(path.join(manifest.run, 'desktop-fixtures.json'), 'utf8'));
  assert.equal(extra.ownerToken, manifest.ownerToken);
  assert.equal(extra.task, 'p2-closure-ready');
  return { manifest, extra };
}
export async function prepareDesktop(input) {
  const m = loadManifest(input);
  assert(!fs.existsSync(path.join(m.run, 'desktop-fixtures.json')), 'Desktop fixtures already exist; do not prepare twice');
  fs.writeFileSync(path.join(m.run, 'desktop-prepare-claim.json'), JSON.stringify({ ownerToken: m.ownerToken, at: new Date().toISOString() }), { flag: 'wx' });
  const evidence = evidenceDirectory(m.run, 'desktop-prepare');
  const db = await openDb(m);
  const extra = { task: 'p2-closure-ready', ownerToken: m.ownerToken, createdAt: new Date().toISOString(), ids: {}, labels: { unapplied: 'P2 unapplied filter sentinel', upcoming: 'P2 upcoming screening sentinel' }, desktop: 'NOT_RUN' };
  try {
    await step(evidence, '01-pristine-and-expansion', async () => {
      const detail = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
      assert.equal(detail.reflectionCompletedAt, null);
      assert.equal(detail.reflectionText, null);
      const company = await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job }, select: { companyId: true } });
      const alternate = await db.resumeVariant.findUniqueOrThrow({ where: { id: m.ids.alternateVariant }, include: { versions: { orderBy: { versionNumber: 'asc' } } } });
      assert.equal(alternate.targetJobOpportunityId, null);
      await db.$transaction(async tx => {
        const sentinel = await tx.jobOpportunity.create({ data: { userId: m.ids.primaryUser, companyId: company.companyId, title: extra.labels.unapplied, status: 'ACTIVE', createdVia: 'USER' } });
        extra.ids.unappliedJob = sentinel.id;
        await tx.resumeVariant.update({ where: { id: m.ids.alternateVariant }, data: { targetJobOpportunityId: sentinel.id } });
        const scheduledAt = new Date(Date.now() + 2 * 86400000);
        scheduledAt.setUTCSeconds(0, 0);
        const upcoming = await tx.applicationProcessStep.create({ data: { applicationAttemptId: m.ids.attempts[0], category: 'SCREENING', label: extra.labels.upcoming, status: 'PENDING', source: 'USER', sortOrder: 20, scheduledAt, scheduledAtPrecision: 'minute', scheduledAtZone: m.accountTimeZone } });
        extra.ids.upcomingStep = upcoming.id;
        extra.upcomingScheduledAt = scheduledAt.toISOString();
        const foreignAttempt = await tx.applicationAttempt.findFirstOrThrow({ where: { jobOpportunityId: m.ids.foreignJob } });
        const foreignUpcoming = await tx.applicationProcessStep.create({ data: { applicationAttemptId: foreignAttempt.id, category: 'SCREENING', label: 'P2 foreign upcoming sentinel', status: 'PENDING', source: 'USER', sortOrder: 20, scheduledAt, scheduledAtPrecision: 'minute', scheduledAtZone: 'Pacific/Auckland' } });
        extra.ids.foreignUpcomingStep = foreignUpcoming.id;
        const missingId = randomUUID();
        const missing = await tx.resumeArtifact.create({ data: { id: missingId, resumeVariantVersionId: alternate.versions[0].id, kind: 'EXPORT', format: 'PDF', storageKey: 'resume-artifacts/' + missingId + '/missing.pdf', fileName: 'missing.pdf', sha256: '0'.repeat(64), byteSize: 0 } });
        extra.ids.missingArtifact = missing.id;
        const settings = await tx.userSettings.findUniqueOrThrow({ where: { userId: m.ids.primaryUser } });
        const document = JSON.parse(settings.settings);
        document.general = { ...document.general, locale: 'en' };
        await tx.userSettings.update({ where: { userId: m.ids.primaryUser }, data: { settings: JSON.stringify(document) } });
      });
      return extra;
    });
    await step(evidence, '02-sql-write-observer', async () => {
      await db.$executeRawUnsafe('CREATE TABLE "_p2_write_audit" (seq INTEGER PRIMARY KEY AUTOINCREMENT, tableName TEXT NOT NULL, operation TEXT NOT NULL, rowId TEXT)');
      const rows = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_p2_%' AND name != '_prisma_migrations' ORDER BY name");
      extra.observedTables = rows.map(row => row.name);
      assert(extra.observedTables.includes('Reminder'));
      assert(extra.observedTables.includes('ApplicationAttempt'));
      for (const [index, row] of rows.entries()) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          const alias = operation === 'DELETE' ? 'OLD' : 'NEW';
          const name = '_p2_audit_' + index + '_' + operation;
          await db.$executeRawUnsafe('CREATE TRIGGER ' + quote(name) + ' AFTER ' + operation + ' ON ' + quote(row.name) + ' BEGIN INSERT INTO "_p2_write_audit" (tableName,operation,rowId) VALUES (' + literal(row.name) + ',' + literal(operation) + ',CAST(' + alias + '.rowid AS TEXT)); END');
        }
      }
      return { tables: extra.observedTables, triggerCount: rows.length * 3, scope: 'Only the owned synthetic database; all product tables observed, not just net row counts' };
    });
    await step(evidence, '03-expanded-invariants', async () => {
      assert.equal(await db.jobOpportunity.count({ where: { userId: m.ids.primaryUser, archivedAt: null } }), 2);
      assert.equal(await db.applicationAttempt.count({ where: { userId: m.ids.primaryUser, archivedAt: null, jobOpportunity: { archivedAt: null } } }), 2);
      const target = await db.applicationProcessStep.findUniqueOrThrow({ where: { id: extra.ids.upcomingStep } });
      assert.equal(target.category, 'SCREENING');
      assert.equal(target.status, 'PENDING');
      assert(target.scheduledAt > new Date());
      return { activePositions: 2, activeAttempts: 2, upcoming: target };
    });
    json(path.join(m.run, 'desktop-fixtures.json'), extra);
    console.log('DESKTOP_FIXTURES_PREPARED ' + m.run);
  } finally { await db.$disconnect(); }
}

export async function login(instance, m) {
  const { page, origin } = instance;
  await page.context().addCookies([{ name: 'vocatrya_locale', value: 'en', url: origin }]);
  await page.goto(origin + '/signin', { waitUntil: 'load' });
  await page.locator('#email').fill(m.credentials.primaryEmail);
  await page.locator('#password').fill(m.credentials.syntheticPassword);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(origin + '/dashboard');
  await expect(page.getByTestId('journey-overview')).toBeVisible();
  const response = await page.request.get(origin + '/api/auth/session');
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).user?.id, m.ids.primaryUser);
}

export async function createContext(instance, input, observationLog, tickActionHash) {
  const { manifest: m, extra: x } = fixtures(input);
  const db = await openDb(m);
  const evidence = evidenceDirectory(m.run, 'desktop-scenarios');
  const page = instance.page;
  async function check(name, action) {
    return step(evidence, name, async () => {
      try {
        const result = await action();
        await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true });
        return { result, screenshot: name + '.png', url: page.url() };
      } catch (error) {
        try { await page.screenshot({ path: path.join(evidence, name + '-failure.png'), fullPage: true }); } catch {}
        throw error;
      }
    }, 'WINDOWS_ELECTRON');
  }
  async function timeline(job = m.ids.job) {
    await page.goto(instance.origin + '/dashboard/myjobs/' + job + '?tab=timeline', { waitUntil: 'load' });
    await expect(page.getByTestId('application-timeline')).toBeVisible();
    await expect(page.getByTestId('job-connections-summary')).toBeVisible();
  }
  async function snapshots() {
    const rows = await db.applicationAttempt.findMany({ where: { id: { in: m.ids.attempts } }, orderBy: { id: 'asc' }, include: { submittedResumeVersion: true, submittedResumeArtifact: true, submittedAgainstJdVersion: true } });
    assert.equal(rows.length, 2);
    return rows.map(row => ({ id: row.id, submittedAt: row.submittedAt, versionId: row.submittedResumeVersionId, artifactId: row.submittedResumeArtifactId, jdId: row.submittedAgainstJdVersionId, version: row.submittedResumeVersion, artifact: row.submittedResumeArtifact, jd: row.submittedAgainstJdVersion }));
  }
  async function referencesUi() {
    await timeline();
    const result = [];
    for (let index = 0; index < m.ids.attempts.length; index++) {
      const section = page.locator('[data-attempt-id="' + m.ids.attempts[index] + '"]');
      await expect(section).toBeVisible();
      const version = section.getByTestId('view-submitted-resume-version');
      await expect(version).toHaveAttribute('href', '/dashboard/profile/resumes/' + m.ids.variant + '?version=' + m.versions[index].id);
      const artifact = m.artifacts.find(row => row.versionId === m.versions[index].id);
      await expect(section.getByTestId('download-submitted-artifact')).toHaveAttribute('href', '/api/profile/resume-artifacts/' + artifact.id);
      await expect(section.getByTestId('submitted-material-facts')).toContainText(artifact.fileName);
      await expect(section.getByTestId('submitted-material-facts')).toContainText(t('resumeVariants.versionNumber', { number: index + 1 }));
      result.push({ attempt: m.ids.attempts[index], versionHref: await version.getAttribute('href'), facts: await section.getByTestId('submitted-material-facts').innerText() });
    }
    return result;
  }
  async function analytics(archived = false) {
    await page.goto(instance.origin + '/dashboard/analytics', { waitUntil: 'load' });
    await expect(page.getByTestId('analytics-panel')).toBeVisible();
    const values = { total: archived ? 1 : 2, applied: archived ? 0 : 1, interviews: archived ? 0 : 2, interviewScheduled: 0, awaitingReflection: archived ? 0 : 1 };
    const result = {};
    for (const [key, value] of Object.entries(values)) {
      const card = page.getByTestId('board-total-' + key);
      await expect(card).toBeVisible();
      await expect(card.locator('p.text-2xl')).toHaveText(String(value));
      result[key] = await card.innerText();
    }
    await expect(page.getByTestId('board-total-applied')).toContainText(t('dashboard.appliedAttemptsLine', { count: archived ? 0 : 2 }));
    return result;
  }
  async function noWritesAndAi(name, route, ready) {
    return check(name, async () => {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      const offset = fs.statSync(observationLog).size;
      const mark = await db.$queryRawUnsafe('SELECT COALESCE(MAX(seq),0) AS value FROM "_p2_write_audit"');
      const sequence = Number(mark[0].value);
      const network = [];
      const onRequest = request => {
        const url = new URL(request.url());
        network.push({ method: request.method(), origin: url.origin, pathname: url.pathname, actionHash: request.headers()['next-action'] ? hash(request.headers()['next-action']) : null });
      };
      page.on('request', onRequest);
      try {
        await page.goto(instance.origin + route, { waitUntil: 'load' });
        await expect(page.getByTestId(ready)).toBeVisible();
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        const audit = await db.$queryRawUnsafe('SELECT seq,tableName,operation,rowId FROM "_p2_write_audit" WHERE seq > ? ORDER BY seq', sequence);
        const events = fs.readFileSync(observationLog).subarray(offset).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        json(path.join(evidence, name + '-observations.json'), { observedTables: x.observedTables, audit, rendererRequests: network, backendEvents: events, tickActionHash });
        const businessWrites = audit.filter(row => row.tableName !== 'Reminder');
        assert.equal(businessWrites.length, 0, 'Real product table write during read; see observations');
        const reminders = audit.filter(row => row.tableName === 'Reminder');
        if (reminders.length) assert(events.some(event => event.kind === 'incoming-finish' && event.actionHash === tickActionHash && event.status < 400), 'Reminder writes lack a successful observed tick request');
        assert.equal(events.filter(event => event.kind === 'child-process').length, 0, 'Backend spawned a child during read');
        const outbound = events.filter(event => ['fetch', 'undici', 'http-request', 'https-request', 'socket'].includes(event.kind));
        assert.equal(outbound.length, 0, 'Backend attempted an outbound request during read');
        assert.equal(network.filter(request => request.origin !== instance.origin).length, 0, 'Renderer attempted an external request');
        assert.equal(network.filter(request => /\/api\/(?:chat|ai|interview.*generate|.*reflection.*generate)(?:\/|$)/i.test(request.pathname)).length, 0, 'Renderer attempted an AI execution endpoint');
        return { businessWrites: 0, reminderWrites: reminders.length, backendOutboundAttempts: 0, backendChildInvocations: 0, rendererRequests: network.length, evidence: name + '-observations.json', scope: 'Bounded real page load through networkidle; POST alone is not classified as a business write; observer covers this backend process, not machine-wide activity' };
      } finally { page.off('request', onRequest); }
    });
  }
  return { instance, m, x, db, page, evidence, check, timeline, snapshots, referencesUi, analytics, noWritesAndAi };
}

export async function initialAndArchive(ctx) {
  const { m, x, db, page, instance, check, timeline, snapshots, referencesUi, analytics, noWritesAndAi } = ctx;
  await noWritesAndAi('01-home-read-observation', '/dashboard', 'journey-overview');
  await noWritesAndAi('02-analytics-read-observation', '/dashboard/analytics', 'analytics-panel');
  const before = await snapshots();
  await check('03-source-reconciled-board', async () => ({ cards: await analytics(false), immutableSubmissions: before, references: await referencesUi() }));
  await check('04-applied-drilldown-filters-real-rows', async () => {
    await analytics(false);
    await page.getByTestId('board-total-applied').getByRole('link').click();
    await expect(page).toHaveURL(instance.origin + '/dashboard/myjobs?applied=true');
    await expect(page.getByTestId('applied-filter-badge')).toBeVisible();
    await page.getByTestId('jobs-view-table-btn').click();
    await expect(page.locator('a[href="/dashboard/myjobs/' + m.ids.job + '"]')).toBeVisible();
    await expect(page.locator('a[href="/dashboard/myjobs/' + x.ids.unappliedJob + '"]')).toHaveCount(0);
    await expect(page.getByTestId('job-row-number')).toHaveCount(1);
    const filtered = await page.locator('table a[href^="/dashboard/myjobs/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    assert.deepEqual(filtered, ['/dashboard/myjobs/' + m.ids.job]);
    await page.getByTestId('applied-filter-badge').click();
    await expect(page.locator('a[href="/dashboard/myjobs/' + x.ids.unappliedJob + '"]')).toBeVisible();
    await expect(page.getByTestId('job-row-number')).toHaveCount(2);
    return { filtered, clearingFilterRevealsUnappliedSentinel: x.ids.unappliedJob };
  });
  await check('05-upcoming-drilldown-real-events', async () => {
    await analytics(false);
    await page.getByTestId('board-total-interviewScheduled').getByRole('link').click();
    await expect(page).toHaveURL(instance.origin + '/dashboard/myjobs?tab=upcoming');
    await expect(page.getByTestId('upcoming-list')).toBeVisible();
    await expect(page.getByTestId('upcoming-event')).toHaveCount(1);
    const event = page.getByTestId('upcoming-event');
    await expect(event).toContainText(x.labels.upcoming);
    await expect(event.getByRole('link')).toHaveAttribute('href', '/dashboard/myjobs/' + m.ids.job);
    await expect(event).not.toContainText('P2 foreign');
    return { observed: await event.innerText(), expectedProcessStep: x.ids.upcomingStep, note: 'Completed interviews are not Upcoming events; one SCREENING event is expected' };
  });
  await check('06-ui-archive-removes-r6-and-board-facts', async () => {
    await timeline();
    await page.getByTestId('job-details-delete-btn').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: t('jobs.archiveAction'), exact: true }).click();
    await expect.poll(async () => Boolean((await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job } })).archivedAt)).toBe(true);
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toHaveCount(0);
    const cards = await analytics(true);
    await timeline();
    await expect(page.getByTestId('job-archived-banner')).toBeVisible();
    const references = await referencesUi();
    assert.deepEqual(await snapshots(), before, 'Archive changed historical material facts');
    return { cards, references, archived: true };
  });
  await check('07-ui-restore-reinstates-r6-board-and-references', async () => {
    await page.goto(instance.origin + '/dashboard/settings?section=archive-data', { waitUntil: 'load' });
    await expect(page.getByTestId('archive-settings')).toBeVisible();
    const row = page.getByTestId('archived-job-row').filter({ has: page.locator('a[href="/dashboard/myjobs/' + m.ids.job + '"]') });
    await expect(row).toHaveCount(1);
    await row.getByTestId('archived-job-restore').click();
    await expect.poll(async () => (await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job } })).archivedAt).toBe(null);
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-action-R6:' + m.ids.r6Step)).toBeVisible();
    const cards = await analytics(false);
    assert.deepEqual(await snapshots(), before, 'Restore changed historical material facts');
    return { cards, references: await referencesUi(), restored: true };
  });
  return before;
}

export async function connections(ctx, before) {
  const { m, x, db, page, instance, evidence, check, timeline, snapshots, referencesUi } = ctx;
  async function target(variantId, jobId) {
    await page.goto(instance.origin + '/dashboard/profile/resumes/' + variantId, { waitUntil: 'load' });
    await expect(page.getByTestId('resume-version-switcher')).toBeVisible();
    const select = page.getByLabel(t('resumeBuilder.targetJob'), { exact: true });
    await expect(select).toBeEnabled();
    await select.selectOption(jobId || '');
    await expect.poll(async () => (await db.resumeVariant.findUniqueOrThrow({ where: { id: variantId } })).targetJobOpportunityId).toBe(jobId);
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel(t('resumeBuilder.targetJob'), { exact: true })).toHaveValue(jobId || '');
  }
  async function plan(expected) {
    await timeline();
    const links = page.getByTestId('planned-resume-variant').getByRole('link');
    await expect(links).toHaveCount(expected.length);
    const observed = await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).sort());
    assert.deepEqual(observed, expected.map(id => '/dashboard/profile/resumes/' + id).sort());
    return observed;
  }
  for (const [name, variant, job, expected] of [
    ['08-unbind-plan', m.ids.variant, null, []],
    ['09-bind-plan-other-job', m.ids.variant, x.ids.unappliedJob, []],
    ['10-rebind-plan-original-job', m.ids.variant, m.ids.job, [m.ids.variant]],
    ['11-bind-alternate-plan', m.ids.alternateVariant, m.ids.job, [m.ids.variant, m.ids.alternateVariant]],
    ['12-unbind-alternate-plan', m.ids.alternateVariant, null, [m.ids.variant]],
    ['13-restore-alternate-sentinel-plan', m.ids.alternateVariant, x.ids.unappliedJob, [m.ids.variant]]
  ]) {
    await check(name, async () => {
      await target(variant, job);
      const planned = await plan(expected);
      assert.deepEqual(await snapshots(), before, 'Plan change rewrote submitted facts');
      return { variant, targetJob: job, planned };
    });
  }
  const editedName = 'P2 current draft edited through UI';
  await check('14-edit-current-resume-without-history-drift', async () => {
    await page.goto(instance.origin + '/dashboard/profile/resumes/' + m.ids.variant + '?version=' + m.versions[2].id, { waitUntil: 'load' });
    const name = page.getByLabel(t('resumeVariants.fieldFullName'), { exact: true });
    await expect(name).toBeEnabled();
    await name.fill(editedName);
    await name.locator('xpath=../..').getByRole('button', { name: t('common.save'), exact: true }).click();
    await expect.poll(async () => JSON.parse((await db.resumeVariantVersion.findUniqueOrThrow({ where: { id: m.versions[2].id } })).headerSnapshot).fullName).toBe(editedName);
    assert.deepEqual(await snapshots(), before);
    return { currentVersion: m.versions[2].id, editedName, references: await referencesUi() };
  });
  await check('15-edit-current-jd-without-history-drift', async () => {
    await timeline();
    const prior = await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job } });
    await page.getByTestId('job-details-edit-btn').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('add-job-dialog-title')).toBeVisible();
    const editor = dialog.locator('[contenteditable="true"]');
    await expect(editor).toHaveCount(1);
    await editor.fill('P2 current JD changed through actual job edit UI: TypeScript and desktop data integrity.');
    await dialog.getByTestId('save-job-btn').click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job } })).currentJdVersionId).not.toBe(prior.currentJdVersionId);
    const current = await db.jobOpportunity.findUniqueOrThrow({ where: { id: m.ids.job }, include: { currentJdVersion: true } });
    assert(current.currentJdVersion.rawContent.includes('P2 current JD changed'));
    assert.deepEqual(await snapshots(), before);
    return { currentJd: current.currentJdVersion, references: await referencesUi() };
  });
  await check('16-open-both-historical-resume-versions', async () => {
    const observed = [];
    for (let index = 0; index < 2; index++) {
      await timeline();
      const section = page.locator('[data-attempt-id="' + m.ids.attempts[index] + '"]');
      await section.getByTestId('view-submitted-resume-version').click();
      const field = page.getByLabel(t('resumeVariants.fieldFullName'), { exact: true });
      const originalName = JSON.parse(m.versions[index].headerSnapshot).fullName;
      await expect(field).toHaveValue(originalName);
      await expect(field).toBeDisabled();
      observed.push({ attempt: m.ids.attempts[index], version: m.versions[index].id, observedName: await field.inputValue() });
    }
    return observed;
  });
  await check('17-download-both-artifacts-real-ui-and-http', async () => {
    const downloads = path.join(evidence, 'downloads');
    fs.mkdirSync(downloads);
    const cdp = await instance.browser.newBrowserCDPSession();
    const began = [];
    const completed = new Map();
    cdp.on('Browser.downloadWillBegin', event => began.push(event));
    cdp.on('Browser.downloadProgress', event => completed.set(event.guid, event));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
    const observed = [];
    try {
      for (let index = 0; index < 2; index++) {
        await timeline();
        const artifact = m.artifacts.find(row => row.versionId === m.versions[index].id);
        const url = instance.origin + '/api/profile/resume-artifacts/' + artifact.id;
        const response = await page.request.get(url);
        assert.equal(response.status(), 200);
        assert(response.headers()['content-type'].startsWith('application/pdf'));
        assert(response.headers()['content-disposition'].startsWith('attachment;'));
        assert.equal(hash(await response.body()), artifact.sha256);
        const section = page.locator('[data-attempt-id="' + m.ids.attempts[index] + '"]');
        await section.getByTestId('download-submitted-artifact').click();
        await expect.poll(() => began.filter(event => event.url === url).length).toBe(1);
        const event = began.find(event => event.url === url);
        await expect.poll(() => completed.get(event.guid)?.state).toBe('completed');
        const bytes = fs.readFileSync(path.join(downloads, event.guid));
        assert.equal(hash(bytes), artifact.sha256);
        assert.equal(bytes.length, artifact.byteSize);
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
        observed.push({ artifact: artifact.id, downloadedFile: path.join(downloads, event.guid), suggestedFilename: event.suggestedFilename, sha256: hash(bytes), byteSize: bytes.length, contentType: response.headers()['content-type'] });
      }
      assert.deepEqual(await snapshots(), before);
      return observed;
    } finally {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false });
      await cdp.detach();
    }
  });
  await check('18-missing-material-ui-and-unavailable-route', async () => {
    await timeline(m.ids.archivedJob);
    const section = page.locator('[data-attempt-id="' + m.ids.archivedAttempt + '"]');
    await expect(section.getByTestId('submitted-resume-panel')).toContainText(t('jobs.submittedResumeUnbound'));
    await expect(section.getByTestId('submitted-material-facts')).toContainText(t('common.notAvailable'));
    await expect(section.getByTestId('download-submitted-artifact')).toHaveCount(0);
    const missing = await page.request.get(instance.origin + '/api/profile/resume-artifacts/' + x.ids.missingArtifact);
    assert.equal(missing.status(), 404);
    assert.equal((await missing.json()).code, 'ARTIFACT_BYTES_MISSING');
    const foreign = await page.request.get(instance.origin + '/api/profile/resume-artifacts/' + m.ids.foreignArtifact);
    assert.equal(foreign.status(), 404);
    return { missingMaterialUi: await section.getByTestId('submitted-resume-panel').innerText(), missingBytesHttp: 404, foreignArtifactHttp: 404, limitation: 'Unavailable bytes tested through actual authenticated public route; no claim of an additional UI error presentation' };
  });
  return { editedName, immutableSubmissions: before };
}

export async function executeScenes(ctx) {
  const before = await initialAndArchive(ctx);
  await runR6(ctx.instance, { runRoot: ctx.m.run });
  return connections(ctx, before);
}

export async function checkReopened(ctx, expected) {
  await ctx.check('19-real-reopen-persists-mutations-and-history', async () => {
    const { m, db, page, instance } = ctx;
    assert.deepEqual(await ctx.snapshots(), expected.immutableSubmissions);
    const detail = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
    assert(detail.reflectionCompletedAt);
    assert(detail.reflectionText.startsWith('P2 UI draft '));
    await page.goto(instance.origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    await expect(page.getByTestId('next-actions')).toHaveCount(0);
    await page.goto(instance.origin + '/dashboard/profile/resumes/' + m.ids.variant + '?version=' + m.versions[2].id, { waitUntil: 'load' });
    await expect(page.getByLabel(t('resumeVariants.fieldFullName'), { exact: true })).toHaveValue(expected.editedName);
    return { references: await ctx.referencesUi(), completion: detail.reflectionCompletedAt, body: detail.reflectionText, currentDraftName: expected.editedName, pid: instance.child.pid, origin: instance.origin };
  });
}
