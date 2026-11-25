// A separate foreground protocol: the existing TEXT_ONLY parsers and pool
// deliberately keep their ephemeral-per-turn semantics.
const path = require("node:path");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { runRuntimeCommand } = require("./runner");

// Runtime boundary gate: the native session relies on NATIVE_CONFIG + the
// frozen NATIVE_CATALOG + startup `config/read` self-check + runtime item/RPC
// fail-closed checks to keep shell, apply_patch, mcp, plugins, skills,
// browser/computer use, and every other unapproved tool off while enabling
// only native live web search.
//
// Version gating uses a minimum baseline (`NATIVE_MIN_VERSION`) rather than a
// rigid exact-version allowlist so Codex CLI auto-updates do not break user
// sessions. `NATIVE_VERIFIED_VERSIONS` remains the loopback-verified reference
// list, and its LAST entry (`NATIVE_VERSION`) is what the managed updater pins.
const NATIVE_MIN_VERSION = "0.165.0";
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
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function parseSemver(version) {
  if (typeof version !== "string") return null;
  const match = STRICT_SEMVER_RE.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
function isNativeVersionVerified(version) {
  return typeof version === "string" && NATIVE_VERIFIED_VERSIONS.includes(version);
}
function isNativeVersionSupported(version) {
  const cmp = compareSemver(version, NATIVE_MIN_VERSION);
  return cmp !== null && cmp >= 0;
}
// app-server's initialize reply carries userAgent "<clientInfo.name>/<codex version> (...)".
function reportedCodexVersion(userAgent) {
  const match = typeof userAgent === "string" ? /^vocatrya-native\/(\S+)/.exec(userAgent) : null;
  return match ? match[1] : null;
}
const NATIVE_MODELS = ["gpt-5.4", "gpt-5.3-codex", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const NATIVE_CONFIG = Object.freeze({
  web_search: "live",
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
  base_instructions: "You are a career conversation assistant. Native web search is available when needed; no other tools are available.",
  support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
  truncation_policy: { mode: "tokens", limit: 10000 }, supports_parallel_tool_calls: false,
  experimental_supported_tools: [], supports_search_tool: true, input_modalities: ["text"],
})) };
const NATIVE_CONFIG_HASH = createHash("sha256").update(JSON.stringify([NATIVE_CONFIG, NATIVE_CATALOG])).digest("hex");

const MAX_SEARCH_EVENTS_PER_TURN = 64;
const MAX_SEARCH_SOURCES = 20;
const MAX_SEARCH_QUERIES = 12;
const MAX_SEARCH_URL_CHARS = 2048;
const MAX_SEARCH_TEXT_CHARS = 300;
const MAX_SEARCH_TITLE_CHARS = 200;

function clipBoundedString(value, maxChars) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function sanitizeWebSearchUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SEARCH_URL_CHARS) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return { url: parsed.href, host: parsed.hostname || undefined };
  } catch {
    return null;
  }
}

function collectSourcesFromList(list, addSource, depth = 0) {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rawUrl = entry.url ?? entry.href ?? entry.link ?? entry.uri;
    const title = clipBoundedString(entry.title ?? entry.name, MAX_SEARCH_TITLE_CHARS);
    if (typeof rawUrl === "string") addSource(rawUrl, title || undefined);
    if (depth === 0) {
      collectSourcesFromList(entry.sources, addSource, 1);
      collectSourcesFromList(entry.results, addSource, 1);
    }
  }
}

