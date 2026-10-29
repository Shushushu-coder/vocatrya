// OpenCode adapter for the OPENCODE_RUNTIME backend.
//
// OpenCode is its own account ecosystem: the account providers are the
// vendor's own products — OpenCode Zen (pay-as-you-go gateway, provider id
// "opencode", auth.json "opencode" entry) and OpenCode Go (flat-rate
// subscription, provider id "opencode-go", auth.json "opencode-go" entry).
// This adapter is parameterized by the account provider being
// authenticated — forAccountProvider("OPENCODE_ZEN" | "OPENCODE_GO")
// binds that product's credential contract; anything else binds to null
// (UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION upstream).
//
// Boundaries (verified against opencode 1.18.31):
// - Credential isolation is the four XDG roots in the profile env —
//   OPENCODE_CONFIG_DIR is a config/plugin override, never the auth
//   boundary. auth.json lives at $XDG_DATA_HOME\opencode\auth.json.
// - Zen/Go authenticate with the vendor's API-key credential. `auth login
//   -p <provider>` renders the official interactive credential TUI; it
//   reads console input, so the login runs inside a real console window
//   via `cmd /d /c start /wait` (same mechanism as the Devin login) and
//   the user pastes the opencode.ai key there. Vocatrya never sees the
//   key, and `start /wait` does not propagate the exit code — the
//   `auth list` probe is the only verdict.
// - `auth list` is ANSI text only ("•  <name> <api|oauth>"); auth.json is
//   never read. Only the provider name and auth-type label are parsed.
// - `models <provider>` / `models` print provider/model ids, one per line.
// - `run --pure --format json` emits a JSONL event stream; smoke runs in a
//   Vocatrya-owned temp cwd under a deny-all permission config.
const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeDefinition } = require("./registry");
const { createOpencodeStreamParser } = require("./streaming");
const { promptStdinWriter } = require("./prompt-input");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");

const OPENCODE_BACKEND_KIND = "OPENCODE_RUNTIME";

const OPENCODE_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_OPENCODE_OK";
const OPENCODE_SMOKE_EXPECTED = "VOCATRYA_OPENCODE_OK";

// `auth list` auth-type classification. Only the vendor API-key kind of
// the bound provider can ever complete an ACCOUNT_LOGIN connection;
// foreign entries (OpenAI OAuth, Copilot, arbitrary api keys) are labeled
// for diagnostics/rejection only.
const OPENCODE_AUTH_KINDS = Object.freeze([
  "OPENCODE_ZEN_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENAI_CHATGPT_OAUTH",
  "OPENAI_API_KEY",
  "GITHUB_COPILOT_OAUTH",
  "OTHER_API_KEY",
  "UNKNOWN",
]);

// Account providers this runtime can authenticate for. Keys are
// AIConnectionProvider values; each entry carries everything the adapter
// needs so no renderer input ever picks a method, executable, or env.
const OPENCODE_ACCOUNT_PROVIDERS = Object.freeze({
  OPENCODE_ZEN: Object.freeze({
    accountProvider: "OPENCODE_ZEN",
    // `auth login -p opencode` → "OpenCode Zen" API-key prompt.
    providerId: "opencode",
    productName: "OpenCode Zen",
    // auth-list display names, normalized (lowercase, no [ _-]). The
    // models.dev name is "OpenCode Zen"; older builds printed "opencode".
    authListNames: ["opencodezen", "opencode"],
    acceptedAuthKind: "OPENCODE_ZEN_API_KEY",
    modelPrefix: "opencode/",
  }),
  OPENCODE_GO: Object.freeze({
    accountProvider: "OPENCODE_GO",
    // `auth login -p opencode-go` → "OpenCode Go" API-key prompt.
    providerId: "opencode-go",
    productName: "OpenCode Go",
    authListNames: ["opencodego"],
    acceptedAuthKind: "OPENCODE_GO_API_KEY",
    modelPrefix: "opencode-go/",
  }),
});

// Vocatrya-owned minimal config written into the managed profile before
// smoke runs. `permission: {"*": "deny"}` blocks every tool action (shell,
// file write/edit, webfetch, MCP tools); empty plugin/mcp lists plus the
// --pure flag keep project/user plugins and MCP servers out. Nothing here
// auto-approves — and `--auto` is never passed.
const OPENCODE_SMOKE_CONFIG = Object.freeze({
  $schema: "https://opencode.ai/config.json",
  permission: { "*": "deny" },
  plugin: [],
  mcp: {},
  share: "disabled",
  instructions: [],
});

