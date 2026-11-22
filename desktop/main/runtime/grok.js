// Phase G Grok adapter for the GROK_RUNTIME backend (xAI account login).
//
// Boundaries (verified against grok 1.0.34/1.0.41, re-verified on 1.0.92 —
// login --oauth still prints the auth.x.ai URL on stderr and
// authenticate(cached_token) still reports _meta.auth_mode "Oidc"):
// - Credential isolation is GROK_HOME plus a redirected HOME/USERPROFILE —
//   the compat scanners (Claude/Cursor skills/hooks/MCP config) and the
//   folder-trust store resolve through ~, not GROK_HOME, so both must point
//   inside the managed profile or host config leaks in.
// - `grok login --oauth` pins the auth.x.ai browser flow; it binds a
//   loopback callback and prints the authorize URL on stderr (surfaced to
//   the renderer via extractLoginUrl). The token is written by the CLI to
//   <GROK_HOME>/auth.json — Vocatrya never reads it.
// - There is no `login status`/`auth status`/`whoami`. Auth state is probed
//   over ACP: `grok agent --no-leader stdio` advertises a `cached_token`
//   auth method only when the profile holds a session, and
//   authenticate(cached_token) returns {email, auth_mode, subscription_tier}
//   metadata without creating a session or calling a model.
// - `grok models` lists the account-visible catalog; unauthenticated it
//   prints "You are not authenticated." and only the bundled list, which is
//   not a real catalog — discovery reports unavailable instead.
// - Headless smoke is `grok -p --output-format json` with every safety flag
//   the version supports. The OS sandbox (Landlock/Seatbelt) does not exist
//   on Windows — `--sandbox strict` is still passed (it also refuses leader
//   mode) but enforcement comes from the empty tool allowlist, deny rules,
//   dontAsk permissions, and a Vocatrya-owned temp cwd.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { terminateChildTree } = require("../runtime");
const { serializeInlineSchema } = require("./structured-schema");
const { createAnthropicStreamParser } = require("./streaming");
const { writePromptFile } = require("./prompt-input");

// The version Vocatrya reports about itself to ACP peers (clientInfo) — see
// streaming.js for why the bundled package.json is the only source here.
const CLIENT_INFO_VERSION = require("../../../package.json").version;

const GROK_BACKEND_KIND = "GROK_RUNTIME";
const GROK_ACCOUNT_PROVIDER = "XAI";

const GROK_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_GROK_OK";
const GROK_SMOKE_EXPECTED = "VOCATRYA_GROK_OK";

// ACP auth-method id advertised only when the profile's auth.json already
// holds a session token (verified: absent on a fresh GROK_HOME, present
// once logged in).
const GROK_CACHED_TOKEN_METHOD = "cached_token";

// Auth classification (spec §21). Only XAI_OAUTH_SESSION may ever complete
// an ACCOUNT_LOGIN connection.
const GROK_AUTH_KINDS = Object.freeze([
  "XAI_OAUTH_SESSION",
  "API_KEY",
  "EXTERNAL_AUTH_PROVIDER",
  "ENTERPRISE_OIDC",
  "UNKNOWN",
]);
const XAI_OAUTH_KIND = "XAI_OAUTH_SESSION";

// Vocatrya-owned minimal config written into every managed GROK_HOME.
// Disables the auto-updater and leader sharing for automated runs, keeps
// memory off, and switches off every Claude/Cursor/Codex compatibility
// scanner so host-vendor config (~/.claude.json MCP servers, hooks, rules,
// skills) can never leak into a managed session. No [model.*] api_key or
// [auth] provider fields — those would outrank the OAuth session.
const GROK_MANAGED_CONFIG_TOML = [
  "# Vocatrya managed Grok profile. Do not edit — rewritten by Vocatrya.",
  "[cli]",
  "auto_update = false",
  "use_leader = false",
  "",
  "[memory]",
  "enabled = false",
  "",
  "[compat.claude]",
  "agents = false",
  "hooks = false",
  "mcps = false",
  "rules = false",
  "skills = false",
  "sessions = false",
  "",
  "[compat.cursor]",
  "agents = false",
  "hooks = false",
  "mcps = false",
  "rules = false",
  "skills = false",
  "sessions = false",
  "",
  "[compat.codex]",
  "hooks = false",
  "skills = false",
  "sessions = false",
  "",
].join("\n");

