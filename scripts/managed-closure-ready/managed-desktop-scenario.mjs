import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 30000 });
import { register, assertDesktopSurface } from '../../desktop/e2e/scenario.mjs';
const require = createRequire(import.meta.url);
const { rpc, read, save, poll, jsonHttp } = require('./fixture.cjs');
const { scanArchive } = require('./scan-archive.cjs');
const { captureDenial, byokResolverCallable, assessNoFallback } = require('./no-fallback-evidence.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
export async function runManagedScenario(context) {
  const { root, runRoot, dataRoot, fixtureId, fixture, state, selected, start, stop, observationLog } = context;
  const directory = path.join(runRoot, 'managed-evidence'); fs.mkdirSync(directory);
  const messages = read(path.join(root, 'src/i18n/messages/zh-CN.json'));
  const steps = ['signup-native', 'key-format-vs-rejection', 'connect-default', 'quota-setup', 'quota-ui-execution', 'quota-denial-feedback', 'quota-visible-usage', 'competing-sources-no-fallback', 'entitlement-setup', 'past-due-feedback', 'expired-period-feedback', 'no-subscription-feedback', 'lifecycle-connect', 'refresh-renewal', 'session-expiry-ui-cleanup', 'new-key-preserves-rights', 'backup-export-privacy', 'quit-reopen-connected', 'disconnect-ui', 'quit-reopen-disconnected'];
  const results = steps.map(name => ({ name, status: 'NOT_RUN' }));
  const tokens = [];
  const secrets = [];
  const identity = { name: '托管边界合成用户', email: 'managed-' + randomUUID() + '@example.test', password: 'Synthetic-' + randomUUID() + '!' };
  let currentObservation = {}, currentName;
  const page = () => { assert.ok(state.instance?.page && !state.instance.page.isClosed(), 'LIVE_OWNED_ELECTRON_REQUIRED'); return state.instance.page; };
  const fixtureState = () => rpc(fixtureId, 'state');
  const note = value => { currentObservation = { ...currentObservation, ...value }; };
  function query(sql, ...args) {
    const db = new DatabaseSync(path.join(dataRoot, 'data', 'vocatrya.db'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  }
  function execDb(sql, ...args) {
    const db = new DatabaseSync(path.join(dataRoot, 'data', 'vocatrya.db'));
    try { db.exec('PRAGMA busy_timeout=15000'); return db.prepare(sql).run(...args); } finally { db.close(); }
  }
  // Backend outbound events recorded by the assembled-server observer since
  // byte offset. Only loopback evidence is acceptable; any exec-channel or
  // credential-broker call here is direct proof a fallback path was attempted.
  function outboundEvents(offset) {
    assert.ok(observationLog && fs.existsSync(observationLog), 'backend observation log required');
    return fs.readFileSync(observationLog).subarray(offset).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
  function files() {
    const folder = path.join(dataRoot, 'config', 'hosted-sessions');
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(file => file.endsWith('.dat')).map(file => path.join(folder, file));
  }
  function privacy(connected) {
    const stored = files(); assert.equal(stored.length, connected ? 1 : 0);
    for (const token of tokens) {
      for (const file of stored) assert.equal(fs.readFileSync(file).includes(Buffer.from(token)), false);
      const database = path.join(dataRoot, 'data', 'vocatrya.db');
      for (const file of [database, database + '-wal', database + '-shm']) if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from(token)), false);
    }
    const rows = query("SELECT provider,backendKind,status,credentialRef FROM AIConnection WHERE archivedAt IS NULL");
    for (const row of rows.filter(row => row.backendKind === 'MANAGED_GATEWAY')) assert.equal(row.credentialRef, null);
    assert.equal(rows.some(row => row.backendKind !== 'MANAGED_GATEWAY'), false, 'This fixture must have no real account or BYOK connection');
    return { sessionFiles: stored.length, connectionStatuses: rows.map(row => row.status), rawKeyAbsentFromKnownDatabaseFiles: true, backup: 'NOT_RUN', competingFallbackSources: 'NOT_CONFIGURED' };
  }
  async function step(name, action, fatal = true) {
    currentName = name; currentObservation = {};
    const row = results.find(value => value.name === name);
    if (context.previouslyObservedSteps?.includes(name)) {
      row.reason = 'Covered by retained earlier evidence; not rerun in this continuation';
      save(path.join(directory, 'results.json'), results);
      return false;
    }
    if (context.blockedSteps?.includes(name)) {
      row.status = 'BLOCKED';
      row.reason = context.blockedReason || 'Known shared entry blocker';
      save(path.join(directory, 'results.json'), results);
      console.log('BLOCKED managed/' + name + ': ' + row.reason);
      return false;
    }
    try { await action(); row.status = 'PASS'; }
    catch (error) {
      const redact = value => secrets.concat(tokens).reduce((text, token) => text.replaceAll(token, '[REDACTED]'), String(value));
      if (error?.code === 'BLOCKED_PREREQ') {
        row.status = 'BLOCKED';
        row.reason = redact(error.message);
      } else {
        row.status = 'FAIL';
        row.error = { name: error.name, message: redact(error.message), stack: redact(error.stack || error.message) };
      }
    }
    row.observation = currentObservation;
    let snapshot;
    try { snapshot = await fixtureState(); } catch { snapshot = { unavailable: true }; }
    save(path.join(directory, String(steps.indexOf(name) + 1).padStart(2, '0') + '-' + name + '.json'), { ...row, host: 'WINDOWS_ELECTRON', mode: 'fresh-native', fixture: snapshot });
    save(path.join(directory, 'results.json'), results);
    if (state.instance?.page && !state.instance.page.isClosed()) await state.instance.page.screenshot({ path: path.join(directory, String(steps.indexOf(name) + 1).padStart(2, '0') + '-' + name + '.png') }).catch(() => {});
    console.log(row.status + ' managed/' + name);
    if (row.status === 'FAIL' && fatal) throw new Error('MANAGED_STEP_FAILED_' + name);
    return row.status === 'PASS';
  }
  async function settings(section) {
    await page().goto(state.instance.origin + '/dashboard/settings?section=' + section);
    await assertDesktopSurface(page());
    const container = page().getByTestId('settings-section-' + section);
    await expect(container).toBeVisible();
    await page().waitForLoadState('networkidle', { timeout: 45000 });
    return container;
  }
  async function card() {
    const section = await settings('ai-services');
    // The managed card lives on the second service tab; BYOK and account
    // services sit on the first. Click the tab before locating it.
    await section.getByRole('tab', { name: messages.settings.aiServicesTabManaged, exact: true }).click();
    const result = section.getByRole('heading', { name: messages.settings.aiServicesManagedGroupTitle, exact: true }).locator('xpath=../..');
    await expect(result.getByRole('button').first()).toBeEnabled();
    return result;
  }
  async function action(click) {
    const response = page().waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).origin === state.instance.origin && new URL(value.url()).pathname === '/dashboard/settings');
    await click();
    assert.equal((await response).ok(), true, 'SETTINGS_ACTION_HTTP_FAILED');
  }
  async function issue(user, ttlMs) {
    const result = await rpc(fixtureId, 'issue', { user, ...(ttlMs === undefined ? {} : { ttlMs }) });
    const key = read(result.keyFile); tokens.push(key.token); return key;
  }
  async function redeem(key) {
    const section = await settings('subscription');
    await expect(section.getByRole('button').first()).toBeEnabled();
    const before = (await fixtureState()).hostedCount;
    await section.locator('input[type=password]').fill(key.token);
    await action(() => section.getByRole('button', { name: messages.settings.managedRechargeSubmit, exact: true }).click());
    await expect(section.locator('input[type=password]')).toHaveValue('');
    await expect(section.getByText('CONNECTED', { exact: true })).toBeVisible();
    await expect(section.locator('dd').filter({ hasText: new RegExp('^' + key.hostedUserId + '$') })).toBeVisible();
    const observations = await fixtureState();
    assert.equal(observations.hostedRequests.some(row => row.seq > before && row.path === '/v1/session' && row.status === 200), true);
    const rows = query("SELECT status,credentialRef FROM AIConnection WHERE backendKind='MANAGED_GATEWAY' AND archivedAt IS NULL");
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'CONNECTED'); assert.equal(rows[0].credentialRef, null);
    await poll(() => files().length === 1);
    return privacy(true);
  }
  async function subscription(user, status, plan = 'beta', period) {
    const start = period?.periodStart ?? Date.now() - 1000;
    const end = period?.periodEnd ?? Date.now() + 86400000;
    return rpc(fixtureId, 'subscription', { user, status, plan, start, end });
  }
  async function createHosted(label, plan = 'beta') {
    const user = 'desktop-' + label + '-' + randomUUID().slice(0, 8);
    await rpc(fixtureId, 'user', { user });
    if (plan !== null) await subscription(user, 'ACTIVE', plan);
    const key = await issue(user);
    return { user, key };
  }
  async function assign() {
    await settings('ai-assignments');
    const row = page().getByTestId('ai-assign-row-GLOBAL_DEFAULT');
    await expect(row).toBeVisible();
    await row.getByRole('combobox').first().click();
    await page().getByRole('option', { name: messages.settings.aiAssignManagedOption, exact: true }).click();
    await row.locator('input').fill('vocatrya-fast');
    await action(() => row.getByRole('button', { name: messages.common.save, exact: true }).click());
    await poll(() => query("SELECT a.model,c.backendKind,c.provider FROM AIBusinessAssignment a JOIN AIConnection c ON c.id=a.connectionId WHERE a.purpose='GLOBAL_DEFAULT'").some(value => value.model === 'vocatrya-fast' && value.backendKind === 'MANAGED_GATEWAY' && value.provider === 'VOCATRYA'));
  }
  async function openNewChat() {
    await page().goto(state.instance.origin + '/dashboard');
    const button = page().getByRole('button', { name: messages.nav.openAssistant, exact: true });
    if (await button.count()) await button.first().click();
    const panel = page().getByRole('dialog').filter({ has: page().getByTestId('agent-new-conversation') });
    await expect(panel).toBeVisible();
    await panel.getByTestId('agent-new-conversation').click();
    await expect(panel.getByPlaceholder(messages.agent.inputPlaceholder, { exact: true })).toHaveValue('');
    return panel;
  }
  async function successfulTurn(user) {
    const marker = 'SYNTHETIC_MANAGED_' + randomUUID();
    await rpc(fixtureId, 'mode', { mode: 'success', reply: marker });
    const before = await fixtureState();
    const conversationIds = new Set(query('SELECT id FROM ChatConversation').map(row => row.id));
    const panel = await openNewChat();
    await panel.getByPlaceholder(messages.agent.inputPlaceholder, { exact: true }).fill('你好');
    await expect(panel.getByRole('button', { name: messages.agent.send, exact: true })).toBeEnabled();
    const response = page().waitForResponse(value => new URL(value.url()).pathname === '/api/ai/chat' && value.request().method() === 'POST');
    await panel.getByRole('button', { name: messages.agent.send, exact: true }).click();
    const result = await response;
    assert.equal(result.ok(), true);
    await result.finished();
    await expect(panel.getByText(marker, { exact: true })).toBeVisible();
    const after = await fixtureState();
    const added = after.usage.filter(row => row.hostedUserId === user && !before.usage.some(old => old.invocationKey === row.invocationKey && old.hostedUserId === user));
    assert.equal(added.length, 1, 'Greeting must use the deterministic FAST_CHAT single streaming invocation');
    assert.equal(added[0].status, 'SUCCEEDED'); assert.equal(added[0].settlement, 'COMMITTED'); assert.equal(added[0].chargedUnits, 1);
    assert.equal(after.upstreamCount - before.upstreamCount, 1);
    await poll(() => query('SELECT id FROM ChatConversation WHERE messages LIKE ?', '%' + marker + '%').length === 1);
    const row = query('SELECT id,resolvedConnectionId,resolvedModel,managedAiProvenance FROM ChatConversation WHERE messages LIKE ?', '%' + marker + '%')[0];
    assert.equal(conversationIds.has(row.id), false);
    assert.equal(row.resolvedModel, 'vocatrya-fast'); assert.ok(row.resolvedConnectionId);
    const provenance = JSON.parse(row.managedAiProvenance);
    assert.equal(provenance.upstreamModelId, 'fixture-model-v1'); assert.equal(provenance.requestedModelKey, 'vocatrya-fast'); assert.ok(provenance.managedBindingId);
    note({ conversationId: row.id, managedProvenance: provenance, upstreamDelta: 1, committedUnits: 1, realModel: false });
  }
  function competingAcceptance() {
    const file = process.env.VOCATRYA_MANAGED_COMPETING_CONFIG;
    if (!file) return { blocked: 'USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED' };
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return { blocked: 'USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED' }; }
    const key = value?.byok?.apiKey;
    const account = value?.account?.runtimeProfileRef;
    if (value?.acceptance !== 'USABLE_COMPETING_CONNECTION' || value?.byok?.callable !== true || value?.account?.callable !== true) return { blocked: 'USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED' };
    if (typeof key !== 'string' || key.trim().length < 8 || typeof account !== 'string' || account.trim().length < 3) return { blocked: 'USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED' };
    return { key: key.trim(), account: account.trim() };
  }
  async function deniedTurn(pattern, expectedCode, requireSubmission = false) {
    const panel = await openNewChat();
    const before = await fixtureState();
    const denials = [];
    const pending = [];
    const onResponse = response => {
      if (new URL(response.url()).pathname !== '/api/ai/chat' || response.request().method() !== 'POST') return;
      pending.push(response.text().then(
        text => denials.push(captureDenial(response.status(), text)),
        () => denials.push({ httpStatus: response.status(), code: null, captureError: 'BODY_READ_FAILED' })
      ));
    };
    page().on('response', onResponse);
    try {
      const input = panel.getByPlaceholder(messages.agent.inputPlaceholder, { exact: true });
      await input.fill('你好');
      const send = panel.getByRole('button', { name: messages.agent.send, exact: true });
      await expect.poll(async () => await send.isEnabled() || await panel.getByRole('alert').count() > 0).toBe(true);
      const submitted = await send.isEnabled();
      if (requireSubmission) assert.equal(submitted, true, 'backend no-fallback requires an actual submission');
      if (submitted) {
        await expect(panel.getByRole('alert')).toHaveCount(0);
        const response = requireSubmission ? page().waitForResponse(value => new URL(value.url()).pathname === '/api/ai/chat' && value.request().method() === 'POST') : null;
        await send.click();
        if (response) await response;
      }
      await expect(panel.getByRole('alert').first()).toBeVisible();
      await Promise.all(pending);
      let denial = denials.find(row => row.code === expectedCode) || denials[0] || { httpStatus: null, code: null, captureError: 'MISSING_RESPONSE' };
      const text = (await panel.getByRole('alert').allTextContents()).join('\n');
      const after = await fixtureState();
      let authoritative = null;
      if (requireSubmission) {
        // The denial travels inside the chat stream; the renderer aborts it
        // once the error part lands, so the wire code is asserted against the
        // authoritative hosted ledger (real submission, real HTTP status and
        // response code) instead of a possibly unreadable renderer body.
        const ledgerBase = before.hostedRequests.length;
        await poll(async () => (await fixtureState()).hostedRequests.slice(ledgerBase)
          .find(row => row.method === 'POST' && row.status >= 400 && row.code === expectedCode), 15000)
          .then(row => { authoritative = row; }, () => {});
        authoritative = authoritative || after.hostedRequests.slice(ledgerBase)
          .find(row => row.method === 'POST' && row.status >= 400 && row.code === expectedCode) || null;
        assert.ok(authoritative, 'backend denial must reach hosted with the expected code');
        if (denial.code !== expectedCode) denial = { httpStatus: denial.httpStatus, code: authoritative.code, captureError: null, codeSource: 'HOSTED_LEDGER', hostedHttpStatus: authoritative.status, hostedPath: authoritative.path };
      }
      const upstreamDelta = after.upstreamCount - before.upstreamCount;
      const usageDelta = after.usage.length - before.usage.length;
      const newSucceeded = after.usage.some(row => row.status === 'SUCCEEDED' && !before.usage.some(old => old.hostedUserId === row.hostedUserId && old.invocationKey === row.invocationKey));
      note({ expectedCode, observedCode: denial.code, httpStatus: denial.httpStatus, captureError: denial.captureError, denialCodeSource: denial.codeSource || 'RENDERER_RESPONSE', hostedDenial: authoritative ? { path: authoritative.path, httpStatus: authoritative.status, code: authoritative.code } : null, submitted, visibleFeedback: text.slice(0, 1500), upstreamDelta, usageDelta, competingFallbackSources: requireSubmission ? 'PENDING_OBSERVER' : 'NOT_CONFIGURED' });
      assert.equal(upstreamDelta, 0);
      assert.equal(usageDelta, 0);
      assert.equal(newSucceeded, false);
      assert.match(text, pattern, 'Visible feedback must explain the actual boundary, not only show a generic retry error');
      return { submitted, denial, upstreamDelta, usageDelta, newSucceeded };
    } finally { page().off('response', onResponse); }
  }
  save(path.join(directory, 'results.json'), results);
  await step('signup-native', async () => {
    const instance = await start(false);
    await register(instance.page, instance.origin, identity);
    await assertDesktopSurface(instance.page);
    const markers = query('SELECT migrationKey,status,verifiedAt FROM AbMigrationState');
    assert.equal(markers.some(row => row.migrationKey === 'vocatrya-ab-fresh-native-v1' && row.status === 'FRESH_READY' && row.verifiedAt !== null), true);
    assert.equal(files().length, 0);
    note({ electronPid: instance.child.pid, origin: instance.origin, dataRoot, marker: 'FRESH_READY', activation: 'AB_ENABLED/full verified by connectDesktop', realAI: 'NOT_RUN' });
  });
  await step('key-format-vs-rejection', async () => {
    const section = await settings('subscription');
    await expect(section.getByRole('button').first()).toBeEnabled();
    const before = (await fixtureState()).hostedCount;
    await section.locator('input[type=password]').fill('bad-short-key');
    await action(() => section.getByRole('button', { name: messages.settings.managedRechargeSubmit, exact: true }).click());
    await expect(section.getByRole('alert')).toHaveText(messages.settings.managedRechargeKeyInvalid);
    assert.equal((await fixtureState()).hostedCount, before); assert.equal(files().length, 0);
    const rejected = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 11);
    await section.locator('input[type=password]').fill(rejected);
    await action(() => section.getByRole('button', { name: messages.settings.managedRechargeSubmit, exact: true }).click());
    await expect(section.getByRole('alert')).toHaveText(messages.settings.managedRechargeKeyRejected);
    assert.equal((await fixtureState()).hostedRequests.some(row => row.seq > before && row.path === '/v1/session' && row.status === 401), true); assert.equal(files().length, 0);
    note({ localFormatRejectedWithoutHostedRequest: true, authoritative401Observed: true, storedFiles: 0 });
  });
  await step('connect-default', async () => { const key = read(fixture.defaultKeyFile); tokens.push(key.token); note(await redeem(key)); });
  async function group(name, action) {
    if (!selected.includes(name)) return;
    try { await action(); }
    catch { note({ groupStoppedAfterFailure: name }); }
    if (!state.instance || state.instance.child.exitCode !== null || state.instance.child.signalCode !== null || state.instance.page?.isClosed()) throw new Error('OWNED_DESKTOP_UNAVAILABLE_AFTER_' + name);
  }
  await group('quota', async () => {
    let user;
    await step('quota-setup', async () => { user = await createHosted('quota', 'edge'); await redeem(user.key); await assign(); note({ hostedUser: user.user, plan: 'edge', quotaLimit: 1 }); });
    await step('quota-ui-execution', () => successfulTurn(user.user));
    await step('quota-denial-feedback', () => deniedTurn(/额度|quota|QUOTA_EXCEEDED/i, 'QUOTA_EXCEEDED'), false);
    await step('quota-visible-usage', async () => { const managed = await card(); await expect(managed.locator('dd').filter({ hasText: /^1\s*\/\s*1$/ })).toBeVisible(); const current = await fixtureState(); const quota = current.quotas.find(row => row.hostedUserId === user.user); assert.equal(quota.committedUnits, 1); assert.equal(quota.reservedUnits, 0); note({ visibleUsed: '1 / 1', committedUnits: 1, reservedUnits: 0 }); });
    await step('competing-sources-no-fallback', async () => {
      const acceptance = competingAcceptance();
      if (acceptance.blocked) {
        note({ usableCompetingConnection: 'BLOCKED', competingCredentials: 'NOT_CONFIGURED', competingFallbackSources: 'NOT_CONFIGURED', syntheticAcceptance: false, realModel: 'NOT_RUN', publicGateway: 'NOT_RUN' });
        throw Object.assign(new Error(acceptance.blocked), { code: 'BLOCKED_PREREQ' });
      }
      secrets.push(acceptance.key);
      const userId = query('SELECT id FROM "User" ORDER BY createdAt ASC LIMIT 1')[0]?.id;
      assert.ok(userId, 'local user required to seed competing connections');
      const now = new Date().toISOString();
      const apiKeyId = 'key-' + randomUUID(), byokId = 'conn-' + randomUUID(), accountId = 'conn-' + randomUUID();
      try {
        // Executor-supplied material only. Empty iv is the resolver's callable
        // plaintext form. A non-callable os:v1 blob cannot satisfy this step.
        execDb('INSERT INTO ApiKey (id,userId,provider,encryptedKey,iv,last4,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)', apiKeyId, userId, 'deepseek', acceptance.key, '', acceptance.key.slice(-4), now, now);
        execDb('INSERT INTO AIConnection (id,userId,displayName,authType,backendKind,provider,status,credentialRef,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', byokId, userId, 'boundary-byok', 'API_KEY', 'LOCAL_BYOK', 'DEEPSEEK', 'CONNECTED', apiKeyId, now, now);
        execDb('INSERT INTO AIConnection (id,userId,displayName,authType,backendKind,provider,status,runtimeProfileRef,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', accountId, userId, 'boundary-account', 'ACCOUNT_LOGIN', 'CODEX_RUNTIME', 'OPENAI', 'CONNECTED', acceptance.account, now, now);
        assert.equal(byokResolverCallable(query('SELECT encryptedKey,iv FROM ApiKey WHERE id=?', apiKeyId)[0]), true, 'BYOK row must be resolver-callable');
        assert.ok(observationLog && fs.existsSync(observationLog), 'backend observation log required for no-fallback evidence');
        const offset = fs.statSync(observationLog).size;
        const outcome = await deniedTurn(/额度|quota|QUOTA_EXCEEDED/i, 'QUOTA_EXCEEDED', true);
        const assessment = assessNoFallback({ events: outboundEvents(offset), denial: outcome.denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: outcome.upstreamDelta, usageDelta: outcome.usageDelta, newSucceeded: outcome.newSucceeded });
        note({ competingSources: ['LOCAL_BYOK', 'CODEX_RUNTIME'], competingCredentials: 'EXECUTOR_SUPPLIED', usableCompetingConnection: 'OBSERVED_WITH_EXECUTOR_CREDENTIALS', byokResolverCallable: true, accountRuntimeProbed: false, realModel: 'NOT_RUN', publicGateway: 'NOT_RUN', ...assessment, competingFallbackSources: assessment.ok ? 'CONFIGURED_AND_OBSERVED' : 'OBSERVED_FAILURE' });
        assert.equal(assessment.ok, true, 'no-fallback evidence incomplete: ' + assessment.failures.join(','));
      } finally {
        execDb('DELETE FROM AIConnection WHERE id IN (?,?)', byokId, accountId);
        execDb('DELETE FROM ApiKey WHERE id = ?', apiKeyId);
      }
    }, false);
  });
  await group('entitlement', async () => {
    let user, period;
    await step('entitlement-setup', async () => { user = await createHosted('rights'); await redeem(user.key); await assign(); await successfulTurn(user.user); period = (await fixtureState()).subscriptions.find(row => row.hostedUserId === user.user); });
    await step('past-due-feedback', async () => {
      await subscription(user.user, 'PAST_DUE', 'beta', period);
      const managed = await card(); await expect(managed.getByText(messages.settings.managedNoEntitlement, { exact: true })).toBeVisible();
      note({ settingsFeedback: messages.settings.managedNoEntitlement, authoritativeStatus: 'PAST_DUE' });
      await deniedTurn(/权益|套餐|权限|entitle|plan|NOT_ENTITLED/i, 'NOT_ENTITLED');
    }, false);
    await step('expired-period-feedback', async () => {
      await subscription(user.user, 'ACTIVE', 'beta', { periodStart: Date.now() - 120000, periodEnd: Date.now() - 1000 });
      const managed = await card(); await expect(managed.getByText(messages.settings.managedNoEntitlement, { exact: true })).toBeVisible();
      note({ settingsFeedback: messages.settings.managedNoEntitlement, status: 'ACTIVE', periodExpired: true });
      await deniedTurn(/权益|套餐|权限|过期|到期|entitle|plan|expire|NOT_ENTITLED/i, 'NOT_ENTITLED');
    }, false);
    await step('no-subscription-feedback', async () => {
      const none = await createHosted('none', null);
      await redeem(none.key);
      const managed = await card(); await expect(managed.getByText(messages.settings.managedNoEntitlement, { exact: true })).toBeVisible();
      note({ settingsFeedback: messages.settings.managedNoEntitlement, hostedUser: none.user, subscription: null });
      await deniedTurn(/权益|套餐|权限|entitle|plan|NOT_ENTITLED/i, 'NOT_ENTITLED');
    }, false);
  });
  await group('lifecycle', async () => {
    let key, beforeRights, expired;
    await step('lifecycle-connect', async () => { key = await issue('desktop-beta'); note(await redeem(key)); });
    await step('refresh-renewal', async () => {
      const old = (await fixtureState()).subscriptions.find(row => row.hostedUserId === 'desktop-beta');
      const encrypted = sha(fs.readFileSync(files()[0]));
      await subscription('desktop-beta', 'PAST_DUE', 'beta', old);
      let managed = await card(); await expect(managed.locator('dd').filter({ hasText: /^PAST_DUE$/ })).toBeVisible(); await expect(managed.getByText(messages.settings.managedNoEntitlement, { exact: true })).toBeVisible();
      await subscription('desktop-beta', 'ACTIVE', 'beta', { periodStart: Date.now() - 1000, periodEnd: Date.now() + 172800000 });
      managed = await card(); await expect(managed.locator('dd').filter({ hasText: /^ACTIVE$/ })).toBeVisible(); await expect(managed.locator('dd').filter({ hasText: /^0\s*\/\s*1000$/ })).toBeVisible();
      assert.equal(sha(fs.readFileSync(files()[0])), encrypted);
      beforeRights = (await fixtureState()).subscriptions.find(row => row.hostedUserId === 'desktop-beta');
      note({ sameEncryptedSession: true, observedStatuses: ['PAST_DUE', 'ACTIVE'], renewalCreatedNewPeriod: true, quotaVisible: '0 / 1000' });
    });
    await step('session-expiry-ui-cleanup', async () => {
      expired = await issue('desktop-beta', 60000); await redeem(expired);
      assert.equal((await jsonHttp(fixture.hosted, '/v1/session', expired.token)).status, 200);
      await poll(async () => (await jsonHttp(fixture.hosted, '/v1/session', expired.token)).status === 401, Math.max(1000, expired.expiresAt - Date.now() + 15000));
      const before = (await fixtureState()).hostedCount;
      const managed = await card();
      await expect(managed.getByText('CONNECTED', { exact: true })).toHaveCount(0);
      await expect(managed).toContainText(/MANAGED_AUTH_REQUIRED|REAUTH_REQUIRED/);
      await poll(() => files().length === 0);
      const rows = query("SELECT status FROM AIConnection WHERE backendKind='MANAGED_GATEWAY' AND archivedAt IS NULL");
      assert.equal(rows.some(row => row.status === 'CONNECTED'), false);
      assert.equal((await fixtureState()).hostedRequests.some(row => row.seq > before && row.status === 401), true);
      note({ authoritativeExpired: true, realUiRefreshObserved401: true, localStatuses: rows.map(row => row.status), privacy: privacy(false) });
    });
    await step('new-key-preserves-rights', async () => {
      beforeRights = (await fixtureState()).subscriptions.find(row => row.hostedUserId === 'desktop-beta');
      key = await issue('desktop-beta'); assert.equal(key.token === expired.token, false);
      await redeem(key);
      const after = (await fixtureState()).subscriptions.find(row => row.hostedUserId === 'desktop-beta'); assert.deepEqual(after, beforeRights);
      const managed = await card(); await expect(managed.locator('dd').filter({ hasText: /^0\s*\/\s*1000$/ })).toBeVisible();
      note({ subscriptionUnchanged: true, privacy: privacy(true) });
    }, false);
    await step('backup-export-privacy', async () => {
      const response = await page().request.get(state.instance.origin + '/api/backup/export?includeSensitiveData=true');
      assert.equal(response.status(), 200, 'backup export request status');
      const buffer = await response.body();
      fs.writeFileSync(path.join(directory, 'backup-export.zip'), buffer);
      const credentials = read(path.join(root, '.tmp', 'managed-closure-ready', 'runs', fixtureId, 'credentials.json'));
      const probes = { sessionTokens: tokens.filter(Boolean), sessionCiphertext: files().map(file => fs.readFileSync(file)), fixtureCredentials: Object.values(credentials).filter(value => typeof value === 'string' && value.length >= 8) };
      const { zip, scannedEntries } = await scanArchive(buffer, probes);
      assert.equal(zip.file(/hosted-sessions|\.dat$/i).length, 0, 'backup must not contain hosted session files');
      const data = JSON.parse(await zip.file('data.json').async('string'));
      assert.equal(data.ApiKey, undefined, 'API key material must never be exported');
      const exported = (data.AIConnection || []).filter(row => row.backendKind === 'MANAGED_GATEWAY');
      assert.ok(exported.length >= 1, 'managed connection row expected in backup');
      const forbidden = /key|token|secret|credential|session/i;
      const unsafe = value => !!(value && typeof value === 'object' && Object.entries(value).some(([k, v]) => forbidden.test(k) || unsafe(v)));
      for (const row of exported) {
        assert.equal(row.credentialRef ?? null, null, 'exported managed row must not reference credentials');
        assert.equal(unsafe(row.providerMetadata ? JSON.parse(row.providerMetadata) : null), false, 'exported managed providerMetadata must not carry credential-shaped fields');
      }
      note({ includeSensitiveData: true, bytes: buffer.length, scannedEntries, exportedManagedRows: exported.length, sessionTokensProbed: probes.sessionTokens.length, ciphertextProbed: probes.sessionCiphertext.length, backup: 'EXPORTED_AND_SCANNED' });
    }, false);
    await step('quit-reopen-connected', async () => {
      const oldPid = state.instance.child.pid, oldOrigin = state.instance.origin;
      const encrypted = sha(fs.readFileSync(files()[0]));
      await stop(); const reopened = await start(true);
      await expect(reopened.page.getByRole('complementary').getByRole('button', { name: '用户菜单', exact: true })).toContainText(identity.email);
      const managed = await card(); await expect(managed.getByText('CONNECTED', { exact: true })).toBeVisible();
      await expect(managed.locator('dd').filter({ hasText: /^ACTIVE$/ })).toBeVisible();
      await expect(managed.locator('dd').filter({ hasText: /^0\s*\/\s*1000$/ })).toBeVisible();
      const assignment = query("SELECT a.model,c.backendKind FROM AIBusinessAssignment a JOIN AIConnection c ON c.id=a.connectionId WHERE a.purpose='GLOBAL_DEFAULT' ORDER BY a.updatedAt DESC LIMIT 1")[0];
      assert.equal(assignment?.backendKind, 'MANAGED_GATEWAY', 'model assignment must survive quit/reopen');
      assert.equal(assignment?.model, 'vocatrya-fast', 'assigned managed model must survive quit/reopen');
      assert.equal(sha(fs.readFileSync(files()[0])), encrypted);
      note({ oldPid, newPid: reopened.child.pid, oldOrigin, newOrigin: reopened.origin, gracefulQuitAndBackendPortClosed: true, sameDataRoot: dataRoot, entitlementStatus: 'ACTIVE', visibleUsage: '0 / 1000', assignmentModel: 'vocatrya-fast', privacy: privacy(true) });
    });
    await step('disconnect-ui', async () => {
      const managed = await card();
      await action(() => managed.getByRole('button', { name: messages.settings.managedDisconnect, exact: true }).click());
      await expect(managed.getByText('CONNECTED', { exact: true })).toHaveCount(0);
      await poll(() => files().length === 0);
      assert.equal(query("SELECT id FROM AIConnection WHERE backendKind='MANAGED_GATEWAY' AND archivedAt IS NULL AND status='CONNECTED'").length, 0);
      note({ actualDisconnectButton: true, privacy: privacy(false) });
    });
    await step('quit-reopen-disconnected', async () => {
      const oldPid = state.instance.child.pid;
      await stop(); const reopened = await start(true);
      const managed = await card(); await expect(managed.getByText('CONNECTED', { exact: true })).toHaveCount(0);
      assert.equal(query("SELECT id FROM AIConnection WHERE backendKind='MANAGED_GATEWAY' AND archivedAt IS NULL AND status='CONNECTED'").length, 0);
      note({ oldPid, newPid: reopened.child.pid, gracefulQuitAndBackendPortClosed: true, sameDataRoot: dataRoot, privacy: privacy(false) });
    });
  });
  const failed = results.filter(row => row.status === 'FAIL');
  const blocked = results.filter(row => row.status === 'BLOCKED');
  const competing = results.find(row => row.name === 'competing-sources-no-fallback');
  const usableCompetingConnection = competing?.status === 'PASS' ? 'OBSERVED_WITH_EXECUTOR_CREDENTIALS' : competing?.status === 'BLOCKED' ? 'BLOCKED' : competing?.status === 'FAIL' ? 'FAIL' : 'NOT_RUN';
  save(path.join(directory, 'scope.json'), { selected, failed: failed.map(row => row.name), blocked: blocked.map(row => row.name), notRun: results.filter(row => row.status === 'NOT_RUN').map(row => row.name), realAI: 'NOT_RUN', backup: results.find(row => row.name === 'backup-export-privacy')?.status ?? 'NOT_RUN', configuredCompetingAccountOrByokFallback: competing?.status ?? 'NOT_RUN', usableCompetingConnection, sourceAndBuild: '../snapshot-manifest.json' });
  if (failed.length) throw new Error('MANAGED_DESKTOP_ASSERTIONS_FAILED_' + failed.length);
  const unexpectedBlocked = blocked.filter(row => !(row.name === 'competing-sources-no-fallback' && row.reason === 'USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED'));
  if (unexpectedBlocked.length) throw new Error('MANAGED_DESKTOP_ASSERTIONS_BLOCKED_' + unexpectedBlocked.length);
  if (usableCompetingConnection === 'BLOCKED') throw Object.assign(new Error('MANAGED_DESKTOP_USABLE_COMPETING_BLOCKED'), { code: 'USABLE_COMPETING_BLOCKED' });
  if (context.previouslyObservedSteps?.length) throw new Error('PARTIAL_CONTINUATION_REQUIRES_AGGREGATE_REVIEW');
}
