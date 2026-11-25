#!/usr/bin/env node
// Verifies that a Codex CLI binary is safe to add to NATIVE_VERIFIED_VERSIONS
// (desktop/main/runtime/native-session.js). No account credentials, no network:
// a fake Responses provider on 127.0.0.1 and a temp CODEX_HOME stand in for
// the real service. For every NATIVE_MODELS entry it runs the production
// runNativeSession against the binary and asserts:
//   (a) the version the binary reports (--version and app-server handshake) agrees;
//   (b) the effective config read back from app-server enables live web_search,
//       keeps shell/apps/code-mode/etc. features off and no mcp/plugins/hooks/skills;
//   (c) a turn round-trips through the fake provider with synthetic web_search_call
//       items, the provider request exposes ONLY web_search (no shell/apply_patch/mcp),
//       and normalized native-event search events + sources round-trip.
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
const { NATIVE_MODELS, NATIVE_VERIFIED_VERSIONS, NATIVE_CONFIG, runNativeSession, reportedCodexVersion } = nativeMod;

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const FAKE_TEXT = "vocatrya-native-verify-ok";
const FEATURES_OFF = ["shell_tool", "view_image", "multi_agent", "multi_agent_v2", "apps", "code_mode", "code_mode_host", "browser_use", "computer_use", "image_generation", "skill_search", "goals", "memories", "remote_plugin", "tool_suggest", "mentions_v2"];
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

function startFakeProvider() {
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
        send("response.output_item.added", { output_index: 0, item: { type: "web_search_call", id: "ws_verify_1", status: "in_progress", action: { type: "search", query: "vocatrya verify query" } } });
        send("response.output_item.done", { output_index: 0, item: { type: "web_search_call", id: "ws_verify_1", status: "completed", action: { type: "search", query: "vocatrya verify query", queries: ["vocatrya verify query"] } } });
        send("response.output_item.added", { output_index: 1, item: { type: "web_search_call", id: "ws_verify_2", status: "in_progress", action: { type: "open_page", url: "https://example.test/vocatrya-verify" } } });
        send("response.output_item.done", { output_index: 1, item: { type: "web_search_call", id: "ws_verify_2", status: "completed", action: { type: "open_page", url: "https://example.test/vocatrya-verify" } } });
        send("response.output_item.added", { output_index: 2, item: { type: "message", role: "assistant", id: "msg_v1", content: [] } });
        send("response.output_text.delta", { item_id: "msg_v1", output_index: 2, content_index: 0, delta: FAKE_TEXT });
        send("response.output_item.done", { output_index: 2, item: { type: "message", role: "assistant", id: "msg_v1", content: [{ type: "output_text", text: FAKE_TEXT }] } });
        send("response.completed", { response: { id: "resp_v1", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
        res.end();
      } else { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-verify-codex-"));
  const profileDir = path.join(root, "codex-home");
  const cwd = path.join(root, "work");
  fs.mkdirSync(profileDir, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const baseEnv = { ...process.env, VOCATRYA_VERIFY_KEY: "loopback-not-a-credential", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete baseEnv[key];
  const provider = `{name="vocatrya-verify",base_url="http://127.0.0.1:${fake.port}/v1",env_key="VOCATRYA_VERIFY_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`;
  try {
    for (const model of NATIVE_MODELS) {
      const entry = { model, ok: false };
      report.models.push(entry);
      const before = fake.requests.length;
      const base = codexAdapter.buildStreamingInvocation({ executablePath: executable, profileDir, baseEnv, workingDirectory: cwd });
      const invocation = { ...base, env: { ...base.env, VOCATRYA_VERIFY_KEY: baseEnv.VOCATRYA_VERIFY_KEY, NO_PROXY: baseEnv.NO_PROXY, no_proxy: baseEnv.no_proxy },
        args: [...base.args, "-c", 'model_provider="vocatrya-verify"', "-c", `model_providers.vocatrya-verify=${provider}`] };
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
      const result = await runNativeSession({ expectedVersion: probe.version, allowedVersions: [probe.version], invocation, model, prompt: "Reply with the verification phrase.", instructions: "Verification run.", profileDir, timeoutMs: 60000, onEvent: (e) => emittedEvents.push(e), runner });
      const received = fake.requests.slice(before).filter((r) => r.method === "POST" && /\/responses$/.test(r.url));
      const body = received.at(-1)?.body;
      const tools = body?.tools;
      const searchEvents = emittedEvents.filter((e) => e.type === "native-event" && e.kind === "search" && e.payload?.status === "completed");
      entry.reportedVersion = reportedCodexVersion(handshake?.userAgent);
      report.handshakeVersion ??= entry.reportedVersion;
      entry.requests = received.length;
      entry.toolsSent = Array.isArray(tools) ? tools.map((t) => t?.type ?? t?.name ?? "?") : tools === undefined ? [] : "non-array";
      entry.searchEvents = searchEvents.map((e) => ({ actionType: e.payload?.actionType, query: e.payload?.query, sources: e.payload?.sources?.map((s) => s.url) }));
      entry.effectiveConfig = config ? { web_search: config.web_search, project_doc_max_bytes: config.project_doc_max_bytes, include_environment_context: config.include_environment_context, features: Object.fromEntries(FEATURES_OFF.map((n) => [n, config.features?.[n]])) } : null;
      const tag = (n) => `${model}: ${n}`;
      const a = check(tag("handshake-version-matches-cli"), entry.reportedVersion === probe.version, { cli: probe.version, handshake: entry.reportedVersion });
      const b = check(tag("effective-config-tools-off"), config && config.web_search === "live" && FEATURES_OFF.every((n) => config.features?.[n] === false) &&
        [config.mcp_servers, config.plugins, config.hooks, config.skills].every((v) => !v || Object.keys(v).length === 0) && config.model_catalog_json, entry.effectiveConfig);
      const c = check(tag("turn-round-trips"), result.ok === true && result.text === FAKE_TEXT, { ok: result.ok, code: result.code });
      const d = check(tag("provider-request-model"), body?.model === model, body?.model);
      const e = check(tag("provider-request-web-search-only"), received.length >= 1 && Array.isArray(tools) && tools.length === 1 && tools[0]?.type === "web_search" && tools[0]?.external_web_access === true, entry.toolsSent);
      const f = check(tag("native-search-events-round-trip"), searchEvents.some((ev) => ev.payload?.actionType === "search" && ev.payload?.query === "vocatrya verify query") &&
        searchEvents.some((ev) => ev.payload?.actionType === "open_page" && ev.payload?.sources?.some((s) => s.url === "https://example.test/vocatrya-verify")), entry.searchEvents);
      entry.ok = a && b && c && d && e && f;
    }
    check("nativeConfig-keys-covered", Object.keys(NATIVE_CONFIG).length > 0);
  } finally {
    fake.server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
  report.wouldAdd = checks.every((c) => c.ok) ? report.cliVersion : null;
  finish(1);
}

main().catch((error) => { console.log(JSON.stringify({ tool: "verify-codex-native", ok: false, error: String(error?.stack || error) }, null, 2)); process.exit(3); });
