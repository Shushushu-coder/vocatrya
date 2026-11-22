// Phase I Devin adapter for the DEVIN_RUNTIME backend (Devin account login).
//
// Boundaries (verified against devin 3000.10.31 on Windows):
// - Credential isolation is the redirected USERPROFILE — the CLI resolves
//   %USERPROFILE%\AppData\Roaming\devin\credentials.toml and canonicalizes
//   <home>\AppData\{Roaming,Local} at startup (fail-closed when missing),
//   so the adapter materializes that skeleton before every spawn. APPDATA/
//   XDG_* alone do NOT move credentials; --config relocates config.json but
//   never credentials.toml, so it is not part of the boundary.
// - `devin auth login` renders an interactive TUI menu (browser / manual
//   token / enterprise) that reads console input events — it cannot be
//   driven over pipes. The launch goes through `cmd /d /c start /wait`,
//   which allocates a real console window owned by the CLI and blocks
//   until the login process exits. `start /wait` does NOT propagate the
//   child's exit code (it exits 0 even when the CLI was killed), so login
//   success is never inferred from the exit code — the `auth status`
//   probe is the only verdict. The vendor CLI owns the browser flow.
// - `devin auth status` distinguishes auth methods via "Logged in (via
//   <method>)." — only "via Devin" (the browser account session) may
//   complete an ACCOUNT_LOGIN connection. PAT/API-key/service sessions
//   report a different method or fail to verify.
// - `devin models list --format json` prints the account-visible catalog
//   ({families[].variants[]{model_uid,label}}) for the managed profile.
// - `devin -p` needs a pinned org — `cloud drs whoami` reports the
//   account's org_id and the adapter persists it into the managed config's
//   devin.org_id so print never hits the interactive picker.
// - There is no OS-level sandbox on Windows (--sandbox requires WSL /
//   refuses to start). Enforcement is the managed config's deny rules plus
//   `--permission-mode auto` (shell/writes/fetches can never prompt in
//   print mode and are denied outright), a Vocatrya-owned temp cwd, and
//   `read_config_from`/`subagents_enabled`/`auto_update` all disabled.
const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeDefinition } = require("./registry");
const { createPlainTextStreamParser } = require("./streaming");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { writePromptFile } = require("./prompt-input");

const DEVIN_BACKEND_KIND = "DEVIN_RUNTIME";
const DEVIN_ACCOUNT_PROVIDER = "DEVIN";

const DEVIN_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_DEVIN_OK";
const DEVIN_SMOKE_EXPECTED = "VOCATRYA_DEVIN_OK";

const DEVIN_ORG_INFO_TIMEOUT_MS = 15_000;

// Auth classification. Only DEVIN_ACCOUNT (the browser account session,
// "Logged in (via Devin).") may ever complete an ACCOUNT_LOGIN connection.
const DEVIN_AUTH_KINDS = Object.freeze([
  "DEVIN_ACCOUNT",
  "PAT",
  "API_KEY",
  "SERVICE_ACCOUNT",
  "UNKNOWN",
]);
const DEVIN_ACCOUNT_KIND = "DEVIN_ACCOUNT";

const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\[[0-9;?]*[A-Za-z]",
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\([0-9A-Z]",
    "\\x1b.",
  ].join("|"),
  "g",
);

