// Phase E Claude-specific helpers for the CLAUDE_RUNTIME backend.
//
// Everything here is Claude-aware but stays inside the Phase C boundaries:
// invocations are {executable, args[], cwd, env} objects for
// RuntimeCommandRunner (shell is always false), the process env comes only
// from buildRuntimeProcessEnvironment (managed CLAUDE_CONFIG_DIR + stripped
// credential/provider-route overrides), and credential files are never
// read — auth state is parsed solely from `claude auth status --json`.
const fs = require("node:fs");
const path = require("node:path");
const { serializeInlineSchema } = require("./structured-schema");
const { getRuntimeDefinition } = require("./registry");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { classifyAuthProbeOutput } = require("./auth-probe");

const CLAUDE_BACKEND_KIND = "CLAUDE_RUNTIME";

// Smoke contract (spec §26): the prompt asks the model to echo a fixed
// marker. Native Windows has no Claude sandbox, so the run relies on
// no-tool execution (--tools "") plus a Vocatrya-owned temporary cwd and
// no session persistence — no sandbox claim is made.
const CLAUDE_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_CLAUDE_OK";
const CLAUDE_SMOKE_EXPECTED = "VOCATRYA_CLAUDE_OK";

// `claude auth status` auth-method classification (spec §14). Only
// CLAUDE_AI_SUBSCRIPTION counts as a Phase E ACCOUNT_LOGIN success;
// every other verified method is surfaced so the service can report
// UNSUPPORTED_AUTH_METHOD instead of silently accepting e.g. a Console
// login or a cloud-provider route.
const CLAUDE_AUTH_KINDS = Object.freeze([
  "CLAUDE_AI_SUBSCRIPTION",
  "CONSOLE",
  "API_KEY",
  "AUTH_TOKEN",
  "OAUTH_ENV_TOKEN",
  "CLOUD_PROVIDER",
  "FEDERATION_PROFILE",
  "GATEWAY",
  "UNKNOWN",
]);

// Verified against claude 2.1.203 (`claude auth status --json`):
//   logged out: {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"} (exit 1)
//   claude.ai : {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
//                "email":"…","orgId":"…","orgName":"…","subscriptionType":"pro"} (exit 0)
const CLAUDE_AI_SUBSCRIPTION_KIND = "CLAUDE_AI_SUBSCRIPTION";

// Curated fallback catalog (spec §22). Claude Code 2.1.203 exposes no
// machine-readable model enumeration, so the catalog is the documented
// `--model` aliases. These are aliases, not entitlement claims:
// availability stays "unknown" until a real invocation proves otherwise.
// A custom full model id is always accepted via the --model flag.
const CLAUDE_CURATED_MODELS = Object.freeze([
  { id: "sonnet", displayName: "Sonnet (latest)" },
  { id: "opus", displayName: "Opus (latest)" },
  { id: "haiku", displayName: "Haiku (latest)" },
  { id: "fable", displayName: "Fable (latest)" },
]);

function claudeDefinition() {
  const definition = getRuntimeDefinition(CLAUDE_BACKEND_KIND);
  if (!definition) throw new Error("CLAUDE_RUNTIME is not registered");
  return definition;
}

// npm installs Claude through an extensionless/`*.cmd` shim — neither is
// spawnable with shell:false on Windows. The real binary is the vendored
// claude.exe inside @anthropic-ai/claude-code (bin: bin/claude.exe) or its
// platform package. This walk is bounded to the npm root's @anthropic-ai
// scope; it never scans the filesystem at large.
function resolveClaudeExecutable(
  executablePath,
  { existsSyncImpl = fs.existsSync, readdirSyncImpl = fs.readdirSync } = {},
) {
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    return null;
  }
  if (/\.exe$/i.test(executablePath)) {
    return existsSyncImpl(executablePath) ? executablePath : null;
  }
  const npmRoot = path.dirname(executablePath);
  const anthropicRoot = path.join(npmRoot, "node_modules", "@anthropic-ai");
  const candidates = [];
  const stack = [{ dir: anthropicRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > 8) continue;
    let entries;
    try {
      entries = readdirSyncImpl(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Dot-prefixed directories are npm staging areas.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (/^claude\.exe$/i.test(entry.name) && /claude-code/i.test(dir)) {
        candidates.push(full);
      }
    }
  }
  candidates.sort();
  // Prefer the package's declared bin entry, then the win32-x64 vendor dir.
  const preferred =
    candidates.find((candidate) =>
      /claude-code[/\\]bin[/\\]claude\.exe$/i.test(candidate),
    ) ||
    candidates.find((candidate) => /claude-code-win32-x64/i.test(candidate)) ||
    candidates[0];
  return preferred && existsSyncImpl(preferred) ? preferred : null;
}

