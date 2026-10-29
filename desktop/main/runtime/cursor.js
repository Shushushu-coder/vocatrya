// Phase H Cursor adapter for CURSOR_RUNTIME — Cursor personal account
// login through the official Cursor Agent CLI (cursor-agent / agent).
//
// Verified against cursor-agent 2026.09.18-9a7762b on win32:
//   * The CLI installs as a versioned Node bundle under
//     %LOCALAPPDATA%\cursor-agent\versions\<YYYY.MM.DD-sha>\ — the PATH
//     shims (agent.cmd / cursor-agent.cmd / agent.ps1) all dispatch into
//     <ver>\node.exe index.js. `shell:false` cannot spawn .cmd shims, so
//     this adapter resolves the bundle's node.exe and prepends index.js.
//   * `agent login` performs the official browser login. With
//     NO_OPEN_BROWSER=1 it prints the authorization URL
//     (https://cursor.com/loginDeepControl?...) on stdout instead of
//     opening a browser, then polls until the flow completes.
//   * `agent status --format json` emits {status, isAuthenticated,
//     hasAccessToken, hasRefreshToken, message, userInfo?}. It reads only
//     the persisted credential store — ambient CURSOR_API_KEY /
//     CURSOR_AUTH_TOKEN do not move it — but those env vars WOULD let a
//     managed child authenticate inference with a host key, so the
//     registry strips them from every managed process environment.
//   * Credentials persist in %APPDATA%\Cursor\auth.json on win32 (file
//     store; macOS uses the login keychain). CURSOR_CONFIG_DIR covers
//     cli-config.json/statsig/mcp-auth.json only — auth isolation
//     therefore requires redirecting APPDATA + HOME/USERPROFILE +
//     CURSOR_CONFIG_DIR (see the registry ISOLATED_ROOTS env map).
//   * Managed permissions live in <CURSOR_CONFIG_DIR>/cli-config.json —
//     the adapter enforces permissions.allow=[], broad deny rules, and
//     approvalMode="allowlist" so print-mode tool calls are denied.
//
// Auth-source classification is provenance-based: inside a managed
// profile the only code path that can write credentials is `agent login`
// (browser). Vocatrya never passes --api-key/--auth-token and the
// registry strips CURSOR_API_KEY/CURSOR_AUTH_TOKEN, so an authenticated
// managed profile can only be a browser Cursor account.
const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeDefinition } = require("./registry");
const { createCursorStreamParser } = require("./streaming");
const { promptStdinWriter } = require("./prompt-input");
const { resolveRuntimeBundle, bundleEntrypointArgs } = require("./detector");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");

const CURSOR_BACKEND_KIND = "CURSOR_RUNTIME";
const CURSOR_ACCOUNT_PROVIDER = "CURSOR";
const CURSOR_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_CURSOR_OK";
const CURSOR_SMOKE_EXPECTED = "VOCATRYA_CURSOR_OK";