// Vocatrya-owned minimal config written into every managed profile
// (<home>\AppData\Roaming\devin\config.json). Deny-by-default permissions
// pin the tool surface (no shell, no edits/writes, no MCP tools, no reads
// outside the cwd scope), read_config_from blocks every cross-tool config
// import (Cursor/Windsurf/Claude/Copilot/OpenCode/VS Code/Zed and the
// AGENTS.md standard), subagents and the background updater are off, and
// workspace-trust prompts are skipped because a managed smoke cwd is a
// fresh Vocatrya temp dir that can never be pre-trusted. `devin.org_id`
// written by prepareSession is preserved across rewrites.
const DEVIN_MANAGED_CONFIG = Object.freeze({
  version: 1,
  auto_update: false,
  notify: "never",
  show_hints: false,
  subagents_enabled: false,
  respect_workspace_trust: false,
  hooks: {},
  read_config_from: {
    agents_standard: false,
    cursor: false,
    windsurf: false,
    claude: false,
    copilot: false,
    opencode: false,
    vscode: false,
    zed: false,
  },
  permissions: {
    deny: [
      // Tool-level denials cover the whole shell/edit surface; scoped
      // rules belt the path-level variants a future version might add.
      "exec",
      "edit",
      "mcp__*",
      "Write(**)",
      "Write(/**)",
      "Read(/**)",
    ],
  },
});

function devinDefinition() {
  const definition = getRuntimeDefinition(DEVIN_BACKEND_KIND);
  if (!definition) throw new Error("DEVIN_RUNTIME is not registered");
  return definition;
}

// The official install drops a real devin.exe — directly spawnable with
// shell:false. A .cmd/extensionless PATH shim resolves to the sibling
// devin.exe only; no filesystem walks.
function resolveDevinExecutable(
  executablePath,
  { existsSyncImpl = fs.existsSync } = {},
) {
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    return null;
  }
  if (/\.exe$/i.test(executablePath)) {
    return existsSyncImpl(executablePath) ? executablePath : null;
  }
  const sibling = path.join(path.dirname(executablePath), "devin.exe");
  return existsSyncImpl(sibling) ? sibling : null;
}

function devinConfigPath(profileDir) {
  return path.join(
    profileDir,
    "home",
    "AppData",
    "Roaming",
    "devin",
    "config.json",
  );
}

// The CLI canonicalizes <USERPROFILE>\AppData\Roaming and
// <USERPROFILE>\AppData\Local before doing anything else and aborts with
// "Failed to determine config directory" when they do not exist
// (verified 3000.10.31). Both are materialized up front.
function ensureDevinProfileSkeleton(
  profileDir,
  { mkdirSyncImpl = fs.mkdirSync } = {},
) {
  const home = path.join(profileDir, "home");
  mkdirSyncImpl(path.join(home, "AppData", "Roaming"), { recursive: true });
  mkdirSyncImpl(path.join(home, "AppData", "Local"), { recursive: true });
}

// Idempotent: applies the Vocatrya-managed keys over whatever the CLI has
// written (devin.org_id, shell.setup_complete, ...) without disturbing
// CLI-owned fields. Never merges host config — the file lives inside the
// managed profile and is rewritten whenever a managed key drifts.
function writeManagedDevinConfig(
  profileDir,
  {
    existsSyncImpl = fs.existsSync,
    readFileSyncImpl = fs.readFileSync,
    writeFileSyncImpl = fs.writeFileSync,
    mkdirSyncImpl = fs.mkdirSync,
  } = {},
) {
  ensureDevinProfileSkeleton(profileDir, { mkdirSyncImpl });
  const target = devinConfigPath(profileDir);
  let existing = null;
  if (existsSyncImpl(target)) {
    try {
      const parsed = JSON.parse(readFileSyncImpl(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      existing = null;
    }
  }
  const next = { ...(existing || {}), ...DEVIN_MANAGED_CONFIG };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let current = null;
  if (existing) {
    try {
      current = readFileSyncImpl(target, "utf8");
    } catch {
      current = null;
    }
  }
  if (current === serialized) return;
  mkdirSyncImpl(path.dirname(target), { recursive: true });
  writeFileSyncImpl(target, serialized, "utf8");
}

// browserLogin — only for `devin auth login`: the CLI opens the default
// browser with ShellExecute, and the spawned browser resolves its
// user-data dir from %LOCALAPPDATA% (Chrome/Edge) or %APPDATA% (Firefox).
// Redirected roots would launch a fresh browser profile without the
// user's existing app.devin.ai session. The registry-declared
// browserLoginEnvPassthrough restores those host roots for the login
// process; USERPROFILE — the credentials.toml boundary — stays managed,
// so the account session still lands in the profile.
function devinEnv({ profileDir, baseEnv, browserLogin = false }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: devinDefinition(),
    profileDir,
    browserLogin,
  });
}

function devinArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({
      definition: devinDefinition(),
      profileDir,
    }),
    ...commandArgs,
  ];
}

// `devin auth login` cannot run over pipes: its method menu reads console
// input events, not stdin bytes (verified — piped keystrokes are ignored).
// The login therefore launches inside a real console window created by
// `start /wait`, which blocks until the vendor CLI exits — the exit code
// is not meaningful (start does not propagate it), so completion is always
// judged by the `auth status` probe that follows. cmd.exe is a fixed
// terminal launcher, not a command surface — argv is static, the spawn
// boundary stays shell:false, and the renderer never influences any of
// it. On cancel/timeout the managed cmd.exe is killed; the detached
// console window may linger for the user to close (its TUI supports
// Esc-cancel itself).
function buildDevinLoginInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedDevinConfig(profileDir);
  return {
    executable: "cmd.exe",
    args: [
      "/d",
      "/c",
      "start",
      "",
      "/wait",
      executablePath,
      ...devinDefinition().commands.login,
    ],
    cwd: profileDir,
    env: devinEnv({ profileDir, baseEnv, browserLogin: true }),
  };
}

function buildDevinLogoutInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedDevinConfig(profileDir);
  return {
    executable: executablePath,
    args: devinArgs({
      profileDir,
      commandArgs: devinDefinition().commands.logout,
    }),
    cwd: profileDir,
    env: devinEnv({ profileDir, baseEnv }),
  };
}

function buildDevinStatusInvocation({ executablePath, profileDir, baseEnv }) {
  writeManagedDevinConfig(profileDir);
  return {
    executable: executablePath,
    args: devinArgs({
      profileDir,
      commandArgs: devinDefinition().commands.status,
    }),
    cwd: profileDir,
    env: devinEnv({ profileDir, baseEnv }),
  };
}

function devinAuthResult(authState, extra = {}) {
  return {
    authState,
    authKind: null,
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
    ...extra,
  };
}

// Maps the "Logged in (via <method>)" suffix onto the spec §17 taxonomy.
// Verified on 3000.10.31: the browser account login prints "via Devin".
// Anything token-shaped is classified so it can be rejected explicitly; an
// unrecognized method is UNKNOWN and can never complete ACCOUNT_LOGIN.
function classifyDevinAuthVia(via) {
  const value = String(via || "").trim();
  if (/^devin$/i.test(value)) return DEVIN_ACCOUNT_KIND;
  if (/token|pat|personal/i.test(value)) return "PAT";
  if (/api|key|service/i.test(value)) return "API_KEY";
  return "UNKNOWN";
}

function extractLabeledField(text, label) {
  const match = text.match(
    new RegExp(`^\\s*${label}:\\s*(\\S.*)$`, "im"),
  );
  return match ? match[1].trim() : null;
}