function claudeEnv({ profileDir, baseEnv }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: claudeDefinition(),
    profileDir,
  });
}

function claudeArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({ definition: claudeDefinition(), profileDir }),
    ...commandArgs,
  ];
}

// Interactive Claude.ai subscription login: `claude auth login --claudeai`
// starts the OAuth browser flow and waits on its callback. Long-running by
// design — the caller bounds it with timeoutMs and cancels via AbortSignal.
function buildClaudeLoginInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = claudeDefinition();
  return {
    executable: executablePath,
    args: claudeArgs({ profileDir, commandArgs: definition.commands.login }),
    cwd: profileDir,
    env: claudeEnv({ profileDir, baseEnv }),
  };
}

function buildClaudeLogoutInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = claudeDefinition();
  return {
    executable: executablePath,
    args: claudeArgs({ profileDir, commandArgs: definition.commands.logout }),
    cwd: profileDir,
    env: claudeEnv({ profileDir, baseEnv }),
  };
}

function buildClaudeStatusInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = claudeDefinition();
  return {
    executable: executablePath,
    args: claudeArgs({ profileDir, commandArgs: definition.authProbe.args }),
    cwd: profileDir,
    env: claudeEnv({ profileDir, baseEnv }),
  };
}

// Minimal non-interactive inference (spec §25, verified against claude
// 2.1.203 --help — this version has no --restricted/--permission-prompts):
//   --tools ""              disables every built-in tool
//   --disallowedTools mcp__*  belt-and-suspenders MCP deny
//   --safe-mode             disables CLAUDE.md, hooks, skills, plugins, MCP
//                           servers, and project settings (auth still works)
//   --permission-mode dontAsk  never prompts; permission-needing work is denied
//   --no-session-persistence nothing is written to the session store
//   --output-format json    machine-readable result envelope
// cwd is a Vocatrya-owned empty temp dir; nothing user-owned is reachable
// through tools because there are no tools.
function buildClaudePrintInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  prompt,
}) {
  const definition = claudeDefinition();
  const args = [
    ...buildRuntimeInvocationArgs({ definition, profileDir }),
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--safe-mode",
  ];
  if (typeof model === "string" && model.length > 0) {
    args.push("--model", model);
  }
  args.push(prompt);
  return {
    executable: executablePath,
    args,
    cwd: workingDirectory,
    env: claudeEnv({ profileDir, baseEnv }),
  };
}

// NATIVE_JSON_SCHEMA (claude 2.1.203): `claude -p --output-format json
// --json-schema <schema>` runs the same locked-down print invocation plus
// an inline JSON Schema. The CLI validates the final object via its
// StructuredOutput mechanism and reports it in the envelope's
// `structured_output` field (`result` stays empty). --tools "" is already
// required for this feature to work — which the print invocation always
// passes.
function buildClaudeStructuredInvocation(args) {
  const serialized = serializeInlineSchema(args.schema);
  const invocation = buildClaudePrintInvocation(args);
  const nextArgs = invocation.args.slice();
  // Insert before the trailing positional prompt element.
  nextArgs.splice(nextArgs.length - 1, 0, "--json-schema", serialized);
  return { ...invocation, args: nextArgs };
}

// Anthropic managed-settings locations (read-only check — spec §9). A
// device policy like {"forceLoginMethod":"console"} must never be
// circumvented; it is reported so the service can fail with
// PROVIDER_POLICY_RESTRICTED instead of attempting a flow that cannot
// produce a Claude.ai subscription login.
const MANAGED_SETTINGS_LOCATIONS = Object.freeze({
  win32: "{PROGRAMDATA}\\ClaudeCode\\managed-settings.json",
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
});

function detectManagedLoginPolicy({
  platform = process.platform,
  env = process.env,
  existsSyncImpl = fs.existsSync,
  readFileSyncImpl = fs.readFileSync,
} = {}) {
  const template =
    MANAGED_SETTINGS_LOCATIONS[platform] || MANAGED_SETTINGS_LOCATIONS.linux;
  const location = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
    const value = env?.[name];
    return typeof value === "string" && value.length > 0 ? value : m;
  });
  if (location.includes("{") || !existsSyncImpl(location)) {
    return { restricted: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSyncImpl(location, "utf8"));
  } catch {
    // An unreadable/corrupt policy file must not silently disable the check,
    // but it also cannot prove a restriction — the auth-status classifier
    // still guards the outcome.
    return { restricted: false, managedSettingsFound: true };
  }
  const forced =
    parsed && typeof parsed === "object"
      ? parsed.forceLoginMethod
      : undefined;
  if (typeof forced === "string" && forced.length > 0 && forced !== "claudeai") {
    return {
      restricted: true,
      managedSettingsFound: true,
      forcedLoginMethod: forced,
    };
  }
  return { restricted: false, managedSettingsFound: true };
}

