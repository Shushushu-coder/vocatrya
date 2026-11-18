'use strict';
// Shared denial and observer checks for the managed no-fallback scenario.
// Synthetic results from no-fallback-preflight.cjs are driver checks only.
// They do not accept a usable account or BYOK connection.

const OUTBOUND = ['fetch', 'undici', 'http-request', 'https-request', 'socket'];

function captureDenial(httpStatus, bodyText) {
  const status = Number(httpStatus);
  if (!Number.isInteger(status)) return { httpStatus: null, code: null, captureError: 'MISSING_HTTP_STATUS' };
  if (typeof bodyText !== 'string') return { httpStatus: status, code: null, captureError: 'MISSING_BODY' };
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.code === 'string' && parsed.code.length > 0) {
    return { httpStatus: status, code: parsed.code, captureError: null };
  }
  const match = bodyText.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]*)"/);
  if (match) return { httpStatus: status, code: match[1], captureError: null };
  return { httpStatus: status, code: null, captureError: 'ERROR_CODE_NOT_IN_RESPONSE' };
}

function byokResolverCallable(row) {
  return !!row && row.iv === '' && typeof row.encryptedKey === 'string' && row.encryptedKey.length > 0;
}

function releaseCheck(event) {
  return event.hostname === 'api.github.com' && event.pathname === '/repos/Shushushu-coder/vocatrya/releases/latest' && event.method === 'GET';
}

function assessNoFallback({ events, denial, expectedCode, upstreamDelta, usageDelta, newSucceeded }) {
  const failures = [];
  const list = Array.isArray(events) ? events : [];
  if (!denial || denial.captureError || denial.code !== expectedCode) failures.push('DENIAL_CODE');
  const incoming = list.filter(event => event.kind === 'incoming-start' && event.pathname === '/api/ai/chat' && event.method === 'POST');
  if (incoming.length === 0) failures.push('OBSERVER_REQUEST_MISSING');
  const unfinished = incoming.some(request => !list.some(event => event.kind === 'incoming-finish' && event.pid === request.pid && event.requestId === request.requestId && event.status === denial?.httpStatus));
  if (unfinished) failures.push('OBSERVER_REQUEST_UNFINISHED');
  const outbound = list.filter(event => OUTBOUND.includes(event.kind));
  const forbidden = outbound.filter(event => (/^\/(internal|credential)\//i.test(String(event.pathname)) || (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(String(event.hostname)) && !releaseCheck(event))));
  if (forbidden.length > 0) failures.push('FORBIDDEN_OUTBOUND');
  const spawned = list.filter(event => event.kind === 'child-process');
  if (spawned.length > 0) failures.push('CHILD_PROCESS');
  if (upstreamDelta !== 0) failures.push('UPSTREAM_DELTA');
  if (usageDelta !== 0) failures.push('USAGE_DELTA');
  if (newSucceeded) failures.push('UNEXPECTED_SUCCEEDED_USAGE');
  return {
    ok: failures.length === 0,
    failures,
    expectedCode,
    observedCode: denial?.code ?? null,
    httpStatus: denial?.httpStatus ?? null,
    captureError: denial?.captureError ?? 'MISSING_DENIAL',
    observedBackendRequests: incoming.length,
    outboundEvents: outbound.length,
    toleratedReleaseChecks: outbound.filter(releaseCheck).length,
    forbiddenAttempts: forbidden.map(event => event.kind + ' ' + event.hostname + event.pathname),
    childProcesses: spawned.length,
    upstreamDelta,
    usageDelta,
    newSucceeded: newSucceeded === true
  };
}

module.exports = { captureDenial, byokResolverCallable, assessNoFallback };