// Browser auth always lands on an official cursor.com deep-control URL.
const CURSOR_LOGIN_URL_RE =
  /https:\/\/(?:www\.)?cursor\.com\/loginDeepControl\?[^\s"'<>)\]]+/i;

// Managed permissions: deny everything — the Vocatrya smoke needs no
// tools. Deny rules take priority over allow entries; allow stays empty
// so nothing (including the CLI's own default `Shell(ls)`) is granted.
const CURSOR_PERMISSION_DENY = Object.freeze([
  "Shell(*)",
  "Bash(*)",
  "Read(**)",
  "Read(*)",
  "Write(**)",
  "Write(*)",
  "Edit(**)",
  "Delete(**)",
  "Glob(**)",
  "Grep(**)",
  "LS(**)",
  "WebFetch(*)",
  "WebSearch(*)",
  "Task(*)",
  "MCP(*)",
]);

function cursorDefinition() {
  return getRuntimeDefinition(CURSOR_BACKEND_KIND);
}

// A Vocatrya-owned cli-config.json inside the managed CURSOR_CONFIG_DIR.
// Written before every managed invocation so CLI-managed drift (the CLI
// rewrites this file with user prefs) cannot silently reopen the tool
// surface. The file is config, never credentials.
function writeManagedCursorConfig(
  profileDir,
  {
    existsSyncImpl = fs.existsSync,
    readFileSyncImpl = fs.readFileSync,
    writeFileSyncImpl = fs.writeFileSync,
    mkdirSyncImpl = fs.mkdirSync,
  } = {},
) {
  const configDir = path.join(profileDir, "config");
  const target = path.join(configDir, "cli-config.json");
  let existing = {};
  if (existsSyncImpl(target)) {
    try {
      const parsed = JSON.parse(readFileSyncImpl(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      existing = {};
    }
  }
  const next = {
    ...existing,
    version: 1,
    permissions: { allow: [], deny: [...CURSOR_PERMISSION_DENY] },
    approvalMode: "allowlist",
    sandbox: {
      ...(existing.sandbox && typeof existing.sandbox === "object"
        ? existing.sandbox
        : {}),
      mode: "enabled",
    },
  };
  mkdirSyncImpl(configDir, { recursive: true });
  writeFileSyncImpl(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return target;
}

// Managed env for any cursor-agent child: ISOLATED_ROOTS redirects
// APPDATA (auth.json), CURSOR_CONFIG_DIR (cli-config.json), HOME/
// USERPROFILE (~/.cursor incl. mcp.json/rules), LOCALAPPDATA and XDG
// roots; the registry stripEnv removes every credential/endpoint/
// behavior override discovered in the bundle. NO_OPEN_BROWSER keeps the
// browser decision in Vocatrya's UI — login prints the authorize URL
// instead of opening it.
function cursorEnv({ profileDir, baseEnv }) {
  const env = buildRuntimeProcessEnvironment({
    baseEnv,
    definition: cursorDefinition(),
    profileDir,
  });
  env.NO_OPEN_BROWSER = "1";
  return env;
}

// Executable contract: the versioned bundle's node.exe. PATH shims are
// not spawnable (shell:false) and may belong to a different product
// (`agent` collides with Grok's CLI), so the versions dir is the only
// trusted source. rawPath is accepted only when it already is the
// bundle's node.exe.
function resolveCursorExecutable(rawPath, deps = {}) {
  const env = deps.env || process.env;
  const resolved = resolveRuntimeBundle(cursorDefinition(), env, {
    existsSyncImpl: deps.existsSyncImpl,
    readdirSyncImpl: deps.readdirSyncImpl,
  });
  if (resolved) return resolved.executable;
  const existsSync = deps.existsSyncImpl || fs.existsSync;
  if (
    rawPath &&
    /node\.exe$/i.test(rawPath) &&
    existsSync(rawPath) &&
    existsSync(path.join(path.dirname(rawPath), "index.js"))
  ) {
    return rawPath;
  }
  return null;
}

// argv = [index.js, ...configArgs, ...commandArgs] — the interpreter gets
// the bundle entrypoint first, then the registry invocation args.
function cursorArgs({ executablePath, profileDir, commandArgs }) {
  const definition = cursorDefinition();
  return [
    ...bundleEntrypointArgs(definition, executablePath),
    ...buildRuntimeInvocationArgs({ definition, profileDir }),
    ...commandArgs,
  ];
}

function buildCursorLoginInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedCursorConfig(profileDir);
  return {
    executable: executablePath,
    args: cursorArgs({ executablePath, profileDir, commandArgs: ["login"] }),
    env: cursorEnv({ profileDir, baseEnv }),
    cwd: profileDir,
  };
}

function buildCursorLogoutInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedCursorConfig(profileDir);
  return {
    executable: executablePath,
    args: cursorArgs({ executablePath, profileDir, commandArgs: ["logout"] }),
    env: cursorEnv({ profileDir, baseEnv }),
    cwd: profileDir,
  };
}

function buildCursorStatusInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedCursorConfig(profileDir);
  return {
    executable: executablePath,
    args: cursorArgs({
      executablePath,
      profileDir,
      commandArgs: ["status", "--format", "json"],
    }),
    env: cursorEnv({ profileDir, baseEnv }),
    cwd: profileDir,
  };
}

function buildCursorModelsInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedCursorConfig(profileDir);
  return {
    executable: executablePath,
    args: cursorArgs({ executablePath, profileDir, commandArgs: ["models"] }),
    env: cursorEnv({ profileDir, baseEnv }),
    cwd: profileDir,
  };
}

// Minimal-permission headless print invocation: print mode defaults to
// every tool (write + shell), so the boundary is layered — managed
// cli-config.json denies all tool classes, approvalMode stays `allowlist`,
// ask mode is read-only, the sandbox flag is enabled, project configs and
// workspace context are excluded, auto-update is off, and cwd is a fresh
// Vocatrya-owned temp dir. Never -f/--force/--yolo, never
// approvalMode=unrestricted. The prompt is written to piped stdin —
// `agent -p` with no positional prompt reads non-TTY stdin to EOF — so
// long business prompts never ride on the Windows command line.
function buildCursorPrintInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  prompt,
}) {
  writeManagedCursorConfig(profileDir);
  const commandArgs = [
    "-p",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--output-format",
    "json",
    "--disable-auto-update",
    "--disable-project-configs",
    "--exclude-workspace-context",
    ...(typeof model === "string" && model ? ["--model", model] : []),
  ];
  return {
    executable: executablePath,
    args: cursorArgs({ executablePath, profileDir, commandArgs }),
    env: cursorEnv({ profileDir, baseEnv }),
    cwd: workingDirectory,
    stdinPipe: true,
    onStdinReady: promptStdinWriter(prompt),
  };
}