// Verified output shape (devin 3000.10.31):
//   Logged in (via Devin).                    |  Not logged in.
//   Credentials:  File: ...                   |    Credentials path: ...
//   User:   Name / Email / User ID            |    Run `devin auth login`...
//   Account: Tier / Plan / Team ID / Enterprise
// Classification keys off the "(via <method>)" phrase — never off exit 0.
function parseDevinAuthStatus({ exitCode, stdout, stderr }) {
  const text = `${stdout || ""}\n${stderr || ""}`.replace(ANSI_PATTERN, "");
  if (/not\s+logged\s+in/i.test(text)) {
    return devinAuthResult("NOT_AUTHENTICATED");
  }
  const via = text.match(/logged\s+in\s+\(via\s+([^)]+)\)/i);
  if (!via) {
    return devinAuthResult(exitCode === 0 ? "UNKNOWN" : "NOT_AUTHENTICATED");
  }
  const authKind = classifyDevinAuthVia(via[1]);
  const accountIdentity = extractLabeledField(text, "Email");
  const providerMetadata = {};
  for (const [label, key] of [
    ["Name", "name"],
    ["User ID", "userId"],
    ["Tier", "tier"],
    ["Plan", "plan"],
    ["Team ID", "teamId"],
    ["Enterprise", "enterprise"],
  ]) {
    const value = extractLabeledField(text, label);
    if (value) providerMetadata[key] = value;
  }
  return devinAuthResult("AUTHENTICATED", {
    authKind,
    authMethod: via[1].trim(),
    accountIdentity,
    providerMetadata:
      Object.keys(providerMetadata).length > 0 ? providerMetadata : null,
  });
}

// ---------------------------------------------------------------------------
// Org pinning — `devin -p` needs a selected organization or it blocks on an
// interactive picker (verified 3000.10.31). `cloud drs whoami` is a
// read-only metadata call that reports the account's org_id; it is pinned
// into the managed config's devin.org_id. Best-effort: failures leave the
// config untouched and smoke simply reports INFERENCE_FAILED.
// ---------------------------------------------------------------------------
function managedConfigHasOrgId(profileDir, deps = {}) {
  const existsSyncImpl = deps.existsSyncImpl || fs.existsSync;
  const readFileSyncImpl = deps.readFileSyncImpl || fs.readFileSync;
  const target = devinConfigPath(profileDir);
  if (!existsSyncImpl(target)) return false;
  try {
    const parsed = JSON.parse(readFileSyncImpl(target, "utf8"));
    return Boolean(parsed?.devin?.org_id);
  } catch {
    return false;
  }
}

async function prepareDevinSession({
  executablePath,
  profileDir,
  baseEnv,
  runner,
  timeoutMs = DEVIN_ORG_INFO_TIMEOUT_MS,
  signal,
}) {
  writeManagedDevinConfig(profileDir);
  if (managedConfigHasOrgId(profileDir)) return;
  let result;
  try {
    result = await runner({
      executable: executablePath,
      args: devinArgs({
        profileDir,
        commandArgs: devinDefinition().commands.orgInfo,
      }),
      cwd: profileDir,
      env: devinEnv({ profileDir, baseEnv }),
      timeoutMs,
      signal,
    });
  } catch {
    return;
  }
  if (!result || result.error || result.timedOut || result.exitCode !== 0) {
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "");
  } catch {
    parsed = null;
  }
  const orgId = parsed?.org_id;
  if (typeof orgId !== "string" || !/^[\w$-]+$/.test(orgId)) return;
  const target = devinConfigPath(profileDir);
  try {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    existing.devin = { ...(existing.devin || {}), org_id: orgId };
    fs.writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  } catch {
    // Never block the lifecycle on org pinning.
  }
}

// ---------------------------------------------------------------------------
// Model discovery — `devin models list --format json` (spec §25-§27).
// ---------------------------------------------------------------------------

// Verified output (3000.10.31): { families: [ { slug, label, variants: [
// { model_uid, label, description, max_context_tokens, cost_tier, ... } ] } ] }
// Variants are the concrete selectable models; family slugs are fuzzy
// aliases accepted by --model but are not listed separately.
function parseDevinModelList(stdout) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout || "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const families = Array.isArray(parsed.families) ? parsed.families : [];
  const models = [];
  for (const family of families) {
    const variants = Array.isArray(family?.variants) ? family.variants : [];
    for (const variant of variants) {
      const id = variant?.model_uid;
      if (typeof id !== "string" || id.length === 0) continue;
      models.push({
        id,
        displayName:
          typeof variant.label === "string" && variant.label ? variant.label : id,
        isDefault: variant.is_default === true,
      });
    }
  }
  return models;
}

