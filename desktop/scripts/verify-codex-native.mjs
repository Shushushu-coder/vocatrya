#!/usr/bin/env node
// Verifies that a Codex CLI binary is safe to add to NATIVE_VERIFIED_VERSIONS
// (desktop/main/runtime/native-session.js). No account credentials, no network:
// a fake Responses provider AND a fake streamable_http MCP bridge on 127.0.0.1
// plus a temp CODEX_HOME stand in for the real services. For every
// NATIVE_MODELS entry it runs the production runNativeSession against the
// binary and asserts:
//   (a) the version the binary reports (--version and app-server handshake) agrees;
//   (b) the effective config read back from app-server enables live web_search,
//       keeps shell/apps/code-mode/etc. features off, and carries EXACTLY the
//       single-key vocatrya_business mcp_servers entry bound to our loopback URL;
//   (c) the MCP bridge handshake arrives with the per-turn bearer token;
//   (d) a turn round-trips through the fake provider with synthetic web_search_call
//       items, the provider request exposes only the expected tool surface
//       (web_search + codex builtin MCP resource/discovery tools — never
//       shell/apply_patch/exec or any mcp__ business call), and normalized
//       native-event search events + sources round-trip;
//   (e) a second run with an inherited third-party mcp_servers key in the
//       profile config.toml fails NATIVE_BOUNDARY_NOT_READY before any turn;
//   (f) a provider-driven call to a non-bridge MCP tool (codex builtin
//       list_mcp_resources, server "codex") fails NATIVE_UNEXPECTED_TOOL.
// Usage: node desktop/scripts/verify-codex-native.mjs [--binary <path>] [--expect-version <v>] [--out <file>]
// Prints a JSON report; exit 0 only when every check passed.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "main", "runtime");
const nativeMod = require(path.join(runtimeDir, "native-session.js"));
const { codexAdapter } = require(path.join(runtimeDir, "codex.js"));
const { getRuntimeDefinition } = require(path.join(runtimeDir, "registry.js"));
const { findRuntimeExecutable, probeRuntimeVersion } = require(path.join(runtimeDir, "detector.js"));
const { runRuntimeCommand } = require(path.join(runtimeDir, "runner.js"));
const { NATIVE_MODELS, NATIVE_VERIFIED_VERSIONS, NATIVE_CONFIG, NATIVE_MCP_SERVER_KEY, NATIVE_MCP_TOKEN_ENV, runNativeSession, reportedCodexVersion } = nativeMod;

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const FAKE_TEXT = "vocatrya-native-verify-ok";
const FAKE_MCP_TOKEN = "nbt_verify_token_not_a_credential";
const FEATURES_OFF = ["shell_tool", "view_image", "multi_agent", "multi_agent_v2", "apps", "code_mode", "code_mode_host", "browser_use", "computer_use", "image_generation", "skill_search", "goals", "memories", "remote_plugin", "tool_suggest", "mentions_v2"];
// The only provider-visible tool surface a locked-down native session may offer.
const ALLOWED_PROVIDER_TOOLS = new Set(["web_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "tool_search"]);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return Boolean(ok); };

function resolveBinary() {
  const explicit = arg("--binary");
  if (explicit) return { executable: path.resolve(explicit), source: "--binary" };
  const definition = getRuntimeDefinition("CODEX_RUNTIME");
  const raw = findRuntimeExecutable(definition, { platform: process.platform, env: process.env, spawnSyncImpl: spawnSync, existsSyncImpl: fs.existsSync });
  const executable = raw ? codexAdapter.resolveExecutable(raw, {}) : null;
  return { executable, source: "app resolution (known locations, then PATH)", raw };
}

// Minimal streamable_http MCP server: answers initialize / notifications /
// tools/list / resources/list with a single fake business tool, recording
// every request's method + authorization header so the bearer contract is
// verified, not assumed.
function startFakeMcp() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = Buffer.concat(chunks).toString("utf8"); body = body ? JSON.parse(body) : null; } catch { body = null; }
      const entries = Array.isArray(body) ? body : body ? [body] : [];
      for (const m of entries) log.push({ method: m.method, authorization: req.headers.authorization ?? null });
      const reply = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const first = entries[0];
      if (!first || first.method === "notifications/initialized" || first.method === "initialized" || first.id === undefined) {
        res.writeHead(202, { "content-type": "application/json" });
        res.end();
      } else if (first.method === "initialize") {
        reply({ jsonrpc: "2.0", id: first.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "vocatrya-verify-mcp", version: "0" } } });
      } else if (first.method === "tools/list") {
        reply({ jsonrpc: "2.0", id: first.id, result: { tools: [{ name: "list_jobs", description: "List the user's jobs (read-only)", inputSchema: { type: "object" } }] } });
      } else if (first.method === "resources/list" || first.method === "resources/templates/list") {
        reply({ jsonrpc: "2.0", id: first.id, result: { resources: [], resourceTemplates: [] } });
      } else if (first.method === "tools/call") {
        reply({ jsonrpc: "2.0", id: first.id, result: { content: [{ type: "text", text: "{\"status\":\"ok\"}" }] } });
      } else {
        reply({ jsonrpc: "2.0", id: first.id, error: { code: -32601, message: "unsupported" } });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log, port: server.address().port })));
}

