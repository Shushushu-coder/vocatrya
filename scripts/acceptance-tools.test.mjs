import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { safeRun, ROOT } from './p2-closure-ready/package.mjs';

const require = createRequire(import.meta.url);
const fixture = require('./managed-closure-ready/fixture.cjs');

test('managed runtime paths remain in ignored data directory after script relocation', () => {
  assert.equal(fixture.taskDir, path.join(ROOT, '.tmp/managed-closure-ready'));
  const id = randomUUID();
  assert.equal(fixture.runDir(id), path.join(fixture.taskDir, 'runs', id));
  assert.throws(() => fixture.runDir('../../outside'), /INVALID_RUN_ID/);
});

test('P2 rejects source, parent and sibling directories as writable runs', () => {
  for (const candidate of ['src', '.tmp/p2-closure-ready/runs', '../outside', '.tmp/managed-closure-ready/runs/example']) {
    assert.throws(() => safeRun(candidate), /Run must be below/);
  }
  assert.equal(safeRun('.tmp/p2-closure-ready/runs/example'), path.join(ROOT, '.tmp/p2-closure-ready/runs/example'));
});

test('managed HTTP helper rejects external endpoints before issuing a request', async () => {
  await assert.rejects(() => fixture.jsonHttp('https://example.invalid', '/', null), /LOOPBACK_REQUIRED/);
  await assert.rejects(() => fixture.jsonHttp('http://127.0.0.1@elsewhere.invalid', '/', null), /LOOPBACK_REQUIRED/);
});

test('P2 observer blocks remote fetch before dispatch and records only request metadata', () => {
  const directory = path.join(ROOT, '.tmp/acceptance-tools-check', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'observer.ndjson');
  const observer = fileURLToPath(new URL('./p2-closure-ready/backend-observer.cjs', import.meta.url));
  const code = `
    const assert = require('node:assert/strict');
    let calls = 0;
    global.fetch = () => { calls++; return Promise.resolve(); };
    require(${JSON.stringify(observer)}).install({file: ${JSON.stringify(file)}});
    assert.throws(() => fetch('https://example.invalid/private?secret=private-value', {headers: {authorization: 'private-token'}}), /refused non-loopback/);
    assert.equal(calls, 0);
    fetch('http://127.0.0.1/test');
    assert.equal(calls, 1);
  `;
  execFileSync(process.execPath, ['-e', code], { cwd: ROOT, windowsHide: true });
  const text = fs.readFileSync(file, 'utf8');
  assert(!text.includes('private-value'));
  assert(!text.includes('private-token'));
  const requests = text.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'fetch');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].hostname, 'example.invalid');
  assert.equal(requests[1].hostname, '127.0.0.1');
});