function grokDefinition() {
  const definition = getRuntimeDefinition(GROK_BACKEND_KIND);
  if (!definition) throw new Error("GROK_RUNTIME is not registered");
  return definition;
}

// The official installer drops a real grok.exe into ~/.grok/bin — it is
// directly spawnable with shell:false. A .cmd/extensionless PATH shim is
// resolved to the sibling grok.exe only; no filesystem walks.
function resolveGrokExecutable(
  executablePath,
  { existsSyncImpl = fs.existsSync } = {},
) {
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    return null;
  }
  if (/\.exe$/i.test(executablePath)) {
    return existsSyncImpl(executablePath) ? executablePath : null;
  }
  const sibling = path.join(path.dirname(executablePath), "grok.exe");
  return existsSyncImpl(sibling) ? sibling : null;
}

// Idempotent: only rewrites when the content drifted (e.g. the CLI touched
// the file). Never merges host config.
function writeManagedGrokConfig(
  profileDir,
  { existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, writeFileSyncImpl = fs.writeFileSync, mkdirSyncImpl = fs.mkdirSync } = {},
) {
  const target = path.join(profileDir, "config.toml");
  let current = null;
  if (existsSyncImpl(target)) {
    try {
      current = readFileSyncImpl(target, "utf8");
    } catch {
      current = null;
    }
  }
  if (current === GROK_MANAGED_CONFIG_TOML) return;
  mkdirSyncImpl(profileDir, { recursive: true });
  writeFileSyncImpl(target, GROK_MANAGED_CONFIG_TOML, "utf8");
}

function grokEnv({ profileDir, baseEnv }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: grokDefinition(),
    profileDir,
  });
}

function grokArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({ definition: grokDefinition(), profileDir }),
    ...commandArgs,
  ];
}

// Browser OAuth login (spec §6/§25): `grok login --oauth` pins auth.x.ai —
// never the welcome screen's method picker, never device auth in V1. The
// process binds a 127.0.0.1 callback listener and exits when the flow
// completes; the caller bounds it with timeoutMs and AbortSignal.
function buildGrokLoginInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedGrokConfig(profileDir);
  return {
    executable: executablePath,
    args: grokArgs({
      profileDir,
      commandArgs: grokDefinition().commands.login,
    }),
    cwd: profileDir,
    env: grokEnv({ profileDir, baseEnv }),
  };
}

function buildGrokLogoutInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedGrokConfig(profileDir);
  return {
    executable: executablePath,
    args: grokArgs({
      profileDir,
      commandArgs: grokDefinition().commands.logout,
    }),
    cwd: profileDir,
    env: grokEnv({ profileDir, baseEnv }),
  };
}

// The authorize URL is printed on stderr ("Open this URL to sign in:").
// Only the official auth origins may surface to the renderer — anything
// else in the stream stays internal.
function extractGrokLoginUrl(text) {
  if (typeof text !== "string") return null;
  const match = text.replace(ANSI_PATTERN, "").match(
    /https:\/\/(?:auth|accounts)\.x\.ai\/[^\s"'<>\x1b]+/i,
  );
  return match ? match[0] : null;
}

const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\[[0-9;?]*[A-Za-z]",
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\([0-9A-Z]",
    "\\x1b.",
  ].join("|"),
  "g",
);

// ---------------------------------------------------------------------------
// ACP auth probe — `grok agent --no-leader stdio` (spec §18/§19).
// initialize + authenticate(cached_token), nothing else: no session/new,
// no session/prompt, no tool calls. Read-only and bounded.
// ---------------------------------------------------------------------------

const ACP_MAX_BUFFER_BYTES = 256 * 1024;

// Maps the authenticate() response's _meta.auth_mode onto the spec §21
// taxonomy. Verified: a grok.com OAuth session reports "Oidc". Anything
// absent or unrecognized is UNKNOWN — a verification boundary fails closed,
// it never accepts a session whose kind it cannot name.
function classifyGrokAuthMode(authMode) {
  if (authMode == null || authMode === "") return "UNKNOWN";
  const value = String(authMode);
  if (/^oidc$/i.test(value)) return XAI_OAUTH_KIND;
  if (/api.?key|deployment/i.test(value)) return "API_KEY";
  if (/external|provider|command/i.test(value)) return "EXTERNAL_AUTH_PROVIDER";
  if (/enterprise|custom/i.test(value)) return "ENTERPRISE_OIDC";
  return "UNKNOWN";
}

// Classify an authenticate() JSON-RPC error. ACP auth-required is code
// -32000; expired/revoked sessions surface as REAUTH_REQUIRED so the
// connection can be repaired by reconnect rather than erroring out.
function classifyGrokAuthError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (/expired|revoked|invalid_grant|reauth/.test(text)) {
    return "REAUTH_REQUIRED";
  }
  if (error?.code === -32000) return "NOT_AUTHENTICATED";
  if (/auth|sign.?in|login|credential|unauthori/.test(text)) {
    return "NOT_AUTHENTICATED";
  }
  return "UNKNOWN";
}