async function listDevinModels({
  executablePath,
  profileDir,
  baseEnv,
  runner,
  timeoutMs,
  signal,
}) {
  writeManagedDevinConfig(profileDir);
  const result = await runner({
    executable: executablePath,
    args: devinArgs({
      profileDir,
      commandArgs: devinDefinition().commands.models,
    }),
    cwd: profileDir,
    env: devinEnv({ profileDir, baseEnv }),
    timeoutMs,
    signal,
    // The account-visible catalog can run to several hundred KB of JSON —
    // the runner's default 256KB cap would truncate it into unparseable
    // output, so this call opts into a larger bound.
    maxCaptureBytes: 8 * 1024 * 1024,
  });
  if (result.error || result.timedOut || result.exitCode !== 0) {
    return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
  }
  const models = parseDevinModelList(result.stdout);
  if (!models || models.length === 0) {
    return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
  }
  return {
    dynamicDiscoverySupported: true,
    models: models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      source: "RUNTIME",
      availability: "available",
    })),
  };
}

// ---------------------------------------------------------------------------
// Headless smoke — `devin -p` (spec §28-§39).
// ---------------------------------------------------------------------------

// Minimum-permission one-shot. `--permission-mode auto` is the most
// restrictive mode — shell, writes, and fetches can never prompt in print
// mode and the managed config's deny rules block them outright. There is
// no OS sandbox on Windows (--sandbox requires WSL and refuses without
// it), `--respect-workspace-trust false` skips the untrusted-cwd gate that
// print mode cannot answer, and cwd is a fresh Vocatrya temp dir with no
// project files. No cloud/handoff/ACP flags — this stays a local
// short-task path.
// The prompt rides `--prompt-file <file inside the fresh workDir>`
// (verified in `devin --help` on 3000.11.228 and the documented
// `devin -p --prompt-file <file>` headless form) — long business prompts
// never ride on the Windows command line, and the file is removed with
// the workDir.
function buildDevinPrintInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  prompt,
}) {
  writeManagedDevinConfig(profileDir);
  const args = [
    ...devinArgs({ profileDir, commandArgs: devinDefinition().commands.print }),
    "--prompt-file",
    writePromptFile(workingDirectory, prompt),
    "--permission-mode",
    "auto",
    "--respect-workspace-trust",
    "false",
  ];
  if (typeof model === "string" && model.length > 0) {
    args.push("--model", model);
  }
  return {
    executable: executablePath,
    args,
    cwd: workingDirectory,
    env: devinEnv({ profileDir, baseEnv }),
  };
}

// `-p` prints the assistant text on stdout, possibly after a first-run
// banner ("Welcome to Devin CLI!"). The expected marker wins if any line
// carries it exactly; otherwise the last non-empty line is returned.
function parseDevinPrintResult({ stdout, stderr }) {
  const lines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_PATTERN, "").trim())
    .filter(Boolean);
  const marker = lines.find((line) => line === DEVIN_SMOKE_EXPECTED);
  return {
    text: marker ?? lines[lines.length - 1] ?? "",
    reportedError: false,
  };
}

// Capability self-check prompt (devin-capability-probe.js). One trivial
// reply that doubles as the streaming probe (text must arrive on stdout and
// reconcile) and the structured probe (the reply must be a JSON object of
// the expected shape).
const DEVIN_CAPABILITY_PROBE_TOKEN = "VOCATRYA_CAPABILITY_PROBE";
const DEVIN_CAPABILITY_PROBE_PROMPT =
  'Reply with exactly this JSON object and nothing else: {"probe":"' +
  DEVIN_CAPABILITY_PROBE_TOKEN +
  '","ok":true}';

