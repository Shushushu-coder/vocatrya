// Phase D Codex-specific helpers for the CODEX_RUNTIME backend.
//
// Everything here is Codex-aware but stays inside the Phase C boundaries:
// invocations are {executable, args[], cwd, env} objects for
// RuntimeCommandRunner (shell is always false), the process env comes only
// from buildRuntimeProcessEnvironment (managed CODEX_HOME + stripped
// credential overrides), and credential files are never read — auth state
// is parsed solely from `codex login status` output.
const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeDefinition } = require("./registry");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { applyCodexProxyEnv } = require("./codex-proxy-env");
const { classifyAuthProbeOutput } = require("./auth-probe");
const { createCodexStreamParser } = require("./streaming");
const { promptStdinWriter } = require("./prompt-input");

const CODEX_BACKEND_KIND = "CODEX_RUNTIME";

const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\[[0-9;?]*[A-Za-z]",
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\([0-9A-Z]",
    "\\x1b.",
  ].join("|"),
  "g",
);

// `codex login` starts the local callback server, tries to open the system
// browser itself, and unconditionally prints the authorize URL on stderr
// within the first second ("If your browser did not open, navigate to this
// URL to authenticate:" — verified on codex-cli 0.165.0 and 0.171.0). The
// CLI's own browser-open attempt is best-effort and can silently fail in
// packaged spawn contexts, so the URL is the recovery entry the renderer
// surfaces. Only the official OpenAI authorize endpoint may surface — the
// local callback URL (localhost:1455) printed in the same block and any
// foreign origin must never reach the UI.
const CODEX_LOGIN_URL_RE =
  /https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'<>)\]]+/i;

function extractCodexLoginUrl(text) {
  if (typeof text !== "string") return null;
  const match = text.replace(ANSI_PATTERN, "").match(CODEX_LOGIN_URL_RE);
  if (!match) return null;
  // A chunk can end inside the query string. Wait for the CLI's trailing
  // delimiter before the service latches this one-shot recovery URL.
  const clean = text.replace(ANSI_PATTERN, "");
  return match.index + match[0].length < clean.length ? match[0] : null;
}

// Smoke contract (spec §23): the prompt asks the model to echo a fixed
// marker; the run needs no file access, so it uses the strongest sandbox
// the CLI supports (read-only) in a Vocatrya-owned temporary directory.
const CODEX_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_CODEX_OK";
const CODEX_SMOKE_EXPECTED = "VOCATRYA_CODEX_OK";

// Static fallback catalog derived from the bundled model catalog shipped
// with codex-cli 0.154.0 (`codex debug models --bundled`, entries with
// visibility "list"). Used only when the runtime cannot produce a catalog.
const CODEX_CURATED_MODELS = Object.freeze([
  { id: "gpt-6-astra", displayName: "GPT-6-Astra" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.2", displayName: "GPT-5.2" },
]);

function codexDefinition() {
  const definition = getRuntimeDefinition(CODEX_BACKEND_KIND);
  if (!definition) throw new Error("CODEX_RUNTIME is not registered");
  return definition;
}

// npm installs Codex through an extensionless/`*.cmd` shim — neither is
// spawnable with shell:false on Windows. The real binary is the vendored
// codex.exe inside @openai/codex-win32-*. This walk is bounded to the npm
// root's @openai scope; it never scans the filesystem at large.
function resolveCodexExecutable(
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
  const openaiRoot = path.join(npmRoot, "node_modules", "@openai");
  const candidates = [];
  const stack = [{ dir: openaiRoot, depth: 0 }];
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
      // Dot-prefixed directories are npm staging areas (e.g. ".codex-ab12").
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (
        /^codex\.exe$/i.test(entry.name) &&
        /codex-win32/i.test(dir)
      ) {
        candidates.push(full);
      }
    }
  }
  candidates.sort();
  const preferred =
    candidates.find((candidate) => /codex-win32-x64/i.test(candidate)) ||
    candidates[0];
  return preferred && existsSyncImpl(preferred) ? preferred : null;
}

function codexEnv({ profileDir, baseEnv, proxyEnvOptions }) {
  const source = baseEnv || process.env;
  return applyCodexProxyEnv(
    buildRuntimeProcessEnvironment({
      baseEnv: source,
      definition: codexDefinition(),
      profileDir,
    }),
    source,
    proxyEnvOptions,
  );
}

function codexArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({ definition: codexDefinition(), profileDir }),
    ...commandArgs,
  ];
}

// Interactive ChatGPT login: `codex login` starts the local callback server
// and opens the system browser. Long-running by design — the caller bounds
// it with timeoutMs and cancels through the AbortSignal.
function buildCodexLoginInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = codexDefinition();
  return {
    executable: executablePath,
    args: codexArgs({ profileDir, commandArgs: definition.commands.login }),
    cwd: profileDir,
    env: codexEnv({ profileDir, baseEnv }),
  };
}

function buildCodexLogoutInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = codexDefinition();
  return {
    executable: executablePath,
    args: codexArgs({ profileDir, commandArgs: definition.commands.logout }),
    cwd: profileDir,
    env: codexEnv({ profileDir, baseEnv }),
  };
}

function buildCodexStatusInvocation({ executablePath, profileDir, baseEnv }) {
  const definition = codexDefinition();
  return {
    executable: executablePath,
    args: codexArgs({ profileDir, commandArgs: definition.authProbe.args }),
    cwd: profileDir,
    env: codexEnv({ profileDir, baseEnv }),
  };
}

function buildCodexModelsInvocation({
  executablePath,
  profileDir,
  baseEnv,
  bundled = false,
}) {
  const definition = codexDefinition();
  return {
    executable: executablePath,
    args: codexArgs({
      profileDir,
      commandArgs: bundled
        ? definition.commands.modelsBundled
        : definition.commands.models,
    }),
    cwd: profileDir,
    env: codexEnv({ profileDir, baseEnv }),
  };
}

// Minimal non-interactive inference: `codex exec` with read-only sandbox in
// a Vocatrya-owned working directory, no session persistence, no git
// requirement. The last agent message is written to outputFile inside that
// directory so callers never scrape the human-readable log.
// The prompt travels through piped stdin (`codex exec -`, verified in
// `codex exec --help` on codex-cli 0.165.0 — "omit PROMPT or use `-` to
// read instructions from stdin") so long business prompts never ride on
// the Windows command line.
function buildCodexExecInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  outputFile,
  outputSchemaFile,
  model,
  prompt,
}) {
  const definition = codexDefinition();
  const args = [
    ...buildRuntimeInvocationArgs({ definition, profileDir }),
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    "read-only",
    "-C",
    workingDirectory,
    "-o",
    outputFile,
  ];
  // `codex exec --output-schema <file>` (codex-cli 0.154.0) constrains the
  // model's final response shape; the conforming JSON lands in -o
  // outputFile like any other exec result.
  if (typeof outputSchemaFile === "string" && outputSchemaFile.length > 0) {
    args.push("--output-schema", outputSchemaFile);
  }
  if (typeof model === "string" && model.length > 0) {
    args.push("-m", model);
  }
  args.push("-");
  return {
    executable: executablePath,
    args,
    cwd: workingDirectory,
    env: codexEnv({ profileDir, baseEnv }),
    stdinPipe: true,
    onStdinReady: promptStdinWriter(prompt),
  };
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Parses `codex login status` output. Verified shapes (codex-cli 0.154.0):
//   "Not logged in"                    (exit 1)
//   "Logged in using ChatGPT"          (exit 0) — ACCOUNT_LOGIN target
//   "Logged in using an API key - …"   (exit 0) — not account login
//   "Error checking login status: …"
// authMethod distinguishes a real ChatGPT session from a credential override
// that slipped through; identity is extracted only when the CLI prints a
// plain email — auth.json is never opened.
function parseCodexLoginStatus({ exitCode, stdout, stderr }) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  if (/error checking login status/i.test(text)) {
    return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
  }
  if (/not logged in/i.test(text) || exitCode === 1) {
    return {
      authState: "NOT_AUTHENTICATED",
      authMethod: null,
      accountIdentity: null,
    };
  }
  if (/logged in using chatgpt/i.test(text)) {
    const email = text.match(EMAIL_PATTERN);
    return {
      authState: "AUTHENTICATED",
      authMethod: "chatgpt",
      accountIdentity: email ? email[0] : null,
    };
  }
  if (
    /logged in using (an api key|access token|personal access token|workload identity|amazon bedrock)/i.test(
      text,
    )
  ) {
    const method = /api key/i.test(text) ? "api_key" : "other";
    const email = text.match(EMAIL_PATTERN);
    return {
      authState: "AUTHENTICATED",
      authMethod: method,
      accountIdentity: email ? email[0] : null,
    };
  }
  return {
    authState: classifyAuthProbeOutput({ exitCode, stdout, stderr }),
    authMethod: null,
    accountIdentity: null,
  };
}