function grokAuthResult(authState, extra = {}) {
  return {
    authState,
    authKind: null,
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
    ...extra,
  };
}

// runGrokAcpAuthProbe({executablePath, profileDir, baseEnv, timeoutMs,
//   spawnImpl, terminateImpl})
//   → { authState, authKind, authMethod, accountIdentity, providerMetadata }
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Spawns the ACP agent inside the managed env and drives exactly two
// requests. Any deviation — spawn failure, malformed frames, timeout, a
// missing cached_token method — maps to a conservative auth state; the
// child is always terminated.
function runGrokAcpAuthProbe({
  executablePath,
  profileDir,
  baseEnv,
  timeoutMs = 15_000,
  signal,
  spawnImpl = spawn,
  terminateImpl = terminateChildTree,
} = {}) {
  try {
    writeManagedGrokConfig(profileDir);
  } catch {
    return Promise.resolve(grokAuthResult("UNKNOWN"));
  }
  const args = grokArgs({
    profileDir,
    commandArgs: grokDefinition().authProbe.args,
  });
  const env = grokEnv({ profileDir, baseEnv });
  // PATH lookups can land on a .cmd shim that cannot spawn with
  // shell:false — resolve through the same rule the service applies.
  const executable = resolveGrokExecutable(executablePath) || executablePath;

  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    let child;
    let authenticateSent = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        child?.stdin?.end?.();
      } catch {
        // already closed
      }
      // Resolve only after the child is actually down — callers must be able
      // to rely on "the probe is finished" meaning no stray agent survives.
      void Promise.resolve(terminateImpl(child)).then(() =>
        resolve(outcome),
      );
    };

    const onAbort = () => finish(grokAuthResult("UNKNOWN"));

    const timer = setTimeout(() => {
      finish(grokAuthResult("UNKNOWN"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(grokAuthResult("UNKNOWN"));
      return;
    }

    try {
      child = spawnImpl(executable, args, {
        cwd: profileDir,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(grokAuthResult("UNKNOWN"));
      return;
    }

    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        finish(grokAuthResult("UNKNOWN"));
      }
    };

    const handleMessage = (msg) => {
      if (settled || !isPlainObject(msg)) return;
      // Only JSON-RPC *responses* to an outstanding request we sent are
      // answers. Agent→client requests (session/request_permission, fs/*,
      // terminal/*) carry agent-side ids that can collide with our literal
      // 1/2 — any frame bearing a `method`, any unexpected id, or a frame
      // without result/error is never an answer and is ignored.
      if (typeof msg.method === "string") return;
      const isResponse = "result" in msg || "error" in msg;
      if (!isResponse) return;

      if (msg.id === 1 && !authenticateSent) {
        if (msg.error || !isPlainObject(msg.result)) {
          finish(grokAuthResult("UNKNOWN"));
          return;
        }
        const methods = Array.isArray(msg.result.authMethods)
          ? msg.result.authMethods
          : [];
        const hasCachedToken = methods.some(
          (m) => isPlainObject(m) && m.id === GROK_CACHED_TOKEN_METHOD,
        );
        if (!hasCachedToken) {
          // No cached session in this profile — definitively signed out.
          finish(grokAuthResult("NOT_AUTHENTICATED"));
          return;
        }
        authenticateSent = true;
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "authenticate",
          params: { methodId: GROK_CACHED_TOKEN_METHOD },
        });
        return;
      }
      if (msg.id === 2 && authenticateSent) {
        if (msg.error) {
          finish(grokAuthResult(classifyGrokAuthError(msg.error)));
          return;
        }
        if (!isPlainObject(msg.result)) {
          finish(grokAuthResult("UNKNOWN"));
          return;
        }
        const meta = isPlainObject(msg.result._meta) ? msg.result._meta : {};
        const authKind = classifyGrokAuthMode(meta.auth_mode);
        const providerMetadata = {};
        if (typeof meta.auth_mode === "string" && meta.auth_mode) {
          providerMetadata.authMode = meta.auth_mode;
        }
        if (
          typeof meta.subscription_tier === "string" &&
          meta.subscription_tier
        ) {
          providerMetadata.subscriptionTier = meta.subscription_tier;
        }
        finish(
          grokAuthResult("AUTHENTICATED", {
            authKind,
            authMethod: "oauth",
            accountIdentity:
              typeof meta.email === "string" && meta.email.length > 0
                ? meta.email
                : null,
            providerMetadata:
              Object.keys(providerMetadata).length > 0
                ? providerMetadata
                : null,
          }),
        );
      }
      // Notifications (e.g. _x.ai/mcp/servers_updated) and agent→client
      // requests are ignored — we never answer tool/permission calls.
    };

    if (!child.stdout || !child.stdin) {
      finish(grokAuthResult("UNKNOWN"));
      return;
    }

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > ACP_MAX_BUFFER_BYTES) {
        finish(grokAuthResult("UNKNOWN"));
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // A non-JSON line on the ACP stream means we are not speaking the
          // protocol — fail closed rather than parse leniently.
          finish(grokAuthResult("UNKNOWN"));
          return;
        }
        handleMessage(msg);
        if (settled) return;
      }
    });
    // stderr is drained but never parsed — it may carry diagnostics and must
    // not be allowed to block the child.
    child.stderr?.on("data", () => {});
    child.once("error", () => finish(grokAuthResult("UNKNOWN")));
    child.once("close", () => finish(grokAuthResult("UNKNOWN")));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "vocatrya-auth-probe", version: CLIENT_INFO_VERSION },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Model discovery — `grok models` (spec §28-§31).