function opencodeDefinition() {
  const definition = getRuntimeDefinition(OPENCODE_BACKEND_KIND);
  if (!definition) throw new Error("OPENCODE_RUNTIME is not registered");
  return definition;
}

// npm installs OpenCode through an extensionless/`*.cmd`/`*.ps1` shim —
// none spawnable with shell:false on Windows. The real binary lives inside
// the opencode-ai package (bin\opencode.exe) or its platform package
// (opencode-windows-x64[‑baseline]). This walk is bounded to the npm
// root's opencode-ai tree; it never scans the filesystem at large.
function resolveOpencodeExecutable(
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
  const packageRoot = path.join(npmRoot, "node_modules", "opencode-ai");
  const candidates = [];
  const stack = [{ dir: packageRoot, depth: 0 }];
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
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (/^opencode\.exe$/i.test(entry.name) && /[/\\]bin$/i.test(dir)) {
        candidates.push(full);
      }
    }
  }
  candidates.sort();
  const preferred =
    candidates.find((c) => /opencode-ai[/\\]bin[/\\]opencode\.exe$/i.test(c)) ||
    candidates.find((c) => /opencode-windows-x64[/\\]bin/i.test(c)) ||
    candidates[0];
  return preferred && existsSyncImpl(preferred) ? preferred : null;
}

function opencodeEnv({ profileDir, baseEnv }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: opencodeDefinition(),
    profileDir,
  });
}

function opencodeArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({
      definition: opencodeDefinition(),
      profileDir,
    }),
    ...commandArgs,
  ];
}

// ---------------------------------------------------------------------------
// auth list parsing — strict, minimal-metadata, ANSI-aware.
// ---------------------------------------------------------------------------

// clack-style ANSI decoration: CSI sequences (colors, cursor moves, line
// clears), OSC sequences, and lone escapes.
const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\[[0-9;?]*[A-Za-z]",
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\([0-9A-Z]",
    "\\x1b.",
  ].join("|"),
  "g",
);

function stripAnsi(text) {
  return typeof text === "string" ? text.replace(ANSI_PATTERN, "") : "";
}

function normalizeProviderName(name) {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

// Parses `opencode auth list` output into [{ name, type }]. The output is
//   T  Credentials <path>
//   |
//   •  OpenAI oauth
//   |
//   —  2 credentials
// Returns null when the output is not recognizable as an auth listing at
// all — callers must then treat auth state as UNKNOWN, never guess.
function parseOpencodeAuthList(text) {
  const clean = stripAnsi(text);
  const entries = [];
  let inCredentials = false;
  let sawFooter = false;
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^T\s+Credentials\b/.test(line)) {
      inCredentials = true;
      continue;
    }
    // A new section header ends the credential block (defensive — current
    // versions print a single section).
    if (/^T\s+\S/.test(line)) {
      inCredentials = false;
      continue;
    }
    if (/^\d+\s+credentials?\b/i.test(line)) {
      sawFooter = true;
      continue;
    }
    if (!inCredentials) continue;
    const entry = line.match(
      /^[•●◦·*+\-]\s+(.+?)\s*\(?\s*(api|oauth|wellknown)\s*\)?\s*$/i,
    );
    if (entry) {
      entries.push({
        name: entry[1].trim(),
        normalizedName: normalizeProviderName(entry[1].trim()),
        type: entry[2].toLowerCase(),
      });
    }
  }
  if (!inCredentials && !sawFooter && entries.length === 0) {
    return null;
  }
  return { entries };
}

// Classifies one credential entry into the auth-kind taxonomy. Only the
// bound provider's vendor API-key entry counts as the target
// classification — everything else is labeled for diagnostics/rejection.
function classifyAuthListEntry(entry) {
  const name = entry.normalizedName;
  if (name === "opencodezen" || name === "opencode") {
    return entry.type === "api" ? "OPENCODE_ZEN_API_KEY" : "UNKNOWN";
  }
  if (name === "opencodego") {
    return entry.type === "api" ? "OPENCODE_GO_API_KEY" : "UNKNOWN";
  }
  if (name === "openai") {
    return entry.type === "oauth" ? "OPENAI_CHATGPT_OAUTH" : "OPENAI_API_KEY";
  }
  if (name === "githubcopilot") {
    return entry.type === "oauth"
      ? "GITHUB_COPILOT_OAUTH"
      : "OTHER_API_KEY";
  }
  if (entry.type === "api") return "OTHER_API_KEY";
  return "UNKNOWN";
}

