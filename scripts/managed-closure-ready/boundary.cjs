'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runId, runDir, read, save, rpc, jsonHttp, poll } = require('./fixture.cjs');
const id = runId(process.argv[2]);
const directory = runDir(id);
const manifest = read(path.join(directory, 'manifest.json'));
const evidence = path.join(directory, 'evidence', 'http-' + crypto.randomUUID());
fs.mkdirSync(evidence);
const names = ['preconditions', 'no-subscription', 'expired-period', 'past-due', 'canceled', 'expired-status', 'last-unit-and-replay', 'same-key-concurrency', 'different-key-last-unit', 'operator-refresh-and-frozen-period', 'runtime-disable', 'http401-unknown', 'http429-unknown', 'http500-unknown', 'drop-unknown', 'malformed-committed', 'session-expiry-and-new-key'];
const results = names.map(name => ({ name, status: 'NOT_RUN' }));
const prefix = 'b-' + crypto.randomUUID().slice(0, 8);
let counter = 0;
const state = () => rpc(id, 'state');
const call = (key, endpoint, body) => jsonHttp(manifest.hosted, '/v1/' + endpoint, key.token, body);
const count = async () => (await state()).upstreamCount;
async function issue(user, ttlMs) {
  const issued = await rpc(id, 'issue', { user, ...(ttlMs === undefined ? {} : { ttlMs }) });
  const relative = path.relative(directory, issued.keyFile);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
  const key = read(issued.keyFile);
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(key.token), true);
  return key;
}
async function subscription(user, status, plan = 'beta', start = Date.now() - 1000, end = Date.now() + 3600000) {
  await rpc(id, 'subscription', { user, status, plan, start, end });
  return { start, end };
}
async function user(label, options = {}) {
  const uid = prefix + '-' + label;
  await rpc(id, 'user', { user: uid });
  const key = await issue(uid);
  let period;
  if (options.status !== null) period = await subscription(uid, options.status || 'ACTIVE', options.plan || 'beta', options.start, options.end);
  const binding = await call(key, 'bindings', { modelKey: 'vocatrya-fast', business: 'RESUME', resourceKey: 'boundary-resource' });
  assert.equal(binding.status, 200);
  assert.equal(typeof binding.body.managedBindingId, 'string');
  return { uid, key, bindingId: binding.body.managedBindingId, period };
}
function input(u, identity = crypto.randomUUID(), prompt = 'synthetic boundary prompt') {
  return { bindingId: u.bindingId, modelKey: 'vocatrya-fast', prompt, operationId: identity, invocationKey: identity + ':0', attemptIndex: 0 };
}
const invoke = (u, body = input(u)) => call(u.key, 'text', body);
async function usage(u, key) { return (await state()).usage.find(row => row.hostedUserId === u.uid && row.invocationKey === key); }
async function summary(u) {
  const result = await call(u.key, 'me/usage');
  assert.equal(result.status, 200);
  return result.body;
}
async function step(name, action) {
  const row = results.find(item => item.name === name);
  const file = path.join(evidence, String(++counter).padStart(2, '0') + '-' + name + '.json');
  try {
    const observation = await action();
    const observed = await state();
    row.status = 'PASS';
    save(file, { name, status: row.status, layer: 'REAL_LOCAL_HTTP_AND_FILE_SQLITE_WITH_SYNTHETIC_UPSTREAM', observation: observation || null, state: observed });
    save(path.join(evidence, 'results.json'), results);
    console.log('PASS ' + name);
  } catch (error) {
    row.status = 'FAIL';
    let observed;
    try { observed = await state(); } catch { observed = { unavailable: true }; }
    save(file, { name, status: row.status, error: { name: error.name, message: error.message }, state: observed });
    save(path.join(evidence, 'results.json'), results);
    throw error;
  }
}
async function denied(label, options) {
  const u = await user(label, options);
  const before = await count();
  const result = await invoke(u);
  assert.equal(result.body.code, 'NOT_ENTITLED');
  assert.equal(await count(), before);
  assert.equal((await state()).usage.filter(row => row.hostedUserId === u.uid).length, 0);
  return { code: result.body.code, upstreamDelta: 0 };
}
async function ambiguous(mode, code) {
  const u = await user(mode);
  const body = input(u);
  await rpc(id, 'mode', { mode });
  const before = await count();
  const result = await invoke(u, body);
  assert.equal(result.body.code, code);
  let row = await usage(u, body.invocationKey);
  assert.equal(row.status, 'UNKNOWN');
  assert.equal(row.settlement, 'RESERVED');
  assert.equal(row.chargedUnits, 0);
  assert.equal((await summary(u)).reservedUnits, 1);
  assert.equal(await count(), before + 1);
  await rpc(id, 'mode', { mode: 'success' });
  const retry = await invoke(u, body);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'INVOCATION_STATUS_UNKNOWN');
  assert.equal(await count(), before + 1);
  await poll(async () => {
    const replay = await invoke(u, body);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'INVOCATION_STATUS_UNKNOWN');
    return replay.body.settlement === 'COMMITTED';
  }, 7000);
  row = await usage(u, body.invocationKey);
  assert.equal(row.status, 'UNKNOWN');
  assert.equal(row.settlement, 'COMMITTED');
  assert.equal(row.chargedUnits, 1);
  const dto = await summary(u);
  assert.equal(dto.reservedUnits, 0);
  assert.equal(dto.committedUnits, 1);
  const snapshot = JSON.stringify(row);
  await invoke(u, body);
  assert.equal(JSON.stringify(await usage(u, body.invocationKey)), snapshot);
  assert.equal(await count(), before + 1);
  return { initialCode: code, finalStatus: row.status, finalSettlement: row.settlement, upstreamDelta: 1 };
}
async function main() {
  save(path.join(evidence, 'results.json'), results);
  await step('preconditions', async () => {
    const health = await rpc(id, 'health');
    assert.equal(health.healthy, true);
    const current = await state();
    assert.equal(current.usage.length, 0, 'Use a freshly prepared run for this suite');
    assert.equal(current.upstreamCount, 0);
    assert.equal(current.heldCount, 0);
    assert.equal(current.mode, 'success');
    return { baseline: manifest.baseline, fixturePid: health.pid, desktop: 'NOT_RUN' };
  });
  await step('no-subscription', () => denied('none', { status: null }));
  await step('expired-period', () => denied('old', { status: 'ACTIVE', start: Date.now() - 60000, end: Date.now() - 1000 }));
  await step('past-due', () => denied('past', { status: 'PAST_DUE' }));
  await step('canceled', () => denied('cancel', { status: 'CANCELED' }));
  await step('expired-status', () => denied('expired', { status: 'EXPIRED' }));
  await step('last-unit-and-replay', async () => {
    const u = await user('edge', { plan: 'edge' });
    const body = input(u);
    const before = await count();
    assert.equal((await invoke(u, body)).body.executionState, 'EXECUTED');
    assert.equal((await summary(u)).remainingUnits, 0);
    const replay = await invoke(u, body);
    assert.equal(replay.body.executionState, 'REPLAYED');
    assert.equal(replay.body.settlement, 'COMMITTED');
    assert.equal((await invoke(u)).body.code, 'QUOTA_EXCEEDED');
    assert.equal((await invoke(u, { ...body, prompt: 'different synthetic prompt' })).body.code, 'INVOCATION_CONFLICT');
    assert.equal(await count(), before + 1);
    assert.equal((await summary(u)).committedUnits, 1);
    return { upstreamDelta: 1, committedUnits: 1 };
  });
  await step('same-key-concurrency', async () => {
    const u = await user('same');
    const body = input(u);
    const before = await count();
    await rpc(id, 'mode', { mode: 'hold' });
    const first = invoke(u, body); first.catch(() => {});
    await poll(async () => (await state()).heldCount === 1);
    const second = await invoke(u, body);
    assert.equal(second.body.executionState, 'IN_PROGRESS');
    assert.equal(await count(), before + 1);
    await rpc(id, 'release');
    assert.equal((await first).body.executionState, 'EXECUTED');
    assert.equal((await invoke(u, body)).body.executionState, 'REPLAYED');
    assert.equal(await count(), before + 1);
    assert.equal((await summary(u)).committedUnits, 1);
    return { upstreamDelta: 1, duplicateReceipt: second.body.executionState };
  });
  await step('different-key-last-unit', async () => {
    const u = await user('race', { plan: 'edge' });
    const before = await count();
    await rpc(id, 'mode', { mode: 'hold' });
    const first = invoke(u); first.catch(() => {});
    await poll(async () => (await state()).heldCount === 1);
    assert.equal((await invoke(u)).body.code, 'QUOTA_EXCEEDED');
    assert.equal(await count(), before + 1);
    await rpc(id, 'release');
    assert.equal((await first).body.executionState, 'EXECUTED');
    const dto = await summary(u);
    assert.equal(dto.committedUnits, 1); assert.equal(dto.reservedUnits, 0); assert.equal(dto.remainingUnits, 0);
    return { upstreamDelta: 1, committedUnits: 1 };
  });
  await step('operator-refresh-and-frozen-period', async () => {
    const u = await user('renew', { plan: 'edge' });
    await invoke(u);
    assert.equal((await summary(u)).quotaLimitUnits, 1);
    await subscription(u.uid, 'ACTIVE', 'beta', u.period.start, u.period.end);
    const same = await summary(u);
    assert.equal(same.planKey, 'beta'); assert.equal(same.quotaLimitUnits, 1); assert.equal(same.remainingUnits, 0);
    const before = await count();
    assert.equal((await invoke(u)).body.code, 'QUOTA_EXCEEDED');
    assert.equal(await count(), before);
    await subscription(u.uid, 'PAST_DUE', 'beta', u.period.start, u.period.end);
    assert.equal((await summary(u)).subscriptionStatus, 'PAST_DUE');
    const entitlement = await call(u.key, 'me/entitlement');
    assert.deepEqual(entitlement.body.allowedModels, []);
    const newStart = Date.now() - 1, newEnd = Date.now() + 7200000;
    await subscription(u.uid, 'ACTIVE', 'beta', newStart, newEnd);
    const renewed = await summary(u);
    assert.equal(renewed.subscriptionStatus, 'ACTIVE'); assert.equal(renewed.quotaLimitUnits, 1000); assert.equal(renewed.committedUnits, 0);
    assert.deepEqual((await call(u.key, 'me/entitlement')).body.allowedModels, ['vocatrya-fast']);
    assert.equal((await invoke(u)).body.executionState, 'EXECUTED');
    assert.equal((await summary(u)).committedUnits, 1);
    assert.equal((await state()).quotas.filter(row => row.hostedUserId === u.uid).length, 2);
    return { sameSession: true, frozenOldLimit: same.quotaLimitUnits, newPeriodLimit: renewed.quotaLimitUnits };
  });
  await step('runtime-disable', async () => {
    const u = await user('runtime'); const body = input(u);
    await invoke(u, body); const before = await count();
    await rpc(id, 'runtime', { disabled: true });
    try {
      assert.equal((await invoke(u, body)).body.executionState, 'REPLAYED');
      assert.equal((await invoke(u)).body.code, 'MANAGED_AI_DISABLED');
      assert.equal(await count(), before);
    } finally { await rpc(id, 'runtime', { disabled: false }); }
    return { replayAllowed: true, newInvocationDenied: true };
  });
  await step('http401-unknown', () => ambiguous('http401', 'GATEWAY_AUTH'));
  await step('http429-unknown', () => ambiguous('http429', 'GATEWAY_RATE_LIMIT'));
  await step('http500-unknown', () => ambiguous('http500', 'GATEWAY_RESPONSE'));
  await step('drop-unknown', () => ambiguous('drop', 'GATEWAY_NETWORK'));
  await step('malformed-committed', async () => {
    const u = await user('bad'); const body = input(u); const before = await count();
    await rpc(id, 'mode', { mode: 'malformed' });
    assert.equal((await invoke(u, body)).body.code, 'GATEWAY_RESPONSE');
    const row = await usage(u, body.invocationKey);
    assert.equal(row.status, 'FAILED'); assert.equal(row.settlement, 'COMMITTED'); assert.equal(row.chargedUnits, 1);
    await rpc(id, 'mode', { mode: 'success' });
    assert.equal((await invoke(u, body)).body.executionState, 'REPLAYED');
    assert.equal(await count(), before + 1);
    return { status: row.status, settlement: row.settlement, upstreamDelta: 1 };
  });
  await step('session-expiry-and-new-key', async () => {
    const u = await user('ttl');
    const short = await issue(u.uid, 60000);
    const before = await summary(u); const callsBefore = await count();
    assert.equal((await call(short, 'session')).status, 200);
    await poll(async () => (await call(short, 'session')).status === 401, Math.max(1000, short.expiresAt - Date.now() + 10000));
    const replacement = await issue(u.uid);
    assert.equal((await call(replacement, 'session')).status, 200);
    const after = await call(replacement, 'me/usage');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, before);
    assert.equal(await count(), callsBefore);
    return { expiredSessionStatus: 401, replacementStatus: 200, entitlementAndUsageUnchanged: true, layer: 'HOSTED_HTTP_ONLY_CLIENT_CLEANUP_NOT_RUN' };
  });
  console.log(JSON.stringify({ status: 'PASS', boundary: 'SYNTHETIC_LOOPBACK_ONLY', desktop: 'NOT_RUN', evidence }));
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', error: error.name, evidence })); process.exitCode = 1; }).finally(async () => {
  try { await rpc(id, 'release'); await rpc(id, 'mode', { mode: 'success' }); await rpc(id, 'runtime', { disabled: false }); }
  catch { console.error('FIXTURE_RESTORE_FAILED'); process.exitCode = 1; }
});