// ---------------------------------------------------------------------------

const GROK_MODEL_LINE = /^[*-]\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\(default\))?\s*$/;

// Verified output shape (grok 1.0.34/1.0.41):
//   You are logged in with grok.com.        |  You are not authenticated.
//   Default model: grok-4.7                 |  Default model: grok-4.6
//   Available models:                       |  Available models:
//     * grok-4.7 (default)                  |    * grok-4.6 (default)
//     - grok-4.7-build-fast                 |    - grok-4.5
// Returns { models, defaultModel, authenticated } or null when the output
// does not match the documented shape.
function parseGrokModelList(stdout) {
  const clean = (stdout || "").replace(ANSI_PATTERN, "");
  // Require the positive marker — an unauthenticated listing that changed
  // its wording must fail closed, not quietly pass as a real catalog.
  const authenticated =
    /you are logged in/i.test(clean) &&
    !/you are not authenticated/i.test(clean);
  const lines = clean.split(/\r?\n/);
  const defaultLine = lines.find((line) =>
    /^default model:\s*(\S+)/i.test(line.trim()),
  );
  const models = [];
  let inCatalog = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^available models:/i.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    if (!line) {
      if (models.length > 0) break;
      continue;
    }
    const match = line.match(GROK_MODEL_LINE);
    if (!match) {
      // A non-model line ends the catalog block.
      if (models.length > 0) break;
      return null;
    }
    models.push({
      id: match[1],
      displayName: match[1],
      isDefault: /\(default\)/.test(line) || line.startsWith("*"),
    });
  }
  if (!inCatalog || models.length === 0) return null;
  const defaultModel =
    models.find((m) => m.isDefault)?.id ??
    (defaultLine ? defaultLine.trim().split(/:\s*/)[1] : null);
  return { models, defaultModel, authenticated };
}