function startFakeProvider(mode = "search") {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* keep null */ }
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === "POST" && /\/responses$/.test(req.url)) {
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        send("response.created", { response: { id: "resp_v1" } });
        if (mode === "mcp-call") {
          // A model-emitted call to a NON-bridge builtin MCP tool: codex
          // executes it client-side and reports an mcpToolCall item whose
          // server is "codex" — the boundary must reject it.
          send("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_v1", call_id: "call_v1", name: "list_mcp_resources", arguments: "{}", status: "in_progress" } });
          send("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_v1", call_id: "call_v1", name: "list_mcp_resources", arguments: "{}", status: "completed" } });
          send("response.output_item.added", { output_index: 1, item: { type: "message", role: "assistant", id: "msg_v1", content: [] } });
          send("response.output_text.delta", { item_id: "msg_v1", output_index: 1, content_index: 0, delta: FAKE_TEXT });
          send("response.output_item.done", { output_index: 1, item: { type: "message", role: "assistant", id: "msg_v1", content: [{ type: "output_text", text: FAKE_TEXT }] } });
        } else {
          send("response.output_item.added", { output_index: 0, item: { type: "web_search_call", id: "ws_verify_1", status: "in_progress", action: { type: "search", query: "vocatrya verify query" } } });
          send("response.output_item.done", { output_index: 0, item: { type: "web_search_call", id: "ws_verify_1", status: "completed", action: { type: "search", query: "vocatrya verify query", queries: ["vocatrya verify query"] } } });
          send("response.output_item.added", { output_index: 1, item: { type: "web_search_call", id: "ws_verify_2", status: "in_progress", action: { type: "open_page", url: "https://example.test/vocatrya-verify" } } });
          send("response.output_item.done", { output_index: 1, item: { type: "web_search_call", id: "ws_verify_2", status: "completed", action: { type: "open_page", url: "https://example.test/vocatrya-verify" } } });
          send("response.output_item.added", { output_index: 2, item: { type: "message", role: "assistant", id: "msg_v1", content: [] } });
          send("response.output_text.delta", { item_id: "msg_v1", output_index: 2, content_index: 0, delta: FAKE_TEXT });
          send("response.output_item.done", { output_index: 2, item: { type: "message", role: "assistant", id: "msg_v1", content: [{ type: "output_text", text: FAKE_TEXT }] } });
        }
        send("response.completed", { response: { id: "resp_v1", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
        res.end();
      } else { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

const nativeMcpFor = (port, tools = ["list_jobs"]) => ({
  url: `http://127.0.0.1:${port}/mcp`,
  bearerTokenEnvVar: NATIVE_MCP_TOKEN_ENV,
  token: FAKE_MCP_TOKEN,
  allowedTools: tools,
});

async function runProbe({ probe, executable, profileDir, cwd, baseEnv, model, fakePort, mcpPort, mcpLog, extraArgs = [] }) {
  const base = codexAdapter.buildStreamingInvocation({ executablePath: executable, profileDir, baseEnv, workingDirectory: cwd });
  const provider = `{name="vocatrya-verify",base_url="http://127.0.0.1:${fakePort}/v1",env_key="VOCATRYA_VERIFY_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`;
  const invocation = { ...base, env: { ...base.env, VOCATRYA_VERIFY_KEY: baseEnv.VOCATRYA_VERIFY_KEY, NO_PROXY: baseEnv.NO_PROXY, no_proxy: baseEnv.no_proxy },
    args: [...base.args, "-c", 'model_provider="vocatrya-verify"', "-c", `model_providers.vocatrya-verify=${provider}`, ...extraArgs] };
  let handshake = null; let config = null; let buffer = "";
  const tap = (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id === 1) handshake = m.result; if (m.id === 5) config = m.result?.config; } catch { /* not JSON */ }
    }
  };
  const runner = (opts) => runRuntimeCommand({ ...opts, onStdout: (chunk) => { tap(chunk); opts.onStdout?.(chunk); } });
  const emittedEvents = [];
  const result = await runNativeSession({ expectedVersion: probe.version, allowedVersions: [probe.version], invocation, model, prompt: "Reply with the verification phrase.", instructions: "Verification run.", profileDir, timeoutMs: 60000, nativeMcp: nativeMcpFor(mcpPort), onEvent: (e) => emittedEvents.push(e), runner });
  return { result, emittedEvents, handshake, config };
}