function normalizeWebSearchItem(item, status) {
  if (!item || typeof item !== "object" || item.type !== "webSearch") return null;
  if (status !== "started" && status !== "completed") return null;
  const itemId = clipBoundedString(item.id, 256);
  if (!itemId) return null;

  const action = item.action && typeof item.action === "object" ? item.action : null;
  const rawActionType = typeof action?.type === "string" ? action.type : "";
  let actionType = "other";
  if (rawActionType === "search") actionType = "search";
  else if (rawActionType === "openPage" || rawActionType === "open_page") actionType = "open_page";
  else if (rawActionType === "findInPage" || rawActionType === "find_in_page") actionType = "find_in_page";

  const seenQueries = new Set();
  const queries = [];
  const addQuery = (candidate) => {
    const clipped = clipBoundedString(candidate, MAX_SEARCH_TEXT_CHARS);
    if (!clipped || seenQueries.has(clipped) || queries.length >= MAX_SEARCH_QUERIES) return;
    seenQueries.add(clipped);
    queries.push(clipped);
  };

  const seenSources = new Map();
  const addSource = (rawUrl, title) => {
    const safe = sanitizeWebSearchUrl(rawUrl);
    if (!safe) return;
    const existing = seenSources.get(safe.url);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return;
    }
    if (seenSources.size >= MAX_SEARCH_SOURCES) return;
    seenSources.set(safe.url, {
      url: safe.url,
      ...(safe.host ? { host: safe.host } : {}),
      ...(title ? { title } : {}),
    });
  };

  let query = clipBoundedString(item.query, MAX_SEARCH_TEXT_CHARS) || "";
  let pattern;

  if (actionType === "search") {
    const actionQuery = clipBoundedString(action?.query, MAX_SEARCH_TEXT_CHARS);
    if (actionQuery) {
      if (!query) query = actionQuery;
      addQuery(actionQuery);
    }
    if (Array.isArray(action?.queries)) {
      for (const q of action.queries) addQuery(q);
    }
    if (query) addQuery(query);
    if (!query && queries.length > 0) query = queries[0];
    collectSourcesFromList(action?.sources, addSource);
  } else if (actionType === "open_page") {
    const targetUrl = clipBoundedString(action?.url, MAX_SEARCH_URL_CHARS) || query;
    if (targetUrl) addSource(targetUrl);
    if (!query && targetUrl) query = clipBoundedString(targetUrl, MAX_SEARCH_TEXT_CHARS) || "";
  } else if (actionType === "find_in_page") {
    const targetUrl = clipBoundedString(action?.url, MAX_SEARCH_URL_CHARS);
    if (targetUrl) addSource(targetUrl);
    const clippedPattern = clipBoundedString(action?.pattern, MAX_SEARCH_TITLE_CHARS);
    if (clippedPattern) pattern = clippedPattern;
    if (!query && clippedPattern) query = clippedPattern;
  }

  collectSourcesFromList(item.results, addSource);

  return {
    itemId,
    payload: {
      status,
      actionType,
      query,
      queries,
      ...(pattern ? { pattern } : {}),
      sources: [...seenSources.values()],
    },
  };
}

function nativeSessionReady(version, model) {
  return isNativeVersionSupported(version) && NATIVE_MODELS.includes(model);
}

function createNativeSessionParser({ model, prompt, instructions, threadId, cwd, profileDir, catalogFile, expectedVersion, allowedVersions }) {
  let stdin;
  let buffer = "";
  let sessionId = threadId || null;
  let turnId = null;
  let terminal = null;
  let cancelled = false;
  let chars = 0;
  let searchEventCount = 0;
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
      const versionOk = allowedVersions ? Boolean(reported && allowedVersions.includes(reported)) : isNativeVersionSupported(reported);
      if (!reported || !versionOk || (expectedVersion && reported !== expectedVersion)) { fail("NATIVE_BOUNDARY_NOT_READY"); return; }
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
          config.web_search !== "live" || config.project_doc_max_bytes !== 0 || config.include_environment_context !== false ||
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
      if (item && !["userMessage", "agentMessage", "reasoning", "webSearch"].includes(item.type)) { fail("NATIVE_UNEXPECTED_TOOL"); return; }
      if (item?.type === "webSearch") {
        if (cancelled) return;
        const normalized = normalizeWebSearchItem(item, m.method === "item/completed" ? "completed" : "started");
        if (!normalized) { fail("NATIVE_PROTOCOL_ERROR"); return; }
        searchEventCount += 1;
        if (searchEventCount > MAX_SEARCH_EVENTS_PER_TURN) { fail("NATIVE_PROTOCOL_ERROR"); return; }
        events.push({
          type: "native-event",
          version: 1,
          kind: "search",
          nativeSessionId: sessionId,
          nativeTurnId: turnId,
          itemId: normalized.itemId,
          occurredAt: new Date().toISOString(),
          payload: normalized.payload,
        });
      }
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

module.exports = { NATIVE_MIN_VERSION, NATIVE_VERIFIED_VERSIONS, parseSemver, compareSemver, isNativeVersionVerified, isNativeVersionSupported, reportedCodexVersion, NATIVE_VERSION, NATIVE_MODELS, NATIVE_CONFIG, NATIVE_CONFIG_HASH, NATIVE_CATALOG, nativeSessionReady, sanitizeWebSearchUrl, normalizeWebSearchItem, createNativeSessionParser, runNativeSession };