// RUNTIME_DYNAMIC only — no static Grok catalog is maintained. An
// unauthenticated listing is the bundled fallback, not the account's
// catalog, so it is reported as unavailable rather than returned.
async function listGrokModels({
  executablePath,
  profileDir,
  baseEnv,
  runner,
  timeoutMs,
  signal,
}) {
  writeManagedGrokConfig(profileDir);
  const result = await runner({
    executable: executablePath,
    args: grokArgs({
      profileDir,
      commandArgs: grokDefinition().commands.models,
    }),
    cwd: profileDir,
    env: grokEnv({ profileDir, baseEnv }),
    timeoutMs,
    signal,
  });
  if (result.error || result.timedOut || result.exitCode !== 0) {
    return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
  }
  const parsed = parseGrokModelList(result.stdout);
  if (!parsed || !parsed.authenticated) {
    return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
  }
  return {
    dynamicDiscoverySupported: true,
    models: parsed.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      source: "RUNTIME",
      availability: "available",
    })),
  };
}

// ---------------------------------------------------------------------------
// Headless smoke — `grok -p` (spec §32-§43).
// ---------------------------------------------------------------------------

// Minimal-permission one-shot. `--tools ""` applies an empty allowlist; the
// repeated deny rules are the Claude-compat permission layer that still
// gates anything a future version might leave enabled; dontAsk means
// nothing can ever prompt. On Windows the OS sandbox is a no-op (docs:
// Landlock/Seatbelt only) — it is still requested because it refuses leader
// mode and becomes enforced automatically on supported platforms.
// The prompt rides `--prompt-file <file inside the fresh workDir>`
// (verified in `grok --help` on 1.0.70; headless mode is entered when a
// prompt file is given) — long business prompts never ride on the Windows
// command line, and the file is removed with the workDir.
function buildGrokPrintInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  prompt,
}) {
  writeManagedGrokConfig(profileDir);
  const args = [
    ...buildRuntimeInvocationArgs({
      definition: grokDefinition(),
      profileDir,
    }),
    "--prompt-file",
    writePromptFile(workingDirectory, prompt),
    "--output-format",
    "json",
    "--no-auto-update",
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--tools",
    "",
    "--deny",
    "Bash",
    "--deny",
    "Read",
    "--deny",
    "Edit",
    "--deny",
    "Write",
    "--deny",
    "Grep",
    "--deny",
    "WebFetch",
    "--deny",
    "MCPTool",
    "--sandbox",
    "strict",
    "--permission-mode",
    "dontAsk",
  ];
  if (typeof model === "string" && model.length > 0) {
    args.push("-m", model);
  }
  return {
    executable: executablePath,
    args,
    cwd: workingDirectory,
    env: grokEnv({ profileDir, baseEnv }),
  };
}

// Streaming variant (grok 1.0.41): `--output-format
// streaming-messages-json` switches stdout to Anthropic-wire NDJSON and
// `--include-partial-messages` emits incremental stream_event text deltas
// alongside the whole messages. Every safety flag of the print invocation
// is preserved unchanged.
function buildGrokStreamingInvocation(args) {
  const invocation = buildGrokPrintInvocation(args);
  const nextArgs = invocation.args.slice();
  const formatIndex = nextArgs.indexOf("--output-format");
  if (formatIndex === -1) return invocation;
  nextArgs[formatIndex + 1] = "streaming-messages-json";
  nextArgs.push("--include-partial-messages");
  return { ...invocation, args: nextArgs };
}

// NATIVE_JSON_SCHEMA (grok 1.0.41): `grok -p --json-schema <schema>`
// constrains the model to produce JSON matching the schema and implies
// --output-format json — the {text,...} envelope's text carries the
// constrained object. The schema is an inline argv element; the xAI REST
// structured-output API is a different layer and is never used here.
function buildGrokStructuredInvocation(args) {
  const serialized = serializeInlineSchema(args.schema);
  const invocation = buildGrokPrintInvocation(args);
  return {
    ...invocation,
    args: [...invocation.args, "--json-schema", serialized],
  };
}

// `--output-format json` emits one object after the run completes:
//   { text, stopReason, sessionId, requestId, num_turns, usage, ... }
// Only the assistant text is returned — usage/session fields never cross
// into providerMetadata. Falls back to the last non-empty line.
function parseGrokPrintResult({ stdout, stderr }) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const text =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.error === "string"
          ? parsed.error
          : "";
    const reportedError =
      parsed.is_error === true ||
      (typeof parsed.error === "string" && parsed.error.length > 0) ||
      /error|fail/i.test(String(parsed.stopReason || ""));
    return {
      text: text.trim(),
      reportedError,
      stopReason:
        typeof parsed.stopReason === "string" ? parsed.stopReason : null,
    };
  }
  const lines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_PATTERN, "").trim())
    .filter(Boolean);
  return { text: lines[lines.length - 1] || "", reportedError: false, stopReason: null };
}