// Parses `auth list` for the bound account provider. Shapes verified on
// 1.18.31: entries are "•  <display name> <type>"; zero credentials print
// "—  0 credentials". Anything unrecognized is UNKNOWN — exit 0 alone never
// proves OAuth.
function parseOpencodeAuthStatus(providerConfig, { exitCode, stdout, stderr }) {
  const unknown = {
    authState: "UNKNOWN",
    authKind: "UNKNOWN",
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
  };
  const notAuthed = {
    authState: "NOT_AUTHENTICATED",
    authKind: null,
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
  };

  const parsed = parseOpencodeAuthList(`${stdout || ""}\n${stderr || ""}`);
  if (!parsed) {
    return unknown;
  }
  const target = parsed.entries.find((entry) =>
    providerConfig.authListNames.includes(entry.normalizedName),
  );
  if (!target) {
    return notAuthed;
  }
  if (target.type === "api") {
    return {
      authState: "AUTHENTICATED",
      authKind: providerConfig.acceptedAuthKind,
      authMethod: "api",
      // auth list prints no identity — accountIdentity stays null rather
      // than being inferred from credential files.
      accountIdentity: null,
      providerMetadata: {
        authType: "api",
        product: providerConfig.productName,
      },
    };
  }
  return {
    authState: "AUTHENTICATED",
    // A non-API-key credential for the bound provider is unclassifiable —
    // only the vendor API-key entry satisfies the requirement.
    authKind: classifyAuthListEntry(target),
    authMethod: target.type,
    accountIdentity: null,
    providerMetadata: { authType: target.type },
  };
}

// ---------------------------------------------------------------------------
// model discovery — `opencode models [provider]`, provider/model per line.
// ---------------------------------------------------------------------------

const MODEL_LINE = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i;

// Conservative parser: only lines that are exactly "provider/model" count.
// Everything else (headers, decoration, errors) is ignored; models from
// other provider routes (e.g. free "opencode/*") are filtered out.
function parseOpencodeModels(stdout, providerId) {
  const clean = stripAnsi(stdout);
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const match = rawLine.trim().match(MODEL_LINE);
    if (!match) continue;
    if (match[1].toLowerCase() !== providerId) continue;
    models.push({
      id: `${match[1]}/${match[2]}`,
      displayName: match[2],
    });
  }
  return models;
}

function buildModelsArgs(profileDir, providerId) {
  const commandArgs = [...opencodeDefinition().commands.models];
  if (providerId) commandArgs.push(providerId);
  return opencodeArgs({ profileDir, commandArgs });
}

// ---------------------------------------------------------------------------
// adapter factory
// ---------------------------------------------------------------------------