// `codex debug models` → {"models":[{slug,display_name,visibility,...}]}.
// Only "list" visibility entries are user-selectable. Returns null when the
// output is not the documented JSON shape — callers then fall back.
function parseCodexModelCatalog(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.models)) return null;
  const models = [];
  for (const model of parsed.models) {
    if (!model || typeof model.slug !== "string") continue;
    if (model.visibility !== "list") continue;
    models.push({
      id: model.slug,
      displayName:
        typeof model.display_name === "string" && model.display_name.length > 0
          ? model.display_name
          : model.slug,
    });
  }
  return models.length > 0 ? models : null;
}

// Provider adapter contract consumed by connection-service.js (Phase E:
// the service is provider-neutral; every Codex-specific decision lives in
// this object — invocation shapes, auth classification, model discovery,
// and smoke result extraction).
const codexAdapter = {
  backendKind: CODEX_BACKEND_KIND,
  // Codex only ever authenticates an OpenAI account — the binding is the
  // identity unless a different provider is requested.
  accountProvider: "OPENAI",
  forAccountProvider(provider) {
    return provider == null || provider === "OPENAI" ? codexAdapter : null;
  },
  loginGuardKey: "codex:login",
  smokePrompt: CODEX_SMOKE_PROMPT,
  smokeExpected: CODEX_SMOKE_EXPECTED,
  resolveExecutable: resolveCodexExecutable,
  buildLoginInvocation: buildCodexLoginInvocation,
  buildLogoutInvocation: buildCodexLogoutInvocation,
  buildStatusInvocation: buildCodexStatusInvocation,
  parseAuthStatus: parseCodexLoginStatus,
  extractLoginUrl: extractCodexLoginUrl,
  checkLoginPolicy: null,

  // Post-login verification: only a ChatGPT account session counts.
  // Unified taxonomy — a recognized credential override (API key, PAT,
  // workload identity) is UNSUPPORTED_AUTH_METHOD like every other
  // runtime; an authenticated-but-unclassified session is
  // AUTH_METHOD_UNVERIFIED; never a silent success.
  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    if (status.authMethod === "chatgpt") return null;
    return status.authMethod
      ? "UNSUPPORTED_AUTH_METHOD"
      : "AUTH_METHOD_UNVERIFIED";
  },

  // A verified non-ChatGPT session is reported as UNKNOWN so it can never
  // flip an ACCOUNT_LOGIN connection to CONNECTED — including an
  // authenticated-but-unclassified shape (authMethod null).
  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authMethod !== "chatgpt"
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  // Official machine-readable catalog: `codex debug models` (account-aware
  // refresh), then the binary's bundled catalog, then the curated fallback.
  async listModels({ executablePath, profileDir, baseEnv, runner, timeoutMs, signal }) {
    for (const bundled of [false, true]) {
      const invocation = buildCodexModelsInvocation({
        executablePath,
        profileDir,
        baseEnv,
        bundled,
      });
      const result = await runner({
        ...invocation,
        timeoutMs,
        signal,
        // `codex debug models` JSON is several hundred KB. The runner's
        // default 256KB cap truncates it, JSON.parse fails, and the UI
        // falls back to the old curated list.
        maxCaptureBytes: 8 * 1024 * 1024,
      });
      if (result.error || result.timedOut || result.exitCode !== 0) continue;
      const models = parseCodexModelCatalog(result.stdout);
      if (models) {
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
    return {
      dynamicDiscoverySupported: false,
      models: CODEX_CURATED_MODELS.map((m) => ({
        ...m,
        source: "CURATED",
        availability: "unknown",
      })),
    };
  },

  buildSmokeInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
  }) {
    return buildCodexExecInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      outputFile: path.join(workingDirectory, "last-message.txt"),
      model,
      prompt: CODEX_SMOKE_PROMPT,
    });
  },

  // TEXT_ONLY business execution — identical invocation shape to smoke
  // (read-only sandbox, ephemeral, Vocatrya-owned cwd), only the prompt
  // differs. The prompt is written to piped stdin, never an argv element.
  buildTextInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
    prompt,
  }) {
    return buildCodexExecInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      outputFile: path.join(workingDirectory, "last-message.txt"),
      model,
      prompt,
    });
  },

  // Streaming TEXT_ONLY — `codex app-server --listen stdio://`, a managed
  // JSON-RPC child. `exec --json` was probed on 0.154.0 and is NOT a real
  // stream (the answer arrives in a single terminal item.completed
  // snapshot after tens of silent seconds); the app-server emits genuine
  // item/agentMessage/delta notifications ahead of turn/completed. The
  // parser drives the initialize → thread/start → turn/start handshake
  // over the piped stdin and ends stdin when the turn terminates — the
  // server exits cleanly on stdin EOF. The thread pins the same
  // locked-down boundary as `exec`: read-only sandbox, approval never,
  // ephemeral thread, Vocatrya-owned cwd, the assigned model with
  // provider fallback disabled.
  buildStreamingInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
  }) {
    return {
      executable: executablePath,
      args: codexArgs({
        profileDir,
        commandArgs: ["app-server", "--listen", "stdio://"],
      }),
      cwd: workingDirectory,
      env: codexEnv({ profileDir, baseEnv }),
      stdinPipe: true,
    };
  },
  // The app-server driver is stateful — it needs the turn payload to
  // issue turn/start once the handshake opens the thread.
  createStreamParser: ({ prompt, model, workingDirectory } = {}) =>
    createCodexStreamParser({ prompt, model, workingDirectory }),
  streamMechanism: "codex app-server",

  // NATIVE_JSON_SCHEMA: the schema object is serialized into a
  // Vocatrya-owned file inside the fresh exec workDir — caller-supplied
  // filesystem paths are never accepted — and carried via
  // `--output-schema`. Everything else is the same locked-down exec.
  buildStructuredInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
    prompt,
    schema,
    schemaName,
  }) {
    const safeName = `${String(schemaName || "output").replace(/[^A-Za-z0-9._-]/g, "_")}.schema.json`;
    const schemaPath = path.join(workingDirectory, safeName);
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema)}\n`, "utf8");
    return buildCodexExecInvocation({
      executablePath,
      profileDir,
      baseEnv,
      workingDirectory,
      outputFile: path.join(workingDirectory, "last-message.txt"),
      outputSchemaFile: schemaPath,
      model,
      prompt,
    });
  },

  extractText({ result, workDir }) {
    return extractCodexExecText({ result, workDir });
  },

  // Streaming runs carry their canonical answer on the wire
  // (item/completed agentMessage text, reconciled per-item against its
  // deltas). There is no -o file and stdout is framed JSON-RPC — generic
  // scraping could only produce a framed line, so the extractor refuses
  // to guess; canonical stays null and the delta channel wins.
  extractStreamText() {
    return { text: "", reportedError: false };
  },

  // The last agent message is written to last-message.txt inside the work
  // dir; the last non-empty stdout line is the non-json fallback.
  extractSmokeText({ result, workDir }) {
    return extractCodexExecText({ result, workDir });
  },
};

// Shared extractor for smoke and TEXT_ONLY exec results.
function extractCodexExecText({ result, workDir }) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(workDir, "last-message.txt"), "utf8");
  } catch {
    text = "";
  }
  if (!text.trim()) {
    const lines = (result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    text = lines[lines.length - 1] || "";
  }
  return { text: text.trim(), reportedError: false };
}

module.exports = {
  CODEX_BACKEND_KIND,
  CODEX_CURATED_MODELS,
  CODEX_SMOKE_EXPECTED,
  CODEX_SMOKE_PROMPT,
  buildCodexExecInvocation,
  buildCodexLoginInvocation,
  buildCodexLogoutInvocation,
  buildCodexModelsInvocation,
  buildCodexStatusInvocation,
  codexAdapter,
  extractCodexLoginUrl,
  parseCodexLoginStatus,
  parseCodexModelCatalog,
  resolveCodexExecutable,
};
