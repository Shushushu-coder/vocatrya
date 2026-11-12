'use strict';
// Backend outbound observer for the managed-closure desktop run. Injected as a
// generated prefix into the assembled backend server.js (test instrumentation
// only — product source is never modified). Every outbound attempt is logged
// BEFORE it connects; non-loopback destinations are refused. This is what
// proves a failed Managed invocation never silently reached an account-login
// or BYOK path: any such attempt would appear here as an exec-channel call or
// a refused non-loopback connection.
const fs = require('node:fs');
const dc = require('node:diagnostics_channel');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
exports.install = function install({ file }) {
  if (global.__managedObserver) throw new Error('Managed observer already installed');
  global.__managedObserver = true;
  let sequence = 0;
  const emit = value => fs.appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, ...value }) + '\n');
  const local = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname).toLowerCase());
  function target(input, fallback = 'http://localhost') {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url || input?.href || fallback, fallback);
      return { hostname: url.hostname, port: url.port, pathname: url.pathname };
    } catch { return { hostname: 'UNPARSEABLE', port: '', pathname: '' }; }
  }
  function outgoing(kind, info) {
    emit({ kind, ...info });
    if (!local(info.hostname)) throw new Error('Managed observer refused non-loopback outbound connection');
  }
  dc.channel('http.server.request.start').subscribe(({ request, response }) => {
    const id = ++sequence;
    const action = request.headers['next-action'];
    const metadata = { requestId: id, method: request.method, pathname: target(request.url, 'http://localhost').pathname, actionHash: action ? createHash('sha256').update(String(action)).digest('hex') : null };
    emit({ kind: 'incoming-start', ...metadata });
    response.once('finish', () => emit({ kind: 'incoming-finish', ...metadata, status: response.statusCode }));
  });
  const originalFetch = global.fetch;
  if (originalFetch) global.fetch = function(input, options) {
    outgoing('fetch', { ...target(input), method: options?.method || input?.method || 'GET' });
    return originalFetch.apply(this, arguments);
  };
  dc.channel('undici:request:create').subscribe(({ request }) => emit({ kind: 'undici', ...target(String(request.origin) + request.path), method: request.method }));
  for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
    const original = module.request;
    module.request = function(input, options) {
      let info;
      if (typeof input === 'string' || input instanceof URL) info = target(input);
      else {
        const settings = input || {};
        info = { hostname: settings.hostname || settings.host || 'localhost', port: String(settings.port || ''), pathname: String(settings.path || '/').split('?')[0] };
      }
      outgoing(protocol === 'https:' ? 'https-request' : 'http-request', { ...info, method: options?.method || input?.method || 'GET' });
      return original.apply(this, arguments);
    };
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function() {
    let args = arguments[0];
    if (Array.isArray(args)) args = args[0];
    if (args && typeof args === 'object' && !args.path) outgoing('socket', { hostname: args.host || 'localhost', port: String(args.port || ''), pathname: '' });
    else if (typeof args === 'number') outgoing('socket', { hostname: typeof arguments[1] === 'string' ? arguments[1] : 'localhost', port: String(args), pathname: '' });
    return originalConnect.apply(this, arguments);
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = cp[name];
    cp[name] = function() {
      emit({ kind: 'child-process', operation: name });
      return original.apply(this, arguments);
    };
  }
  emit({ kind: 'observer-ready', coverage: ['fetch', 'undici', 'http-request', 'https-request', 'socket', 'child-process', 'incoming'], nonLoopback: 'refused-before-connect' });
};