// Parses `claude auth status --json` (spec §13/§14). The JSON envelope —
// never the .credentials.json file — is the source of truth:
//   exit 1 / {"loggedIn":false} → NOT_AUTHENTICATED
//   {"loggedIn":true, authMethod:"claude.ai", apiProvider:"firstParty"}
//     → AUTHENTICATED + CLAUDE_AI_SUBSCRIPTION
//   logged in through any other route → AUTHENTICATED + classified kind
//   unparseable/unrecognized shape → UNKNOWN (never guessed)
// Only whitelisted non-secret fields are extracted: email as identity,
// orgName/subscriptionType as provider metadata.
function parseClaudeAuthStatus({ exitCode, stdout, stderr }) {
  const empty = {
    authState: "NOT_AUTHENTICATED",
    authKind: null,
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
  };
  const unknown = { ...empty, authState: "UNKNOWN" };

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (exitCode === 1 || /not logged in/i.test(`${stdout}\n${stderr || ""}`)) {
      return empty;
    }
    if (exitCode === 0) {
      return {
        ...unknown,
        authState: classifyAuthProbeOutput({ exitCode, stdout, stderr }),
      };
    }
    return unknown;
  }

  if (parsed.loggedIn !== true) {
    return empty;
  }

  const authMethod =
    typeof parsed.authMethod === "string" ? parsed.authMethod : null;
  const apiProvider =
    typeof parsed.apiProvider === "string" ? parsed.apiProvider : null;
  const descriptor = `${authMethod || ""} ${apiProvider || ""}`;

  let authKind = "UNKNOWN";
  if (authMethod === "claude.ai" && apiProvider === "firstParty") {
    authKind = CLAUDE_AI_SUBSCRIPTION_KIND;
  } else if (/bedrock|vertex|foundry/i.test(descriptor)) {
    authKind = "CLOUD_PROVIDER";
  } else if (/^console$/i.test(authMethod || "")) {
    authKind = "CONSOLE";
  } else if (/api[-_ ]?key/i.test(descriptor)) {
    authKind = "API_KEY";
  } else if (/oauth/i.test(descriptor)) {
    authKind = "OAUTH_ENV_TOKEN";
  } else if (/token/i.test(descriptor)) {
    authKind = "AUTH_TOKEN";
  } else if (/federat|profile/i.test(descriptor)) {
    authKind = "FEDERATION_PROFILE";
  } else if (/gateway/i.test(descriptor)) {
    authKind = "GATEWAY";
  }

  const accountIdentity =
    typeof parsed.email === "string" && parsed.email.length > 0
      ? parsed.email
      : null;
  const providerMetadata = {};
  if (typeof parsed.orgName === "string" && parsed.orgName.length > 0) {
    providerMetadata.organizationName = parsed.orgName;
  }
  if (
    typeof parsed.subscriptionType === "string" &&
    parsed.subscriptionType.length > 0
  ) {
    providerMetadata.subscriptionType = parsed.subscriptionType;
  }
  if (authMethod) providerMetadata.loginMethod = authMethod;

  return {
    authState: "AUTHENTICATED",
    authKind,
    authMethod,
    accountIdentity,
    providerMetadata:
      Object.keys(providerMetadata).length > 0 ? providerMetadata : null,
  };
}

