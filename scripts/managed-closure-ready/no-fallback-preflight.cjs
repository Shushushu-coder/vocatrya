'use strict';
// Driver preflight only. Loopback HTTP and synthetic observer events prove the
// no-fallback checks submit, capture a response code, and wait for observer
// completion. This does not accept a usable account or BYOK connection.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { captureDenial, byokResolverCallable, assessNoFallback } = require('./no-fallback-evidence.cjs');

function listen() {
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/ai/chat') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'quota', code: 'QUOTA_EXCEEDED' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/silent') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: 'synthetic fallback answer' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(url) {
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.text() };
}

function finishedEvents(status) {
  return [
    { kind: 'incoming-start', pid: 1, requestId: 7, method: 'POST', pathname: '/api/ai/chat' },
    { kind: 'incoming-finish', pid: 1, requestId: 7, method: 'POST', pathname: '/api/ai/chat', status }
  ];
}

async function main() {
  const server = await listen();
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port;
  try {
    const denied = await post(base + '/api/ai/chat');
    const denial = captureDenial(denied.status, denied.body);
    const passed = assessNoFallback({ events: finishedEvents(400), denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 0, usageDelta: 0, newSucceeded: false });
    assert.equal(passed.ok, true, passed.failures.join(','));
    assert.equal(byokResolverCallable({ iv: 'os:v1', encryptedKey: 'synthetic-ciphertext-not-real' }), false);

    const silent = await post(base + '/silent');
    const silentDenial = captureDenial(silent.status, silent.body);
    const silentResult = assessNoFallback({ events: finishedEvents(200), denial: silentDenial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 0, usageDelta: 0, newSucceeded: false });
    assert.equal(silentResult.ok, false);
    assert.ok(silentResult.failures.includes('DENIAL_CODE'));

    const unfinished = assessNoFallback({ events: [{ kind: 'incoming-start', pid: 1, requestId: 7, method: 'POST', pathname: '/api/ai/chat' }], denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 0, usageDelta: 0, newSucceeded: false });
    assert.ok(unfinished.failures.includes('OBSERVER_REQUEST_UNFINISHED'));

    const forbidden = assessNoFallback({
      events: finishedEvents(400).concat([{ kind: 'https-request', hostname: 'api.deepseek.com', pathname: '/v1/chat/completions', method: 'POST' }]),
      denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 0, usageDelta: 0, newSucceeded: false
    });
    assert.ok(forbidden.failures.includes('FORBIDDEN_OUTBOUND'));

    const billed = assessNoFallback({ events: finishedEvents(400), denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 1, usageDelta: 1, newSucceeded: true });
    assert.ok(['UPSTREAM_DELTA', 'USAGE_DELTA', 'UNEXPECTED_SUCCEEDED_USAGE'].every(code => billed.failures.includes(code)));

    const spawned = assessNoFallback({ events: finishedEvents(400).concat([{ kind: 'child-process', operation: 'spawn' }]), denial, expectedCode: 'QUOTA_EXCEEDED', upstreamDelta: 0, usageDelta: 0, newSucceeded: false });
    assert.ok(spawned.failures.includes('CHILD_PROCESS'));

    const result = {
      evidenceClass: 'SYNTHETIC_DRIVER_PREFLIGHT',
      usableAccountOrByokAcceptance: 'BLOCKED',
      reason: 'SYNTHETIC_CREDENTIALS_ARE_NOT_A_LIVE_COMPETING_CONNECTION',
      loopback: base,
      submitted: true,
      observedCode: denial.code,
      httpStatus: denial.httpStatus,
      observerFinished: true,
      forbiddenAttempts: 0,
      upstreamDelta: 0,
      usageDelta: 0,
      silentFallbackRejected: true,
      nonCallableSyntheticByokRejected: true,
      unfinishedObserverRejected: true,
      forbiddenOutboundRejected: true,
      unexpectedBillingRejected: true,
      childProcessRejected: true,
      electron: 'NOT_RUN',
      realModel: 'NOT_RUN',
      publicGateway: 'NOT_RUN',
      comingSoon: 'UNCHANGED'
    };
    const directory = path.join(__dirname, '../../.tmp/managed-closure-ready/preflight-no-fallback');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }));
  process.exitCode = 1;
});