// Streaming variant (cursor-agent 2026.09.18): `--output-format
// streaming-json` emits NDJSON — one ACP session update per line — so
// assistant text arrives as agent_message_chunk increments. Every safety
// flag of the print invocation is preserved unchanged.
function buildCursorStreamingInvocation(args) {
  const invocation = buildCursorPrintInvocation(args);
  const nextArgs = invocation.args.slice();
  const formatIndex = nextArgs.indexOf("--output-format");
  if (formatIndex === -1) return invocation;
  nextArgs[formatIndex + 1] = "streaming-json";
  return { ...invocation, args: nextArgs };
}

// `agent status --format json` — the machine-readable auth surface.
// status: "authenticated" | "partially-authenticated" | "unauthenticated"
// | "error". A managed profile can only reach `authenticated` through
// the browser login flow (env credential overrides are stripped and no
// key/token flag is ever passed), so authenticated ⇒ CURSOR_BROWSER_ACCOUNT.
function parseCursorAuthStatus({ exitCode, stdout, stderr }) {
  let parsed = null;
  try {
    parsed = JSON.parse((stdout || "").trim());
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    // Text fallback: strict keyword parse of `agent status` output.
    const text = `${stdout || ""}\n${stderr || ""}`.toLowerCase();
    if (/logged in as\s+(\S+)/.test(text)) {
      return {
        authState: "AUTHENTICATED",
        authMethod: "CURSOR_BROWSER_ACCOUNT",
        accountIdentity: text.match(/logged in as\s+(\S+)/)[1],
      };
    }
    if (/login successful/.test(text)) {
      return {
        authState: "AUTHENTICATED",
        authMethod: "CURSOR_BROWSER_ACCOUNT",
        accountIdentity: null,
      };
    }
    if (/not logged in|unauthenticated/.test(text)) {
      return {
        authState: "NOT_AUTHENTICATED",
        authMethod: null,
        accountIdentity: null,
      };
    }
    if (exitCode !== 0) {
      return {
        authState: "NOT_AUTHENTICATED",
        authMethod: null,
        accountIdentity: null,
      };
    }
    return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
  }
  const status = typeof parsed.status === "string" ? parsed.status : "";
  const identity =
    parsed.userInfo && typeof parsed.userInfo.email === "string"
      ? parsed.userInfo.email
      : typeof parsed.userInfo?.userId === "string"
        ? `user:${parsed.userInfo.userId}`
        : null;
  if (status === "authenticated" && parsed.isAuthenticated === true) {
    return {
      authState: "AUTHENTICATED",
      authMethod: "CURSOR_BROWSER_ACCOUNT",
      accountIdentity: identity,
    };
  }
  if (status === "partially-authenticated") {
    return {
      authState: "REAUTH_REQUIRED",
      authMethod: null,
      accountIdentity: identity,
    };
  }
  if (status === "unauthenticated" || parsed.isAuthenticated === false) {
    return {
      authState: "NOT_AUTHENTICATED",
      authMethod: null,
      accountIdentity: null,
    };
  }
  return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
}

