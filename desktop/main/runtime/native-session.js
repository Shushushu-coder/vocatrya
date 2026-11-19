// A separate foreground protocol: the existing TEXT_ONLY parsers and pool
// deliberately keep their ephemeral-per-turn semantics.
const path = require("node:path");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { runRuntimeCommand } = require("./runner");

// SAFETY gate, not a compatibility hint: the native session relies on
// NATIVE_CONFIG + the frozen NATIVE_CATALOG to keep web search, shell,
// apply_patch and every other tool off, and a new CLI may rename a config
// key and silently re-enable one. A version is listed only after
// `node desktop/scripts/verify-codex-native.mjs` passed against that exact
// binary (loopback synthetic Responses provider, temp CODEX_HOME, no account
// credentials). Add an entry, oldest first, with how/when it was verified;
// the LAST entry is the newest and is what the managed updater installs.
const NATIVE_VERIFIED_VERSIONS = Object.freeze([
  // 0.169.0: checked against the real binary via a loopback synthetic
  // Responses provider (no account credentials) when native sessions shipped.
  "0.169.0",
  // 0.170.0: 2026-11-19 verify-codex-native.mjs against the npm-installed
  // vendor codex.exe, all 7 NATIVE_MODELS: 38/38 checks, handshake 0.170.0,
  // web_search disabled, all features false, toolsSent [] for every model.
  "0.170.0",
]);
const NATIVE_VERSION = NATIVE_VERIFIED_VERSIONS[NATIVE_VERIFIED_VERSIONS.length - 1];
function isNativeVersionVerified(version) {
  return typeof version === "string" && NATIVE_VERIFIED_VERSIONS.includes(version);
}
// app-server's initialize reply carries userAgent "<clientInfo.name>/<codex version> (...)".
function reportedCodexVersion(userAgent) {
  const match = typeof userAgent === "string" ? /^vocatrya-native\/(\S+)/.exec(userAgent) : null;
  return match ? match[1] : null;
}
const NATIVE_MODELS = ["gpt-5.4", "gpt-5.3-codex", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const NATIVE_CONFIG = Object.freeze({
  web_search: "disabled",
  project_doc_max_bytes: 0,
  include_environment_context: false,
  "features.shell_tool": false,
  "features.view_image": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.apps": false,
  "features.code_mode": false,
  "features.code_mode_host": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.image_generation": false,
  "features.skill_search": false,
  "features.goals": false,
  "features.hooks": false,
  "features.memories": false,
  "features.skill_mcp_dependency_install": false,
  "features.in_app_browser": false,
  "features.browser_use_external": false,
  "features.remote_plugin": false,
  "features.tool_suggest": false,
  "features.mentions_v2": false,
  "features.skip_host_skill_discovery": true,
  "tools.update_plan.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  mcp_servers: {},
  plugins: {},
});
// Freeze tool-affecting model metadata too: an account catalog refresh
// must not re-enable apply_patch or model-specific tools on the same CLI.
const NATIVE_CATALOG = { models: NATIVE_MODELS.map(slug => ({
  slug, display_name: slug, description: "Vocatrya native text", default_reasoning_level: null,
  supported_reasoning_levels: [], shell_type: "disabled", visibility: "hide", supported_in_api: true,
  priority: 0, availability_nux: null, upgrade: null,
  base_instructions: "You are a career conversation assistant. No tools are available.",
  support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
  truncation_policy: { mode: "tokens", limit: 10000 }, supports_parallel_tool_calls: false,
  experimental_supported_tools: [], supports_search_tool: false, input_modalities: ["text"],
})) };
const NATIVE_CONFIG_HASH = createHash("sha256").update(JSON.stringify([NATIVE_CONFIG, NATIVE_CATALOG])).digest("hex");

function nativeSessionReady(version, model) {
  return isNativeVersionVerified(version) && NATIVE_MODELS.includes(model);
}

function createNativeSessionParser({ model, prompt, instructions, threadId, cwd, profileDir, catalogFile, expectedVersion, allowedVersions }) {
  let stdin;
  let buffer = "";
  let sessionId = threadId || null;
  let turnId = null;
  let terminal = null;
  let cancelled = false;
  let chars = 0;
  let phase = "initialize";
  const pending = new Set();
  const decoder = new StringDecoder("utf8");
  const deltas = new Map();
  const final = new Map();
  const events = [];
  const send = (value) => { try { stdin?.write(JSON.stringify(value) + "\n"); } catch { fail("NATIVE_PROTOCOL_ERROR"); } };
  const end = () => { try { stdin?.end(); } catch { /* already closed */ } };
  const fail = (code) => { if (!terminal) { terminal = { ok: false, code }; events.push({ type: "error", code }); end(); } };
  const request = (id, method, params) => { pending.add(id); send({ id, method, params }); };
  const interrupt = () => {
    cancelled = true;
    if (sessionId && turnId) request(4, "turn/interrupt", { threadId: sessionId, turnId });
  };
  const inside = (root, file) => {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const message = (m) => {
    if (terminal) return;
    if (m.id !== undefined && m.method) {
      send({ id: m.id, error: { code: -32601, message: "Tools and approvals are not loaded" } });
      fail("NATIVE_UNEXPECTED_TOOL");
      return;
    }
    if (m.id !== undefined) {
      if (!pending.delete(m.id)) { fail("NATIVE_PROTOCOL_ERROR"); return; }
    } else if (m.method && (m.method === "turn/started" || m.method.startsWith("item/") || m.method === "turn/completed")) {
      const params = m.params || {};
      const incomingTurn = params.turnId || params.turn?.id;
      if (!sessionId || params.threadId !== sessionId || !["turn-starting", "active"].includes(phase) || typeof incomingTurn !== "string" || !incomingTurn || (turnId && incomingTurn !== turnId)) {
        fail("NATIVE_PROTOCOL_ERROR"); return;
      }
      turnId = incomingTurn;
    }
    if (m.error && m.id !== 4) { fail(m.id === 2 && threadId ? "NATIVE_RESUME_FAILED" : "NATIVE_PROTOCOL_ERROR"); return; }
    if (m.id === 1) {
      // Startup self-check: trust the version the binary itself reports in the
      // handshake, not the path-probed one. Unreported, unlisted, or different
      // from what the caller resolved: refuse before any config or thread work.
      // allowedVersions is only for desktop/scripts/verify-codex-native.mjs, which
      // must run an as-yet-unlisted candidate binary to decide whether to list it.
      const reported = reportedCodexVersion(m.result?.userAgent);
      if (!reported || !(allowedVersions || NATIVE_VERIFIED_VERSIONS).includes(reported) || (expectedVersion && reported !== expectedVersion)) { fail("NATIVE_BOUNDARY_NOT_READY"); return; }
      phase = "checking-config";
      send({ method: "initialized" });
      if (cancelled) { fail("NATIVE_CANCELLED"); return; }
      request(5, "config/read", { includeLayers: false });
    } else if (m.id === 5) {
      const config = m.result?.config;
      const featureNames = ["shell_tool", "view_image", "multi_agent", "multi_agent_v2", "apps", "code_mode", "code_mode_host", "browser_use", "computer_use", "image_generation", "skill_search", "goals", "memories", "remote_plugin", "tool_suggest", "mentions_v2"];
      // Empty table overrides can merge with inherited system configuration.
      // Inspect the effective configuration before opening any native thread.
      if (!config || featureNames.some(name => config.features?.[name] !== false) ||
          config.web_search !== "disabled" || config.project_doc_max_bytes !== 0 || config.include_environment_context !== false ||
          config.model_catalog_json !== catalogFile ||
          [config.mcp_servers, config.plugins, config.hooks, config.skills, config.notify].some(value => value && Object.keys(value).length > 0) ||
          config.model_instructions_file || config.instructions || config.developer_instructions) {
        fail("NATIVE_BOUNDARY_NOT_READY"); return;
      }
      phase = "opening";
      if (cancelled) { fail("NATIVE_CANCELLED"); return; }
      request(2, threadId ? "thread/resume" : "thread/start", {
        ...(threadId ? { threadId } : { ephemeral: false }),
        cwd, model, approvalPolicy: "never", sandbox: "read-only",
        developerInstructions: instructions, config: { ...NATIVE_CONFIG, ...(catalogFile ? { model_catalog_json: catalogFile } : {}) },
      });
    } else if (m.id === 2) {
      const id = m.result?.thread?.id;
      if (typeof id !== "string" || !id || (threadId && id !== threadId)) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      for (const source of m.result?.instructionSources || []) {
        const file = source?.path;
        if (typeof file === "string" && (!path.isAbsolute(file) || (!inside(profileDir, file) && !inside(cwd, file)))) {
          fail("NATIVE_BOUNDARY_NOT_READY"); return;
        }
      }
      if (m.result?.model !== undefined && m.result.model !== model) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      phase = "turn-starting";
      sessionId = id;
      events.push({ type: "native-session", threadId: id, resumed: Boolean(threadId) });
      if (cancelled) { fail("NATIVE_CANCELLED"); return; }
      request(3, "turn/start", { threadId: id, model, input: [{ type: "text", text: prompt }] });
    } else if (m.id === 3) {
      const responseTurn = m.result?.turn?.id;
      if (typeof responseTurn !== "string" || !responseTurn || (turnId && turnId !== responseTurn)) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      turnId = responseTurn;
      phase = "active";
      if (cancelled) interrupt();
    } else if (m.method === "item/agentMessage/delta") {
      if (cancelled) return;
      const { itemId, delta } = m.params || {};
      if (typeof itemId !== "string" || typeof delta !== "string") { fail("NATIVE_PROTOCOL_ERROR"); return; }
      chars += delta.length;
      if (chars > 256 * 1024) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      deltas.set(itemId, (deltas.get(itemId) || "") + delta);
      events.push({ type: "text-delta", delta });
    } else if (m.method === "item/started" || m.method === "item/completed") {
      const item = m.params?.item;
      if (item && !["userMessage", "agentMessage", "reasoning"].includes(item.type)) { fail("NATIVE_UNEXPECTED_TOOL"); return; }
      if (m.method === "item/completed" && item?.type === "agentMessage") final.set(item.id, item.text || "");
    } else if (m.method === "turn/completed") {
      if (cancelled || m.params?.turn?.status === "interrupted") { fail("NATIVE_CANCELLED"); return; }
      if (m.params?.turn?.status !== "completed") { fail("NATIVE_PROTOCOL_ERROR"); return; }
      if (!final.size || [...final].some(([id, text]) => (deltas.get(id) || "") !== text) || [...deltas].some(([id, text]) => final.get(id) !== text)) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      const text = [...final.values()].join("");
      if (!text.trim()) { fail("NATIVE_PROTOCOL_ERROR"); return; }
      terminal = { ok: true, text, threadId: sessionId };
      end();
    }
  };
  return {
    attach(stream) { stdin = stream; stdin.on?.("error", () => fail("NATIVE_PROTOCOL_ERROR")); request(1, "initialize", { clientInfo: { name: "vocatrya-native", version: "1" }, capabilities: { experimentalApi: false } }); },
    push(chunk) {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (buffer.length > 512 * 1024) fail("NATIVE_PROTOCOL_ERROR");
      let index;
      while (!terminal && (index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.trim()) { try { message(JSON.parse(line)); } catch { fail("NATIVE_PROTOCOL_ERROR"); } }
      }
      return events.splice(0);
    },
    interrupt,
    result() { return cancelled ? { ok: false, code: "NATIVE_CANCELLED" } : terminal || { ok: false, code: "NATIVE_PROTOCOL_ERROR" }; },
  };
}

async function runNativeSession({ allowedVersions, expectedVersion, invocation, model, prompt, instructions, threadId, profileDir, signal, timeoutMs, onEvent, runner = runRuntimeCommand }) {
  const catalogFile = path.join(invocation.cwd, "native-model-catalog.json");
  fs.writeFileSync(catalogFile, JSON.stringify(NATIVE_CATALOG));
  const parser = createNativeSessionParser({ model, prompt, instructions, threadId, cwd: invocation.cwd, profileDir, catalogFile, expectedVersion, allowedVersions });
  const controller = new AbortController();
  let grace;
  const abort = () => { parser.interrupt(); grace = setTimeout(() => controller.abort(), 1500); };
  if (signal?.aborted) return { ok: false, code: "NATIVE_CANCELLED" };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const args = [...invocation.args, "-c", `model_catalog_json=${JSON.stringify(catalogFile)}`];
    for (const [key, value] of Object.entries(NATIVE_CONFIG)) args.push("-c", `${key}=${typeof value === "object" ? "{}" : JSON.stringify(value)}`);
    const result = await runner({ ...invocation, args, timeoutMs, signal: controller.signal, stdinPipe: true, binaryStdout: true,
      onStdinReady: (stream) => parser.attach(stream),
      onStdout: (chunk) => { for (const event of parser.push(chunk)) { if (!signal?.aborted) onEvent?.(event); } },
    });
    if (signal?.aborted) return { ok: false, code: "NATIVE_CANCELLED" };
    if (result.timedOut) return { ok: false, code: "AI_EXECUTION_TIMEOUT" };
    if (result.error || result.exitCode !== 0 || result.signal) return { ok: false, code: "NATIVE_PROTOCOL_ERROR" };
    return parser.result();
  } finally { clearTimeout(grace); signal?.removeEventListener("abort", abort); }
}

module.exports = { NATIVE_VERIFIED_VERSIONS, isNativeVersionVerified, reportedCodexVersion, NATIVE_VERSION, NATIVE_MODELS, NATIVE_CONFIG, NATIVE_CONFIG_HASH, NATIVE_CATALOG, nativeSessionReady, createNativeSessionParser, runNativeSession };