// Provider adapter contract consumed by connection-service.js (same shape
// as codex/claude/opencode/grok).
const devinAdapter = {
  backendKind: DEVIN_BACKEND_KIND,
  // The Devin runtime only ever authenticates a Devin account.
  accountProvider: DEVIN_ACCOUNT_PROVIDER,
  forAccountProvider(provider) {
    return provider == null || provider === DEVIN_ACCOUNT_PROVIDER
      ? devinAdapter
      : null;
  },
  loginGuardKey: "devin:login",
  smokePrompt: DEVIN_SMOKE_PROMPT,
  smokeExpected: DEVIN_SMOKE_EXPECTED,
  resolveExecutable: resolveDevinExecutable,
  buildLoginInvocation: buildDevinLoginInvocation,
  buildLogoutInvocation: buildDevinLogoutInvocation,
  buildStatusInvocation: buildDevinStatusInvocation,
  parseAuthStatus: parseDevinAuthStatus,
  prepareSession: prepareDevinSession,
  checkLoginPolicy: null,

  // Post-login verification: only a "via Devin" account session completes
  // an ACCOUNT_LOGIN connection. A recognized token/API-key method is
  // UNSUPPORTED_AUTH_METHOD; an unclassifiable session is
  // AUTH_METHOD_UNVERIFIED — never accepted.
  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    if (status.authKind === DEVIN_ACCOUNT_KIND) return null;
    return status.authKind && status.authKind !== "UNKNOWN"
      ? "UNSUPPORTED_AUTH_METHOD"
      : "AUTH_METHOD_UNVERIFIED";
  },

  // A verified non-account-login state must never flip an ACCOUNT_LOGIN
  // connection to CONNECTED — reported as UNKNOWN, which maps to ERROR.
  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authKind !== DEVIN_ACCOUNT_KIND
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  listModels: listDevinModels,

  buildSmokeInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
  }) {
    return buildDevinPrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt: DEVIN_SMOKE_PROMPT,
    });
  },

  // TEXT_ONLY business execution — same locked-down `devin -p` invocation
  // as smoke; the caller-supplied prompt rides a --prompt-file inside the
  // fresh workDir, never an argv element.
  buildTextInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
    prompt,
  }) {
    return buildDevinPrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt,
    });
  },

  // Streaming TEXT_ONLY — `devin -p` has no event transport; stdout is the
  // delta channel itself. The plain-text parser treats each delivered
  // chunk as an increment; whether the CLI actually flushes incrementally
  // (rather than buffering to exit) is exactly what verification measures.
  buildStreamingInvocation(args) {
    return buildDevinPrintInvocation(args);
  },
  createStreamParser: createPlainTextStreamParser,
  streamMechanism: "devin -p",

  // Same locked-down `devin -p` as every other path; only the prompt differs.
  buildCapabilityProbeInvocation(args) {
    return buildDevinPrintInvocation({
      ...args,
      prompt: DEVIN_CAPABILITY_PROBE_PROMPT,
    });
  },

  extractText({ result }) {
    return parseDevinPrintResult(result);
  },

  extractSmokeText({ result }) {
    return parseDevinPrintResult(result);
  },
};

module.exports = {
  DEVIN_ACCOUNT_KIND,
  DEVIN_ACCOUNT_PROVIDER,
  DEVIN_AUTH_KINDS,
  DEVIN_BACKEND_KIND,
  DEVIN_CAPABILITY_PROBE_PROMPT,
  DEVIN_CAPABILITY_PROBE_TOKEN,
  DEVIN_MANAGED_CONFIG,
  DEVIN_SMOKE_EXPECTED,
  DEVIN_SMOKE_PROMPT,
  buildDevinLoginInvocation,
  buildDevinLogoutInvocation,
  buildDevinPrintInvocation,
  buildDevinStatusInvocation,
  classifyDevinAuthVia,
  devinAdapter,
  devinConfigPath,
  devinEnv,
  ensureDevinProfileSkeleton,
  listDevinModels,
  managedConfigHasOrgId,
  parseDevinAuthStatus,
  parseDevinModelList,
  parseDevinPrintResult,
  prepareDevinSession,
  resolveDevinExecutable,
  writeManagedDevinConfig,
};