// Provider adapter contract consumed by connection-service.js (same shape
// as codex/claude/opencode). The ACP probe replaces the command-style
// buildStatusInvocation — `probeAuth` drives the stdio handshake directly.
const grokAdapter = {
  backendKind: GROK_BACKEND_KIND,
  // The Grok runtime only ever authenticates an xAI account.
  accountProvider: GROK_ACCOUNT_PROVIDER,
  forAccountProvider(provider) {
    return provider == null || provider === GROK_ACCOUNT_PROVIDER
      ? grokAdapter
      : null;
  },
  loginGuardKey: "grok:login",
  smokePrompt: GROK_SMOKE_PROMPT,
  smokeExpected: GROK_SMOKE_EXPECTED,
  resolveExecutable: resolveGrokExecutable,
  buildLoginInvocation: buildGrokLoginInvocation,
  buildLogoutInvocation: buildGrokLogoutInvocation,
  probeAuth: runGrokAcpAuthProbe,
  checkLoginPolicy: null,
  extractLoginUrl: extractGrokLoginUrl,

  // Post-login verification: only the xAI OAuth session kind completes an
  // ACCOUNT_LOGIN connection. A recognized wrong kind (API key, external
  // provider, enterprise OIDC) is UNSUPPORTED_AUTH_METHOD; an
  // unclassifiable session is AUTH_METHOD_UNVERIFIED — never accepted.
  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    if (status.authKind === XAI_OAUTH_KIND) return null;
    return status.authKind && status.authKind !== "UNKNOWN"
      ? "UNSUPPORTED_AUTH_METHOD"
      : "AUTH_METHOD_UNVERIFIED";
  },

  // A verified non-OAuth-session state must never flip an ACCOUNT_LOGIN
  // connection to CONNECTED — reported as UNKNOWN, which maps to ERROR.
  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authKind !== XAI_OAUTH_KIND
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  listModels: listGrokModels,

  buildSmokeInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
  }) {
    return buildGrokPrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt: GROK_SMOKE_PROMPT,
    });
  },

  // TEXT_ONLY business execution — same minimum-permission print
  // invocation as smoke; the caller-supplied prompt rides --prompt-file
  // inside the fresh workDir, never an argv element.
  buildTextInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
    prompt,
  }) {
    return buildGrokPrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt,
    });
  },

  // Streaming TEXT_ONLY — the locked-down print invocation switched to
  // `streaming-messages-json` + `--include-partial-messages` (incremental
  // stream_event text deltas, no ACP session ownership).
  buildStreamingInvocation(args) {
    return buildGrokStreamingInvocation(args);
  },
  createStreamParser: createAnthropicStreamParser,
  streamMechanism:
    "grok --prompt-file --output-format streaming-messages-json --include-partial-messages",

  // NATIVE_JSON_SCHEMA — `grok -p --json-schema <schema>` inline.
  buildStructuredInvocation(args) {
    return buildGrokStructuredInvocation(args);
  },

  extractText({ result }) {
    return parseGrokPrintResult(result);
  },

  extractSmokeText({ result }) {
    return parseGrokPrintResult(result);
  },
};

module.exports = {
  GROK_ACCOUNT_PROVIDER,
  GROK_AUTH_KINDS,
  GROK_BACKEND_KIND,
  GROK_CACHED_TOKEN_METHOD,
  GROK_MANAGED_CONFIG_TOML,
  GROK_SMOKE_EXPECTED,
  GROK_SMOKE_PROMPT,
  buildGrokLoginInvocation,
  buildGrokLogoutInvocation,
  buildGrokPrintInvocation,
  buildGrokStreamingInvocation,
  buildGrokStructuredInvocation,
  classifyGrokAuthError,
  classifyGrokAuthMode,
  extractGrokLoginUrl,
  grokAdapter,
  parseGrokModelList,
  parseGrokPrintResult,
  resolveGrokExecutable,
  runGrokAcpAuthProbe,
  writeManagedGrokConfig,
};
