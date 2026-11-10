'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const taskDir = path.join(root, '.tmp/managed-closure-ready');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(file, value) {
  const temporary = file + '.new';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function runId(value) {
  const id = value || read(path.join(taskDir, 'latest.json')).runId;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('INVALID_RUN_ID');
  return id;
}
const runDir = id => path.join(taskDir, 'runs', runId(id));
function baseline() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { head: git(['rev-parse', 'HEAD']).trim(), branch: git(['branch', '--show-current']).trim(), diffSha256: sha(git(['diff', '--binary', 'HEAD'])), statusSha256: sha(git(['status', '--porcelain=v1'])) };
}
function prepare() {
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(taskDir, 'runs'), { recursive: true });
  const directory = runDir(id);
  fs.mkdirSync(directory);
  for (const name of ['keys', 'evidence', 'test-tmp']) fs.mkdirSync(path.join(directory, name));
  const manifest = { runId: id, runDir: directory, status: 'PREPARED', createdAt: new Date().toISOString(), baseline: baseline(), database: path.join(directory, 'hosted.db'), nativeRoot: path.join(directory, 'native'), evidenceBoundary: 'SYNTHETIC_LOOPBACK_ONLY', desktop: 'NOT_RUN' };
  save(path.join(directory, 'manifest.json'), manifest);
  save(path.join(taskDir, 'latest.json'), { runId: id });
  return manifest;
}
async function poll(probe, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw new Error('OBSERVATION_DEADLINE');
}
async function jsonHttp(base, pathname, token, body, method = body === undefined ? 'GET' : 'POST') {
  const destination = new URL(base);
  if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1' || destination.username || destination.password || destination.search || destination.hash) throw new Error('LOOPBACK_REQUIRED');
  const response = await fetch(new URL(pathname, destination), { method, redirect: 'error', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { throw new Error('NON_JSON_RESPONSE'); }
  return { status: response.status, body: value };
}
async function rpc(id, operation, data = {}) {
  const directory = runDir(id);
  const manifest = read(path.join(directory, 'manifest.json'));
  const credentials = read(path.join(directory, 'credentials.json'));
  const result = await jsonHttp(manifest.control, '/' + operation, credentials.control, data);
  if (result.status !== 200) throw new Error('CONTROL_' + result.status + '_' + (result.body?.code || 'FAILED'));
  return result.body;
}
async function start(id) {
  const directory = runDir(id);
  const file = path.join(directory, 'manifest.json');
  const manifest = read(file);
  if (!['PREPARED', 'STOPPED'].includes(manifest.status)) throw new Error('PREPARE_NEW_RUN_OR_STOP_OWN_RUN_FIRST');
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[name] !== undefined) environment[name] = process.env[name];
  environment.TEMP = environment.TMP = path.join(directory, 'test-tmp');
  const output = fs.openSync(path.join(directory, 'fixture.log'), 'a');
  const child = spawn(process.execPath, [__filename, 'serve', manifest.runId], { cwd: root, env: environment, detached: true, windowsHide: true, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  let spawnError = false;
  child.on('error', () => { spawnError = true; });
  child.unref();
  try {
    return await poll(async () => {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('FIXTURE_START_FAILED_SEE_LOCAL_LOG');
      const current = read(file);
      if (current.status === 'CLEANUP_FAILURE') throw new Error('FIXTURE_START_FAILED_SEE_LOCAL_LOG');
      if (current.status !== 'READY' || current.pid !== child.pid) return false;
      await rpc(id, 'health');
      return current;
    }, 30000);
  } catch (error) {
    try { await rpc(id, 'stop'); } catch { child.kill(); }
    throw error;
  }
}
async function serve(id) {
  const directory = runDir(id);
  const manifestFile = path.join(directory, 'manifest.json');
  let manifest = read(manifestFile);
  const servers = [];
  const active = new Set();
  const held = new Map();
  let store, releaseOwnership, stopping = false;
  let upstreamCount = 0, hostedCount = 0, mode = 'success';
  let reply = '{"message":"synthetic fixture response"}';
  const upstreamCalls = [], hostedRequests = [], loadedSources = {};
  function tracked(service) {
    return { handle(request) {
      const entry = { seq: ++hostedCount, method: request.method, path: new URL(request.url).pathname, at: Date.now() };
      hostedRequests.push(entry);
      if (hostedRequests.length > 5000) hostedRequests.shift();
      const promise = service.handle(request);
      active.add(promise);
      promise.then(response => { entry.status = response.status; active.delete(promise); }, () => { entry.status = 500; active.delete(promise); });
      return promise;
    } };
  }
  async function listen(server) {
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || address.address !== '127.0.0.1') throw new Error('NON_LOOPBACK_LISTENER');
    return 'http://127.0.0.1:' + address.port;
  }
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const item of held.values()) item.response.destroy();
    held.clear();
    try {
      await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
      await Promise.race([Promise.allSettled([...active]), new Promise((_, reject) => setTimeout(() => reject(new Error('CLEANUP_DEADLINE')), 10000))]);
      store?.close();
      releaseOwnership?.();
      manifest = { ...manifest, status: code ? 'CLEANUP_FAILURE' : 'STOPPED', stoppedAt: new Date().toISOString() };
      save(manifestFile, manifest);
    } catch {
      code = 1;
      save(manifestFile, { ...manifest, status: 'CLEANUP_FAILURE', stoppedAt: new Date().toISOString() });
    }
    process.exit(code);
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    const ts = require(path.join(root, 'node_modules/typescript'));
    require.extensions['.ts'] = function(module, filename) {
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('TS_SOURCE_OUTSIDE_WORKTREE');
      const source = fs.readFileSync(filename, 'utf8');
      loadedSources[relative.replaceAll('\\', '/')] = sha(source);
      const result = ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
      module._compile(result.outputText, filename);
    };
    const servicePath = path.join(root, 'services/managed-ai/src');
    const { HostedStore } = require(path.join(servicePath, 'store.ts'));
    const { ModelCatalog, validateCatalog } = require(path.join(servicePath, 'catalog.ts'));
    const { PlanAuthority, validatePlanConfig } = require(path.join(servicePath, 'plan.ts'));
    const { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } = require(path.join(servicePath, 'gateway.ts'));
    const { HostedManagedService } = require(path.join(servicePath, 'service.ts'));
    const { createHostedServer } = require(path.join(servicePath, 'http.ts'));
    const { OperatorStore } = require(path.join(servicePath, 'operator/store.ts'));
    const { OperatorService } = require(path.join(servicePath, 'operator/service.ts'));
    const { acquireServiceOwnership } = require(path.join(servicePath, 'service-ownership.ts'));
    const catalogConfig = validateCatalog({ revision: 'closure-synthetic-1', managedAiEnabled: true, defaultModelKey: 'vocatrya-fast', models: [{ modelKey: 'vocatrya-fast', displayName: 'Synthetic Beta Model', upstreamModelId: 'fixture-model-v1', mappingRevision: 'fixture-mapping-1', enabled: true, planRequirement: null, sortOrder: 0, maxInputTokens: 128000, maxOutputTokens: 1024, capabilities: { text: true, streaming: true, structuredOutput: true, tools: false } }] });
    const planConfig = validatePlanConfig({ revision: 'closure-synthetic-plans-1', plans: [{ planKey: 'beta', periodQuotaUnits: 1000 }, { planKey: 'edge', periodQuotaUnits: 1 }].map(plan => ({ ...plan, managedAiEnabled: true, allowedModels: ['vocatrya-fast'], modelUsageUnits: { 'vocatrya-fast': 1 } })) }, new Set(['vocatrya-fast']));
    save(path.join(directory, 'catalog.json'), catalogConfig);
    save(path.join(directory, 'plans.json'), planConfig);
    releaseOwnership = acquireServiceOwnership(manifest.database);
    store = new HostedStore(manifest.database);
    const recovered = store.recoverRunning();
    const operatorStore = new OperatorStore(store.internalDb());
    const credentialsFile = path.join(directory, 'credentials.json');
    let credentials;
    if (fs.existsSync(credentialsFile)) credentials = read(credentialsFile);
    else {
      const issued = operatorStore.createCredential('closure-fixture-only', { credentialId: 'closure-fixture-bootstrap' });
      credentials = { credential: issued.secret, control: crypto.randomBytes(32).toString('base64url'), upstream: crypto.randomBytes(32).toString('base64url') };
      save(credentialsFile, credentials);
    }
    function sendModel(response, payload) {
      if (response.destroyed) return;
      if (payload.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ model: 'fixture-model-v1', choices: [{ delta: { content: reply }, finish_reason: null }] }) + '\n\n');
        response.write('data: ' + JSON.stringify({ model: 'fixture-model-v1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'fixture-model-v1', choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
      }
    }
    const upstream = await listen(http.createServer(async (request, response) => {
      try {
        if (request.method === 'HEAD' && request.url === '/') { response.writeHead(200); response.end(); return; }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
        let text = '';
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('BODY_LIMIT'); }
        const payload = JSON.parse(text);
        const sequence = ++upstreamCount;
        upstreamCalls.push({ seq: sequence, at: Date.now(), mode, model: payload.model, stream: payload.stream === true });
        if (upstreamCalls.length > 5000) upstreamCalls.shift();
        if (request.headers.authorization !== 'Bearer ' + credentials.upstream) { response.writeHead(401); response.end('{}'); return; }
        if (mode === 'hold') {
          held.set(sequence, { response, payload });
          response.on('close', () => held.delete(sequence));
          return;
        }
        if (mode === 'drop') { response.destroy(); return; }
        if (/^http(401|429|500)$/.test(mode)) { response.writeHead(Number(mode.slice(4)), { 'content-type': 'application/json' }); response.end('{}'); return; }
        if (mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{bad-json'); return; }
        sendModel(response, payload);
      } catch { if (!response.headersSent) response.writeHead(400); response.end('{}'); }
    }));
    const plans = new PlanAuthority(planConfig);
    const operatorService = new OperatorService(store, operatorStore, catalogConfig, plans, { label: 'SYNTHETIC_LOOPBACK_ONLY', baseUrl: upstream + '/v1' });
    const operator = await listen(createHostedServer(operatorService));
    async function operatorCall(pathname, body, method) {
      const login = await jsonHttp(operator, '/operator/v1/session', null, { credential: credentials.credential });
      if (login.status !== 200) throw new Error('OPERATOR_LOGIN_FAILED');
      const result = await jsonHttp(operator, pathname, login.body.token, body, method);
      if (result.status !== 200) throw new Error('OPERATOR_' + result.status + '_' + (result.body?.code || 'FAILED'));
      return result.body;
    }
    const hostedService = new HostedManagedService(store, new ModelCatalog(catalogConfig, VERIFIED_GATEWAY_CAPABILITIES), plans, new ManagedGatewayRuntime({ baseUrl: upstream + '/v1', apiKey: credentials.upstream, allowLoopbackForTests: true, timeoutMs: 15000 }), { unknownSettlementGraceMs: 1000 });
    const hosted = await listen(createHostedServer(tracked(hostedService)));
    async function issue(user, ttlMs) {
      if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > 604800000)) throw new Error('TTL_OUTSIDE_CONTRACT');
      const result = await operatorCall('/operator/v1/users/' + encodeURIComponent(user) + '/sessions', ttlMs === undefined ? {} : { ttlMs });
      const keyFile = path.join(directory, 'keys', sha(user) + '.json');
      save(keyFile, { hostedUserId: user, token: result.token, expiresAt: result.expiresAt });
      return { hostedUserId: user, keyFile, expiresAt: result.expiresAt };
    }
    await operatorCall('/operator/v1/users', { hostedUserId: 'desktop-beta' });
    if (!store.subscription('desktop-beta')) {
      const now = Date.now();
      await operatorCall('/operator/v1/users/desktop-beta/subscription/provision', { planKey: 'beta', periodStart: now - 1000, periodEnd: now + 86400000, idempotencyKey: crypto.randomUUID() });
    }
    const defaultKeyFile = path.join(directory, 'keys', sha('desktop-beta') + '.json');
    if (!fs.existsSync(defaultKeyFile)) await issue('desktop-beta');
    function state() {
      const database = store.internalDb();
      return { runId: manifest.runId, pid: process.pid, mode, upstreamCount, hostedCount, heldCount: held.size, upstreamCalls, hostedRequests, subscriptions: database.prepare('SELECT hostedUserId,planKey,status,periodStart,periodEnd,revision FROM Subscription ORDER BY hostedUserId').all(), quotas: database.prepare('SELECT hostedUserId,periodStart,periodEnd,planKey,planRevision,quotaLimitUnits,reservedUnits,committedUnits FROM ManagedAiQuotaPeriod ORDER BY createdAt').all(), usage: database.prepare('SELECT hostedUserId,operationId,invocationKey,status,settlement,reservedUnits,chargedUnits,inputTokens,outputTokens,errorCategory,createdAt,completedAt FROM ManagedAiUsage ORDER BY createdAt,rowid').all() };
    }
    const control = await listen(http.createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
      if (request.method !== 'POST' || request.headers.origin || request.headers.authorization !== 'Bearer ' + credentials.control) { send(403, { code: 'CONTROL_AUTH_REQUIRED' }); return; }
      try {
        let text = '';
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('BODY_LIMIT'); }
        const data = JSON.parse(text || '{}');
        const operation = request.url;
        let result;
        if (operation === '/health') {
          const identity = await jsonHttp(hosted, '/v1/session');
          if (identity.status !== 401) throw new Error('HOSTED_AUTH_HEALTH_FAILED');
          await operatorCall('/operator/v1/overview');
          const probe = await fetch(upstream + '/', { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(3000) });
          if (probe.status !== 200 || servers.some(server => server.address()?.address !== '127.0.0.1')) throw new Error('LISTENER_HEALTH_FAILED');
          result = { healthy: true, pid: process.pid, runId: manifest.runId, boundary: 'SYNTHETIC_LOOPBACK_ONLY' };
        } else if (operation === '/state') result = state();
        else if (operation === '/user') result = await operatorCall('/operator/v1/users', { hostedUserId: data.user });
        else if (operation === '/issue') result = await issue(data.user, data.ttlMs);
        else if (operation === '/subscription') result = await operatorCall('/operator/v1/users/' + encodeURIComponent(data.user) + '/subscription/set', { planKey: data.plan, status: data.status, periodStart: data.start, periodEnd: data.end, idempotencyKey: data.idempotencyKey || crypto.randomUUID() });
        else if (operation === '/runtime') {
          if (typeof data.disabled !== 'boolean') throw new Error('BOOLEAN_REQUIRED');
          result = await operatorCall('/operator/v1/runtime/' + (data.disabled ? 'disable' : 'enable'), data.disabled ? { reason: 'synthetic-boundary-test' } : {});
        } else if (operation === '/mode') {
          if (!['success', 'hold', 'drop', 'http401', 'http429', 'http500', 'malformed'].includes(data.mode)) throw new Error('INVALID_MODE');
          if (data.reply !== undefined && (typeof data.reply !== 'string' || data.reply.length > 50000)) throw new Error('INVALID_REPLY');
          mode = data.mode;
          if (data.reply !== undefined) reply = data.reply;
          result = { mode };
        } else if (operation === '/release') {
          const items = [...held.values()]; held.clear(); mode = 'success';
          for (const item of items) sendModel(item.response, item.payload);
          result = { released: items.length, mode };
        } else if (operation === '/stop') {
          send(200, { stopping: true, pid: process.pid });
          setImmediate(() => void shutdown());
          return;
        } else { send(404, { code: 'CONTROL_NOT_FOUND' }); return; }
        send(200, result);
      } catch { send(400, { code: 'CONTROL_OPERATION_FAILED' }); }
    }));
    loadedSources['scripts/managed-closure-ready/fixture.cjs'] = sha(fs.readFileSync(__filename));
    manifest = { ...manifest, status: 'READY', pid: process.pid, startedAt: new Date().toISOString(), baseline: baseline(), sourceHashes: loadedSources, hosted, operator, upstream, control, recovered, unknownGraceMs: 1000, defaultKeyFile, desktopEnv: { VOCATRYA_HOSTED_ENDPOINT: hosted, VOCATRYA_DESKTOP_DATA_ROOT: manifest.nativeRoot, VOCATRYA_AB_RUNTIME_ENABLED: 'true', VOCATRYA_AB_ROLLOUT_SCOPE: 'full' } };
    save(manifestFile, manifest);
    console.log(JSON.stringify({ status: 'READY', runId: manifest.runId, pid: process.pid, hosted, operator, upstream, control }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'START_FAILED', error: error.code || error.name }));
    await shutdown(1);
  }
}
async function cli() {
  const [command, requestedId, ...args] = process.argv.slice(2);
  if (command === 'prepare') return prepare();
  const id = runId(requestedId);
  if (command === 'start') return start(id);
  if (command === 'serve') return serve(id);
  if (command === 'env') return read(path.join(runDir(id), 'manifest.json')).desktopEnv;
  if (['health', 'state', 'release'].includes(command)) return rpc(id, command);
  if (command === 'stop') {
    const result = await rpc(id, 'stop');
    await poll(() => {
      const state = read(path.join(runDir(id), 'manifest.json')).status;
      if (state === 'CLEANUP_FAILURE') throw new Error('CLEANUP_FAILURE');
      if (state !== 'STOPPED') return false;
      try { process.kill(result.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, 15000);
    return { status: 'STOPPED', pid: result.pid };
  }
  if (command === 'user') return rpc(id, 'user', { user: args[0] });
  if (command === 'issue') return rpc(id, 'issue', { user: args[0], ...(args[1] === undefined ? {} : { ttlMs: Number(args[1]) * 1000 }) });
  if (command === 'subscription') return rpc(id, 'subscription', { user: args[0], status: args[1], plan: args[2], start: Number(args[3]), end: Number(args[4]) });
  if (command === 'runtime') { if (!['disabled', 'enabled'].includes(args[0])) throw new Error('INVALID_RUNTIME_ARGUMENT'); return rpc(id, 'runtime', { disabled: args[0] === 'disabled' }); }
  if (command === 'mode') return rpc(id, 'mode', { mode: args[0], ...(args[1] === undefined ? {} : { reply: args[1] }) });
  throw new Error('UNKNOWN_COMMAND');
}
module.exports = { root, taskDir, runId, runDir, read, save, poll, rpc, jsonHttp };
if (require.main === module) cli().then(value => { if (value !== undefined) console.log(JSON.stringify(value, null, 2)); }).catch(error => { console.error(JSON.stringify({ status: 'FAIL', error: error.code || error.message || error.name })); process.exitCode = 1; });