// Parses `claude -p --output-format json` output. The envelope is
// {type:"result", result:"…", is_error:bool, …}; is_error:true means the
// CLI completed but reported an error. Falls back to the last non-empty
// stdout line for text output.
// `--output-format json` envelope: {type:"result", subtype, is_error,
// result, ...}. With `--json-schema` the validated object lands in
// `structured_output` and `result` is empty — the schema-enforced payload
// wins when present; both remain model output, validated again locally.
function parseClaudePrintResult({ stdout, stderr }) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const reportedError =
      parsed.is_error === true ||
      (typeof parsed.subtype === "string" && /^error/.test(parsed.subtype));
    const stopReason =
      typeof parsed.stop_reason === "string"
        ? parsed.stop_reason
        : typeof parsed.subtype === "string" && parsed.subtype !== "success"
          ? parsed.subtype
          : null;
    if (parsed.structured_output !== undefined && parsed.structured_output !== null) {
      return {
        text: JSON.stringify(parsed.structured_output),
        reportedError,
        stopReason,
      };
    }
    const text =
      typeof parsed.result === "string"
        ? parsed.result
        : typeof parsed.error === "string"
          ? parsed.error
          : "";
    return { text: text.trim(), reportedError, stopReason };
  }
  const lines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { text: lines[lines.length - 1] || "", reportedError: false, stopReason: null };
}

// Provider adapter contract consumed by connection-service.js. Same shape
// as codexAdapter — startLogin/verify/disconnect/listModels/smoke all flow
// through this surface.
const claudeAdapter = {
  backendKind: CLAUDE_BACKEND_KIND,
  // Claude Code only ever authenticates an Anthropic account.
  accountProvider: "ANTHROPIC",
  forAccountProvider(provider) {
    return provider == null || provider === "ANTHROPIC"
      ? claudeAdapter
      : null;
  },
  loginGuardKey: "claude:login",
  smokePrompt: CLAUDE_SMOKE_PROMPT,
  smokeExpected: CLAUDE_SMOKE_EXPECTED,
  resolveExecutable: resolveClaudeExecutable,
  buildLoginInvocation: buildClaudeLoginInvocation,
  buildLogoutInvocation: buildClaudeLogoutInvocation,
  buildStatusInvocation: buildClaudeStatusInvocation,
  parseAuthStatus: parseClaudeAuthStatus,
  checkLoginPolicy: detectManagedLoginPolicy,

  // Post-login verification: only a Claude.ai subscription session counts.
  // A recognized non-subscription method is UNSUPPORTED_AUTH_METHOD; a
  // logged-in session the status JSON cannot classify is
  // AUTH_METHOD_UNVERIFIED — never silently accepted.
  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    if (status.authKind === CLAUDE_AI_SUBSCRIPTION_KIND) return null;
    return status.authKind && status.authKind !== "UNKNOWN"
      ? "UNSUPPORTED_AUTH_METHOD"
      : "AUTH_METHOD_UNVERIFIED";
  },

  // A verified session that is not Claude.ai subscription auth must never
  // mark an ACCOUNT_LOGIN connection CONNECTED — reported as UNKNOWN,
  // which maps to ERROR.
  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authKind !== CLAUDE_AI_SUBSCRIPTION_KIND
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  // No machine-readable model discovery exists in claude 2.1.203 — the
  // curated alias catalog is returned directly with availability "unknown".
  async listModels() {
    return {
      dynamicDiscoverySupported: false,
      models: CLAUDE_CURATED_MODELS.map((m) => ({
        ...m,
        source: "CURATED",
        availability: "unknown",
      })),
    };
  },

  buildSmokeInvocation({ executablePath, profileDir, baseEnv, workingDirectory, model }) {
    return buildClaudePrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt: CLAUDE_SMOKE_PROMPT,
    });
  },

  // TEXT_ONLY business execution — same locked-down print invocation as
  // smoke, caller-supplied prompt as a plain args element.
  buildTextInvocation({ executablePath, profileDir, baseEnv, workingDirectory, model, prompt }) {
    return buildClaudePrintInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      model,
      prompt,
    });
  },

  // NATIVE_JSON_SCHEMA — `claude -p --json-schema <schema>`; the schema is
  // an inline argv element, never a caller-supplied path.
  buildStructuredInvocation(args) {
    return buildClaudeStructuredInvocation(args);
  },

  extractText({ result }) {
    return parseClaudePrintResult(result);
  },

  extractSmokeText({ result }) {
    return parseClaudePrintResult(result);
  },
};

module.exports = {
  CLAUDE_AUTH_KINDS,
  CLAUDE_BACKEND_KIND,
  CLAUDE_CURATED_MODELS,
  CLAUDE_SMOKE_EXPECTED,
  CLAUDE_SMOKE_PROMPT,
  buildClaudeLoginInvocation,
  buildClaudeLogoutInvocation,
  buildClaudePrintInvocation,
  buildClaudeStructuredInvocation,
  buildClaudeStatusInvocation,
  claudeAdapter,
  detectManagedLoginPolicy,
  parseClaudeAuthStatus,
  parseClaudePrintResult,
  resolveClaudeExecutable,
};