async function main() {
  const report = { tool: "verify-codex-native", at: new Date().toISOString(), binary: null, binarySource: null, cliVersion: null, handshakeVersion: null, listedBefore: [...NATIVE_VERIFIED_VERSIONS], models: [], checks, ok: false };
  const finish = (code) => { report.ok = checks.length > 0 && checks.every((c) => c.ok); const text = JSON.stringify(report, null, 2); if (arg("--out")) fs.writeFileSync(arg("--out"), text); console.log(text); process.exit(report.ok ? 0 : code); };
  const { executable, source } = resolveBinary();
  report.binary = executable; report.binarySource = source;
  if (!check("binary-resolved", executable && fs.existsSync(executable), executable)) return finish(2);
  const probe = probeRuntimeVersion(executable, getRuntimeDefinition("CODEX_RUNTIME"), { env: process.env, spawnSyncImpl: spawnSync });
  report.cliVersion = probe.version;
  if (!check("cli-version-reported", probe.ok && probe.version, probe.version)) return finish(2);
  if (arg("--expect-version")) check("cli-version-matches-expected", probe.version === arg("--expect-version"), { expected: arg("--expect-version"), actual: probe.version });

  const fake = await startFakeProvider();
  const fakeMcp = await startFakeMcp();
  const fakeMcpCall = await startFakeProvider("mcp-call");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-verify-codex-"));
  const profileDir = path.join(root, "codex-home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(profileDir, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const baseEnv = { ...process.env, VOCATRYA_VERIFY_KEY: "loopback-not-a-credential", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete baseEnv[key];
  try {
    for (const model of NATIVE_MODELS) {
      const entry = { model, ok: false };
      report.models.push(entry);
      const before = fake.requests.length;
      const mcpBefore = fakeMcp.log.length;
      const { result, emittedEvents, handshake, config } = await runProbe({ probe, executable, profileDir, cwd, baseEnv, model, fakePort: fake.port, mcpPort: fakeMcp.port });
      const received = fake.requests.slice(before).filter((r) => r.method === "POST" && /\/responses$/.test(r.url));
      const mcpRequests = fakeMcp.log.slice(mcpBefore);
      const body = received.at(-1)?.body;
      const tools = body?.tools;
      const toolNames = Array.isArray(tools) ? tools.map((t) => t?.name ?? t?.type ?? "?") : [];
      const searchEvents = emittedEvents.filter((e) => e.type === "native-event" && e.kind === "search" && e.payload?.status === "completed");
      entry.reportedVersion = reportedCodexVersion(handshake?.userAgent);
      report.handshakeVersion ??= entry.reportedVersion;
      entry.requests = received.length;
      entry.toolsSent = toolNames;
      entry.searchEvents = searchEvents.map((e) => ({ actionType: e.payload?.actionType, query: e.payload?.query, sources: e.payload?.sources?.map((s) => s.url) }));
      entry.mcpRequests = mcpRequests.map((r) => r.method);
      const mcpServerKeys = config?.mcp_servers && typeof config.mcp_servers === "object" ? Object.keys(config.mcp_servers) : [];
      const mcpEntry = config?.mcp_servers?.[NATIVE_MCP_SERVER_KEY];
      entry.effectiveConfig = config ? { web_search: config.web_search, project_doc_max_bytes: config.project_doc_max_bytes, include_environment_context: config.include_environment_context, mcp_servers: mcpServerKeys, features: Object.fromEntries(FEATURES_OFF.map((n) => [n, config.features?.[n]])) } : null;
      const tag = (n) => `${model}: ${n}`;
      const a = check(tag("handshake-version-matches-cli"), entry.reportedVersion === probe.version, { cli: probe.version, handshake: entry.reportedVersion });
      const b = check(tag("effective-config-tools-off"), config && config.web_search === "live" && FEATURES_OFF.every((n) => config.features?.[n] === false) &&
        mcpServerKeys.length === 1 && mcpServerKeys[0] === NATIVE_MCP_SERVER_KEY &&
        mcpEntry && mcpEntry.url === `http://127.0.0.1:${fakeMcp.port}/mcp` && mcpEntry.bearer_token_env_var === NATIVE_MCP_TOKEN_ENV &&
        [config.plugins, config.hooks, config.skills].every((v) => !v || Object.keys(v).length === 0) && config.model_catalog_json, entry.effectiveConfig);
      const mcpAuthOk = mcpRequests.length >= 2 && mcpRequests.every((r) => r.authorization === `Bearer ${FAKE_MCP_TOKEN}`) && mcpRequests.some((r) => r.method === "initialize") && mcpRequests.some((r) => r.method === "tools/list");
      const c = check(tag("turn-round-trips"), result.ok === true && result.text === FAKE_TEXT, { ok: result.ok, code: result.code });
      const d = check(tag("provider-request-model"), body?.model === model, body?.model);
      const e = check(tag("provider-request-allowed-tools"), received.length >= 1 && Array.isArray(tools) && tools.length >= 1 && toolNames.every((n) => ALLOWED_PROVIDER_TOOLS.has(n)) && toolNames.includes("web_search"), entry.toolsSent);
      const f = check(tag("native-search-events-round-trip"), searchEvents.some((ev) => ev.payload?.actionType === "search" && ev.payload?.query === "vocatrya verify query") &&
        searchEvents.some((ev) => ev.payload?.actionType === "open_page" && ev.payload?.sources?.some((s) => s.url === "https://example.test/vocatrya-verify")), entry.searchEvents);
      const g = check(tag("mcp-bridge-handshake-authenticated"), mcpAuthOk, entry.mcpRequests);
      entry.ok = a && b && c && d && e && f && g;
    }
    // (e) Inherited third-party mcp_servers key in the profile config.toml:
    // the single-key allowlist must fail the boundary before any turn.
    {
      const inheritedDir = path.join(root, "codex-home-inherited");
      fs.mkdirSync(inheritedDir, { recursive: true });
      fs.writeFileSync(path.join(inheritedDir, "config.toml"), `[mcp_servers.inherited]\ncommand = "echo"\n`);
      const { result } = await runProbe({ probe, executable, profileDir: inheritedDir, cwd, baseEnv, model: NATIVE_MODELS[0], fakePort: fake.port, mcpPort: fakeMcp.port });
      check("inherited-mcp-server-blocked", result.ok === false && result.code === "NATIVE_BOUNDARY_NOT_READY", { code: result.code });
    }
    // (f) Provider-driven call to a non-bridge MCP tool must fail closed even
    // though codex itself can execute it client-side.
    {
      const { result } = await runProbe({ probe, executable, profileDir, cwd, baseEnv, model: NATIVE_MODELS[0], fakePort: fakeMcpCall.port, mcpPort: fakeMcp.port });
      check("non-bridge-mcpToolCall-blocked", result.ok === false && result.code === "NATIVE_UNEXPECTED_TOOL", { code: result.code });
    }
    // Missing/invalid bridge descriptors fail before spawn, never degrade.
    {
      const base = codexAdapter.buildStreamingInvocation({ executablePath: executable, profileDir, baseEnv, workingDirectory: cwd });
      const missing = await runNativeSession({ expectedVersion: probe.version, allowedVersions: [probe.version], invocation: base, model: NATIVE_MODELS[0], prompt: "x", instructions: "x", profileDir, timeoutMs: 5000, runner: runRuntimeCommand });
      const badUrl = await runNativeSession({ expectedVersion: probe.version, allowedVersions: [probe.version], invocation: base, model: NATIVE_MODELS[0], prompt: "x", instructions: "x", profileDir, timeoutMs: 5000, runner: runRuntimeCommand,
        nativeMcp: { url: "https://169.254.169.254/mcp", bearerTokenEnvVar: NATIVE_MCP_TOKEN_ENV, token: "t", allowedTools: ["list_jobs"] } });
      check("missing-or-remote-mcp-blocked", missing.ok === false && missing.code === "NATIVE_BOUNDARY_NOT_READY" && badUrl.ok === false && badUrl.code === "NATIVE_BOUNDARY_NOT_READY", { missing: missing.code, remote: badUrl.code });
    }
    check("nativeConfig-keys-covered", Object.keys(NATIVE_CONFIG).length > 0);
  } finally {
    fake.server.close();
    fakeMcp.server.close();
    fakeMcpCall.server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
  report.wouldAdd = checks.every((c) => c.ok) ? report.cliVersion : null;
  finish(1);
}

main().catch((error) => { console.log(JSON.stringify({ tool: "verify-codex-native", ok: false, error: String(error?.stack || error) }, null, 2)); process.exit(3); });