// `agent models` authenticated output is a human-readable list (the
// command has no --format json). Conservative parser: each non-empty
// line's first token is a candidate id; decorative/header lines are
// skipped. Anything unrecognized yields [] so the service falls back to
// MODEL_DISCOVERY_UNAVAILABLE rather than inventing a catalog.
const CURSOR_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,80}$/;
const CURSOR_MODEL_SKIP_RE =
  /^(available|default|model|models|using|logged|you|current|selected|error|warning|no\b|[-=*+#\s])/i;

function parseCursorModelList(stdout) {
  const text = (stdout || "").replace(/\[[0-9;]*[A-Za-z]/g, "");
  const seen = new Set();
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || CURSOR_MODEL_SKIP_RE.test(trimmed)) continue;
    const token = trimmed.split(/\s+/)[0];
    if (!CURSOR_MODEL_ID_RE.test(token)) continue;
    if (token.includes("://")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    models.push({ id: token, displayName: token });
  }
  return models;
}

// Print-mode JSON output: {type:"result", subtype:"success",
// is_error:false, result:"..."} — newer fields may appear; only the
// essentials are required.
function parseCursorSmokeResult(result) {
  const stdout = (result.stdout || "").trim();
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      if (parsed.is_error === true || parsed.subtype === "error") {
        return { text: "", reportedError: true };
      }
      const text =
        typeof parsed.result === "string"
          ? parsed.result
          : typeof parsed.text === "string"
            ? parsed.text
            : "";
      return { text: text.trim(), reportedError: false };
    }
  } catch {
    // fall through to text parsing
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { text: lines[lines.length - 1] || "", reportedError: false };
}

const cursorAdapter = {
  backendKind: CURSOR_BACKEND_KIND,
  accountProvider: CURSOR_ACCOUNT_PROVIDER,
  // Same binding contract as every other adapter — a foreign provider
  // request binds to null, never to this adapter.
  forAccountProvider(provider) {
    return provider == null || provider === CURSOR_ACCOUNT_PROVIDER
      ? cursorAdapter
      : null;
  },
  loginGuardKey: "cursor:login",
  smokeExpected: CURSOR_SMOKE_EXPECTED,

  resolveExecutable(rawPath, deps = {}) {
    return resolveCursorExecutable(rawPath, deps);
  },

  buildLoginInvocation(args) {
    return buildCursorLoginInvocation(args);
  },

  buildLogoutInvocation(args) {
    return buildCursorLogoutInvocation(args);
  },

  buildStatusInvocation(args) {
    return buildCursorStatusInvocation(args);
  },

  parseAuthStatus(result) {
    return parseCursorAuthStatus(result);
  },

  // The official login URL surfaces in the login process output; only
  // cursor.com loginDeepControl links are forwarded to the renderer.
  extractLoginUrl(output) {
    const match = (output || "").match(CURSOR_LOGIN_URL_RE);
    return match ? match[0] : null;
  },

  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    return status.authMethod === "CURSOR_BROWSER_ACCOUNT"
      ? null
      : "UNSUPPORTED_AUTH_METHOD";
  },

  // Defense in depth: an AUTHENTICATED status whose method is not the
  // managed browser-account flow must never flip a connection to
  // CONNECTED — reported as UNKNOWN, which maps to ERROR.
  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authMethod !== "CURSOR_BROWSER_ACCOUNT"
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  // `agent models` under the managed profile — the authoritative catalog.
  // Unauthenticated or unparseable output yields an empty list; the
  // service maps that to MODEL_DISCOVERY_UNAVAILABLE.
  async listModels({ executablePath, profileDir, baseEnv, runner, timeoutMs, signal }) {
    const invocation = buildCursorModelsInvocation({
      executablePath,
      profileDir,
      baseEnv,
    });
    const result = await runner({ ...invocation, timeoutMs, signal });
    if (result.error || result.timedOut) {
      return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
    }
    if (result.exitCode !== 0) {
      return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
    }
    const models = parseCursorModelList(result.stdout);
    if (models.length === 0) {
      return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
    }
    return {
      dynamicDiscoverySupported: true,
      models: models.map((m) => ({
        ...m,
        source: "RUNTIME",
        availability: "available",
      })),
    };
  },

  buildSmokeInvocation(args) {
    return buildCursorPrintInvocation({ ...args, prompt: CURSOR_SMOKE_PROMPT });
  },

  // TEXT_ONLY business execution — the same minimum-permission print
  // invocation; the caller's prompt is written to piped stdin, never an
  // argv element.
  buildTextInvocation(args) {
    return buildCursorPrintInvocation(args);
  },

  // Streaming TEXT_ONLY — the locked-down print invocation switched to
  // `--output-format streaming-json` (NDJSON ACP session updates).
  buildStreamingInvocation(args) {
    return buildCursorStreamingInvocation(args);
  },
  createStreamParser: createCursorStreamParser,
  streamMechanism: "agent -p --output-format streaming-json",

  extractText({ result }) {
    return parseCursorSmokeResult(result);
  },

  extractSmokeText({ result }) {
    return parseCursorSmokeResult(result);
  },
};

module.exports = {
  CURSOR_ACCOUNT_PROVIDER,
  CURSOR_BACKEND_KIND,
  CURSOR_LOGIN_URL_RE,
  CURSOR_PERMISSION_DENY,
  CURSOR_SMOKE_EXPECTED,
  CURSOR_SMOKE_PROMPT,
  buildCursorLoginInvocation,
  buildCursorLogoutInvocation,
  buildCursorModelsInvocation,
  buildCursorPrintInvocation,
  buildCursorStreamingInvocation,
  buildCursorStatusInvocation,
  cursorAdapter,
  cursorEnv,
  parseCursorAuthStatus,
  parseCursorModelList,
  parseCursorSmokeResult,
  resolveCursorExecutable,
  writeManagedCursorConfig,
};