function createOpencodeAdapter(providerConfig) {
  const definition = () => opencodeDefinition();

  function buildLoginInvocation({ executablePath, profileDir, baseEnv }) {
    // `opencode auth login` renders a clack TUI that reads console input
    // (method selection + API-key entry) — it cannot be driven over
    // pipes. The login therefore launches inside a real console window
    // created by `start /wait`, which blocks until the vendor CLI exits.
    // The exit code is not meaningful (start does not propagate it), so
    // completion is always judged by the `auth list` probe that follows.
    // `-p` pins the account provider (opencode | opencode-go); the method
    // picker stays vendor-owned. cmd.exe is a fixed terminal launcher —
    // argv is static, the spawn boundary stays shell:false, and the
    // renderer never influences any of it. On cancel/timeout the managed
    // cmd.exe is killed; the detached console window may linger for the
    // user to close (the TUI supports Esc-cancel itself).
    return {
      executable: "cmd.exe",
      args: [
        "/d",
        "/c",
        "start",
        "",
        "/wait",
        executablePath,
        ...definition().commands.login,
        "--pure",
        "-p",
        providerConfig.providerId,
      ],
      cwd: profileDir,
      env: opencodeEnv({ profileDir, baseEnv }),
    };
  }

  function buildLogoutInvocation({ executablePath, profileDir, baseEnv }) {
    return {
      executable: executablePath,
      args: opencodeArgs({
        profileDir,
        commandArgs: [
          ...definition().commands.logout,
          providerConfig.providerId,
        ],
      }),
      cwd: profileDir,
      env: opencodeEnv({ profileDir, baseEnv }),
    };
  }

  function buildStatusInvocation({ executablePath, profileDir, baseEnv }) {
    return {
      executable: executablePath,
      args: opencodeArgs({
        profileDir,
        commandArgs: definition().authProbe.args,
      }),
      cwd: profileDir,
      env: opencodeEnv({ profileDir, baseEnv }),
    };
  }

  // `opencode models <provider>` scopes the listing to the account route;
  // when the runtime cannot scope it (e.g. provider not yet in the local
  // catalog) the full listing is filtered to the provider prefix instead.
  async function listModels({
    executablePath,
    profileDir,
    baseEnv,
    runner,
    timeoutMs,
    signal,
  }) {
    const scoped = await runner({
      executable: executablePath,
      args: buildModelsArgs(profileDir, providerConfig.providerId),
      cwd: profileDir,
      env: opencodeEnv({ profileDir, baseEnv }),
      timeoutMs,
      signal,
    });
    if (!scoped.error && !scoped.timedOut && scoped.exitCode === 0) {
      const models = parseOpencodeModels(
        scoped.stdout,
        providerConfig.providerId,
      );
      if (models.length > 0) {
        return {
          dynamicDiscoverySupported: true,
          models: models.map((m) => ({
            ...m,
            source: "RUNTIME",
            availability: "available",
          })),
        };
      }
    }
    const all = await runner({
      executable: executablePath,
      args: buildModelsArgs(profileDir, null),
      cwd: profileDir,
      env: opencodeEnv({ profileDir, baseEnv }),
      timeoutMs,
      signal,
    });
    if (all.error || all.timedOut || all.exitCode !== 0) {
      return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
    }
    const models = parseOpencodeModels(all.stdout, providerConfig.providerId);
    return {
      dynamicDiscoverySupported: true,
      models: models.map((m) => ({
        ...m,
        source: "RUNTIME",
        availability: "available",
      })),
    };
  }

  // Smoke must run on the account provider's route. A caller-supplied bare
  // id is prefixed; a foreign "other/x" id is refused rather than silently
  // rerouted; no model at all falls back to runtime discovery.
  async function resolveSmokeModel({
    executablePath,
    profileDir,
    baseEnv,
    runner,
    timeoutMs,
    signal,
    model,
  }) {
    if (typeof model === "string" && model.trim().length > 0) {
      const trimmed = model.trim();
      if (trimmed.startsWith(providerConfig.modelPrefix)) {
        return { model: trimmed };
      }
      if (!trimmed.includes("/")) {
        return { model: `${providerConfig.providerId}/${trimmed}` };
      }
      return { error: "MODEL_UNAVAILABLE" };
    }
    const catalog = await listModels({
      executablePath,
      profileDir,
      baseEnv,
      runner,
      timeoutMs,
      signal,
    });
    if (catalog.ok === false) return { error: catalog.code };
    const first = catalog.models?.[0]?.id;
    return first ? { model: first } : { error: "MODEL_DISCOVERY_UNAVAILABLE" };
  }

  // Writes the locked-down managed config into the profile before every
  // smoke run — deny-all permissions, no plugins, no MCP, no share.
  function writeManagedSmokeConfig(profileDir) {
    const configDir = path.join(profileDir, "config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(OPENCODE_SMOKE_CONFIG, null, 2)}\n`,
    );
  }

  // Locked-down one-shot `opencode run` — deny-all managed config, --pure,
  // JSONL output, Vocatrya temp cwd. The prompt is written to piped stdin
  // — `opencode run` reads non-TTY stdin as the message when no positional
  // message is given — so long business prompts never ride on the Windows
  // command line.
  function buildTextInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
    prompt,
  }) {
    writeManagedSmokeConfig(profileDir);
    const commandArgs = [
      ...definition().commands.run,
      "--pure",
      "--format",
      "json",
    ];
    if (typeof model === "string" && model.length > 0) {
      commandArgs.push("-m", model);
    }
    return {
      executable: executablePath,
      args: opencodeArgs({ profileDir, commandArgs }),
      cwd: workingDirectory,
      env: opencodeEnv({ profileDir, baseEnv }),
      stdinPipe: true,
      onStdinReady: promptStdinWriter(prompt),
    };
  }

  function buildSmokeInvocation(args) {
    return buildTextInvocation({ ...args, prompt: OPENCODE_SMOKE_PROMPT });
  }

  // `run --format json` emits JSONL events; assistant text arrives in
  // part-bearing events ({type:"text", part:{text:…}}). The last text
  // payload is the answer. Anything unparseable falls back to the last
  // non-empty line — matched stays honest either way.
  function extractSmokeText({ result }) {
    const stdout = result.stdout || "";
    const texts = [];
    let reportedError = false;
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event && (event.type === "error" || event.is_error === true)) {
        reportedError = true;
      }
      const text =
        typeof event?.part?.text === "string"
          ? event.part.text
          : typeof event?.text === "string"
            ? event.text
            : null;
      if (text && text.trim()) texts.push(text.trim());
    }
    if (texts.length > 0) {
      return { text: texts[texts.length - 1], reportedError };
    }
    const lines = `${stdout}\n${result.stderr || ""}`
      .split(/\r?\n/)
      .map((line) => stripAnsi(line).trim())
      .filter(Boolean);
    return {
      text: lines[lines.length - 1] || "",
      reportedError,
    };
  }

  return {
    backendKind: OPENCODE_BACKEND_KIND,
    accountProvider: providerConfig.accountProvider,
    loginGuardKey: "opencode:login",
    smokePrompt: OPENCODE_SMOKE_PROMPT,
    smokeExpected: OPENCODE_SMOKE_EXPECTED,
    resolveExecutable: resolveOpencodeExecutable,
    buildLoginInvocation,
    buildLogoutInvocation,
    buildStatusInvocation,
    parseAuthStatus: (result) =>
      parseOpencodeAuthStatus(providerConfig, result),
    checkLoginPolicy: null,

    // Only the bound provider's vendor API-key credential completes the
    // connection. A foreign credential kind is UNSUPPORTED_AUTH_METHOD;
    // an unclassifiable entry is AUTH_METHOD_UNVERIFIED — never silently
    // accepted.
    loginFailureCode(status) {
      if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
      if (status.authKind === providerConfig.acceptedAuthKind) return null;
      return status.authKind && status.authKind !== "UNKNOWN"
        ? "UNSUPPORTED_AUTH_METHOD"
        : "AUTH_METHOD_UNVERIFIED";
    },

    // A session that is not the bound vendor key must never flip an
    // ACCOUNT_LOGIN connection to CONNECTED — reported as UNKNOWN, which
    // maps to ERROR.
    reportableAuthState(status) {
      if (
        status.authState === "AUTHENTICATED" &&
        status.authKind !== providerConfig.acceptedAuthKind
      ) {
        return "UNKNOWN";
      }
      return status.authState;
    },

    listModels,
    resolveSmokeModel,
    buildSmokeInvocation,
    buildTextInvocation,
    // Streaming uses the identical locked-down invocation — `run --format
    // json` already emits the JSONL part-event stream; the parser diffs
    // cumulative part.text snapshots into deltas.
    buildStreamingInvocation: buildTextInvocation,
    createStreamParser: createOpencodeStreamParser,
    streamMechanism: "opencode run --format json",
    extractText: extractSmokeText,
    extractSmokeText,
  };
}

// Base adapter registered in PROVIDER_ADAPTERS. forAccountProvider binds the
// Zen/Go parameterization; any other provider binds to null so the service
// rejects the combination instead of guessing.
const opencodeAdapter = {
  backendKind: OPENCODE_BACKEND_KIND,
  loginGuardKey: "opencode:login",
  forAccountProvider(accountProvider) {
    const config = OPENCODE_ACCOUNT_PROVIDERS[accountProvider];
    return config ? createOpencodeAdapter(config) : null;
  },
};

module.exports = {
  OPENCODE_ACCOUNT_PROVIDERS,
  OPENCODE_AUTH_KINDS,
  OPENCODE_BACKEND_KIND,
  OPENCODE_SMOKE_CONFIG,
  OPENCODE_SMOKE_EXPECTED,
  OPENCODE_SMOKE_PROMPT,
  classifyAuthListEntry,
  opencodeAdapter,
  parseOpencodeAuthList,
  parseOpencodeAuthStatus,
  parseOpencodeModels,
  resolveOpencodeExecutable,
  stripAnsi,
};
