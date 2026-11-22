// Antigravity adapter for ANTIGRAVITY_RUNTIME (Google account login).
//
// Command surface verified on agy 1.5.14 (`agy --help`, `agy acp --help`,
// live ACP handshakes, login output capture; first surveyed on 1.5.12):
// - Login is `agy acp --login`. On stdout it prints "Open this link in a
//   browser to log in with Google:" plus the accounts.google.com OAuth URL,
//   then reads the pasted authorization code (or full landing URL) from
//   stdin; an EOF stdin exits 1 with "login cancelled". There is still no
//   headless `auth status`/`auth logout`.
// - Credentials: the OAuth token lands in the Windows Credential Manager
//   keyring entry `gemini:antigravity` — per Windows user, NOT under
//   --gemini-dir. The `agy acp` backend chains it automatically at boot
//   ("ChainedAuth: authenticated via keyring") regardless of the redirected
//   USERPROFILE. The managed profile holds state only (logs, config,
//   cache/acp-auth-state.json {methodId}), so env redirection cannot
//   isolate the token — multiAccountIsolation stays false.
// - `--gemini-dir` accepts an absolute path, but `--app-data-dir` must be
//   a RELATIVE directory name (default "antigravity-cli", resolved under
//   --gemini-dir). An absolute value crashes the lazily-started language
//   server ("must not be absolute"), which takes down every ACP request
//   that boots it — including authenticate.
// - Auth probe: `agy acp` is an ACP stdio server. initialize advertises
//   fixed authMethods (oauth-personal "Log in with Google", oauth-business,
//   gemini-api-key, agent-platform). authenticate(oauth-personal) returns
//   {_meta.antigravity.tier} within seconds when a personal Google
//   credential already exists in the keyring; with none it launches an
//   interactive OAuth loopback browser and blocks — the probe bounds it
//   and fails closed.
// - `agy models` prints the model table regardless of sign-in state. It is
//   never an auth signal.
// - `agy --print` is a VALUE flag on 1.5.14 (`--print "prompt"`, aliases
//   -p/--prompt): a bare `--print` errors "flag needs an argument" and
//   swallows the next flag as its value. The stdin-driven form is
//   `--print=` + `--input-format stream-json`/`--output-format
//   stream-json`: stdin takes one NDJSON {"event":"user","message":
//   {role,content}} line per turn; stdout emits init/step_update/result
//   events and the terminal result carries result.response. Verified
//   live on 1.5.14.
// - `--mode plan` is a no-op while `--disable-slash-commands` is set
//   ("--mode plan has no effect while slash command expansion is
//   disabled") — it is dropped from the exec args; --sandbox + the
//   default request-review permission mode remain the gate.
//
// Verification of streaming and adversarial permissions is PENDING. The
// login-verify ACP probe and the --print exec surface are verified on
// 1.5.14.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { terminateChildTree } = require("../runtime");
const { promptStdinWriter } = require("./prompt-input");

const CLIENT_INFO_VERSION = require("../../../package.json").version;

const ANTIGRAVITY_BACKEND_KIND = "ANTIGRAVITY_RUNTIME";
const ANTIGRAVITY_ACCOUNT_PROVIDER = "ANTIGRAVITY";
const ANTIGRAVITY_ACCOUNT_KIND = "GOOGLE_ACCOUNT";

const ANTIGRAVITY_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_ANTIGRAVITY_OK";
const ANTIGRAVITY_SMOKE_EXPECTED = "VOCATRYA_ANTIGRAVITY_OK";

// The ACP auth method `agy acp --login` provisions — a personal Google
// OAuth session. Verified on 1.5.14: its id is stable in the initialize
// authMethods list and authenticate() resolves it against the keyring.
const ANTIGRAVITY_ACP_METHOD = "oauth-personal";

function antigravityDefinition() {
  const definition = getRuntimeDefinition(ANTIGRAVITY_BACKEND_KIND);
  if (!definition) throw new Error("ANTIGRAVITY_RUNTIME is not registered");
  return definition;
}

function resolveAntigravityExecutable(
  executablePath,
  { existsSyncImpl = fs.existsSync } = {},
) {
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    return null;
  }
  if (/\.exe$/i.test(executablePath)) {
    return existsSyncImpl(executablePath) ? executablePath : null;
  }
  const sibling = path.join(path.dirname(executablePath), "agy.exe");
  return existsSyncImpl(sibling) ? sibling : null;
}

function ensureAntigravityHome(profileDir, { mkdirSyncImpl = fs.mkdirSync } = {}) {
  mkdirSyncImpl(path.join(profileDir, "home"), { recursive: true });
}

// browserLogin — only for `acp --login`: if the CLI hands the OAuth URL
// to the system browser, the spawned browser resolves its user-data dir
// from %LOCALAPPDATA%/%APPDATA%; redirected roots would launch a fresh
// unsigned profile. The registry-declared passthrough restores those host
// roots for the login process; the credential boundary (USERPROFILE/HOME)
// stays managed and the OAuth token lands in the OS keyring regardless.
function antigravityEnv({ profileDir, baseEnv, browserLogin = false }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: antigravityDefinition(),
    profileDir,
    browserLogin,
  });
}

function antigravityArgs({ profileDir, commandArgs }) {
  return [
    ...buildRuntimeInvocationArgs({
      definition: antigravityDefinition(),
      profileDir,
    }),
    ...commandArgs,
  ];
}

// Interactive Google login. `start /wait` owns a real console because the
// flow prints the OAuth URL on stdout and reads the pasted authorization
// code from stdin (verified on 1.5.14). `--app-data-dir` must stay the
// relative directory name — an absolute path crashes the language server.
function buildAntigravityLoginInvocation({
  executablePath,
  profileDir,
  baseEnv,
}) {
  ensureAntigravityHome(profileDir);
  const geminiDir = path.join(profileDir, "home", ".gemini");
  return {
    executable: "cmd.exe",
    args: [
      "/d",
      "/c",
      "start",
      "",
      "/wait",
      executablePath,
      ...antigravityDefinition().commands.login,
      "--gemini-dir",
      geminiDir,
      "--app-data-dir",
      "antigravity-cli",
    ],
    cwd: profileDir,
    env: antigravityEnv({ profileDir, baseEnv, browserLogin: true }),
  };
}

// 1.5.12 has no headless logout. `--version` exits without opening a
// session and does not clear the OS keyring. Disconnect still drops the
// Vocatrya connection row; the keyring session is untouched.
function buildAntigravityLogoutInvocation({
  executablePath,
  profileDir,
  baseEnv,
}) {
  ensureAntigravityHome(profileDir);
  return {
    executable: executablePath,
    args: antigravityArgs({
      profileDir,
      commandArgs: antigravityDefinition().commands.logout,
    }),
    cwd: profileDir,
    env: antigravityEnv({ profileDir, baseEnv }),
  };
}

function antigravityAuthResult(authState, extra = {}) {
  return {
    authState,
    authKind: null,
    authMethod: null,
    accountIdentity: null,
    providerMetadata: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// ACP auth probe — `agy acp` initialize + authenticate(oauth-personal).
// Verified on agy 1.5.14: a cached personal Google credential (keyring
// `gemini:antigravity`) resolves authenticate() within seconds and returns
// {_meta.antigravity.tier}; without one the request launches an interactive
// OAuth loopback browser and blocks, so the probe bounds it and fails
// closed. No session/new, no session/prompt — never a model call.
// ---------------------------------------------------------------------------

const ACP_MAX_BUFFER_BYTES = 256 * 1024;

// Classify an authenticate() JSON-RPC error. Expired/revoked sessions map
// to REAUTH_REQUIRED so a reconnect can repair them; other auth failures
// mean no usable personal-Google credential.
function classifyAntigravityAuthError(error) {
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// runAntigravityAcpAuthProbe({executablePath, profileDir, baseEnv, timeoutMs,
//   signal, spawnImpl, terminateImpl})
//   → { authState, authKind, authMethod, accountIdentity, providerMetadata }
//
// A successful authenticate() is method-pinned evidence: only a personal
// Google OAuth session satisfies oauth-personal, so AUTHENTICATED here is
// always GOOGLE_ACCOUNT — never an API-key or enterprise method. A pending
// authenticate at the probe bound means the interactive loopback took over
// (no cached credential to confirm) → NOT_AUTHENTICATED; fail-closed, a
// slow language-server boot degrades to the same actionable state.
function runAntigravityAcpAuthProbe({
  executablePath,
  profileDir,
  baseEnv,
  timeoutMs = 15_000,
  signal,
  spawnImpl = spawn,
  terminateImpl = terminateChildTree,
} = {}) {
  try {
    ensureAntigravityHome(profileDir);
  } catch {
    return Promise.resolve(antigravityAuthResult("UNKNOWN"));
  }
  const geminiDir = path.join(profileDir, "home", ".gemini");
  const args = antigravityArgs({
    profileDir,
    commandArgs: [
      ...antigravityDefinition().authProbe.args,
      "--gemini-dir",
      geminiDir,
      "--app-data-dir",
      "antigravity-cli",
    ],
  });
  const env = antigravityEnv({ profileDir, baseEnv });
  const executable =
    resolveAntigravityExecutable(executablePath) || executablePath;

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
      // Resolve only after the child is actually down — an interactive
      // loopback browser is a descendant of this process tree.
      void Promise.resolve(terminateImpl(child)).then(() =>
        resolve(outcome),
      );
    };

    const onAbort = () => finish(antigravityAuthResult("UNKNOWN"));

    const timer = setTimeout(() => {
      // authenticate() only holds the request when it has launched the
      // interactive OAuth flow — there is no cached personal Google
      // credential to confirm.
      finish(
        antigravityAuthResult(
          authenticateSent ? "NOT_AUTHENTICATED" : "UNKNOWN",
        ),
      );
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(antigravityAuthResult("UNKNOWN"));
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
      finish(antigravityAuthResult("UNKNOWN"));
      return;
    }

    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        finish(antigravityAuthResult("UNKNOWN"));
      }
    };

    const handleMessage = (msg) => {
      if (settled || !isPlainObject(msg)) return;
      // Only responses to requests we sent count — agent→client requests
      // and notifications never answer authenticate.
      if (typeof msg.method === "string") return;
      const isResponse = "result" in msg || "error" in msg;
      if (!isResponse) return;

      if (msg.id === 1 && !authenticateSent) {
        if (msg.error || !isPlainObject(msg.result)) {
          finish(antigravityAuthResult("UNKNOWN"));
          return;
        }
        authenticateSent = true;
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "authenticate",
          params: { methodId: ANTIGRAVITY_ACP_METHOD },
        });
        return;
      }
      if (msg.id === 2 && authenticateSent) {
        if (msg.error) {
          finish(
            antigravityAuthResult(classifyAntigravityAuthError(msg.error)),
          );
          return;
        }
        if (!isPlainObject(msg.result)) {
          finish(antigravityAuthResult("UNKNOWN"));
          return;
        }
        const agy = isPlainObject(msg.result._meta?.antigravity)
          ? msg.result._meta.antigravity
          : {};
        const tier = isPlainObject(agy.tier) ? agy.tier : {};
        const providerMetadata = { authMethodId: ANTIGRAVITY_ACP_METHOD };
        if (typeof tier.name === "string" && tier.name) {
          providerMetadata.tierName = tier.name;
        }
        if (typeof tier.id === "string" && tier.id) {
          providerMetadata.tierId = tier.id;
        }
        finish(
          antigravityAuthResult("AUTHENTICATED", {
            authKind: ANTIGRAVITY_ACCOUNT_KIND,
            authMethod: "oauth",
            providerMetadata,
          }),
        );
      }
    };

    if (!child.stdout || !child.stdin) {
      finish(antigravityAuthResult("UNKNOWN"));
      return;
    }

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > ACP_MAX_BUFFER_BYTES) {
        finish(antigravityAuthResult("UNKNOWN"));
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
          // A non-JSON line on the ACP stream means we are not speaking
          // the protocol — fail closed rather than parse leniently.
          finish(antigravityAuthResult("UNKNOWN"));
          return;
        }
        handleMessage(msg);
        if (settled) return;
      }
    });
    // stderr is drained but never parsed — it carries agy's own log lines.
    child.stderr?.on("data", () => {});
    child.once("error", () => finish(antigravityAuthResult("UNKNOWN")));
    child.once("close", () =>
      finish(
        antigravityAuthResult(
          authenticateSent ? "NOT_AUTHENTICATED" : "UNKNOWN",
        ),
      ),
    );

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
        clientInfo: {
          name: "vocatrya-auth-probe",
          version: CLIENT_INFO_VERSION,
        },
      },
    });
  });
}

// The prompt must not ride argv. `--print=` (empty attached value) +
// stream-json input moves it onto stdin as an NDJSON user event — the
// only stdin prompt channel 1.5.14 exposes.
function antigravityStreamUserMessage(prompt) {
  return `${JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  })}\n`;
}

function buildAntigravityPrintInvocation({
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  prompt,
}) {
  ensureAntigravityHome(profileDir);
  const commandArgs = [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--sandbox",
    "--disable-slash-commands",
  ];
  if (typeof model === "string" && model.length > 0) {
    commandArgs.push("--model", model);
  }
  return {
    executable: executablePath,
    args: antigravityArgs({ profileDir, commandArgs }),
    cwd: workingDirectory,
    env: antigravityEnv({ profileDir, baseEnv }),
    stdinPipe: true,
    onStdinReady: promptStdinWriter(antigravityStreamUserMessage(prompt)),
  };
}

// stdout is an NDJSON event stream. The terminal `{"event":"result"}`
// event carries `result.response`; intermediate step_update text_delta
// events are ignored for extraction. Anything unparsable degrades to the
// last non-empty line so a hard CLI error is still surfaced.
function parseAntigravityPrintResult({ stdout, stderr, exitCode }) {
  const lines = `${stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let response;
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      msg?.event === "result" &&
      typeof msg?.result?.response === "string"
    ) {
      response = msg.result.response;
      if (msg.result.status && msg.result.status !== "SUCCESS") {
        return {
          text: response,
          reportedError: true,
        };
      }
    }
  }
  if (response !== undefined) {
    return {
      text: response,
      reportedError:
        exitCode !== 0 && exitCode !== undefined && exitCode !== null,
    };
  }
  const fallbackLines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    text: fallbackLines[fallbackLines.length - 1] ?? "",
    reportedError: exitCode !== 0 && exitCode !== undefined && exitCode !== null,
  };
}

const antigravityAdapter = {
  backendKind: ANTIGRAVITY_BACKEND_KIND,
  accountProvider: ANTIGRAVITY_ACCOUNT_PROVIDER,
  forAccountProvider(provider) {
    return provider == null || provider === ANTIGRAVITY_ACCOUNT_PROVIDER
      ? antigravityAdapter
      : null;
  },
  loginGuardKey: "antigravity:login",
  smokePrompt: ANTIGRAVITY_SMOKE_PROMPT,
  smokeExpected: ANTIGRAVITY_SMOKE_EXPECTED,
  resolveExecutable: resolveAntigravityExecutable,
  buildLoginInvocation: buildAntigravityLoginInvocation,
  buildLogoutInvocation: buildAntigravityLogoutInvocation,
  // `agy models` prints its table signed-out too — auth state is only
  // observable through the ACP handshake, never a one-shot status command.
  probeAuth: runAntigravityAcpAuthProbe,
  prepareSession: null,
  checkLoginPolicy: null,

  loginFailureCode(status) {
    if (status.authState !== "AUTHENTICATED") return "AUTH_NOT_CONFIRMED";
    if (status.authKind === ANTIGRAVITY_ACCOUNT_KIND) return null;
    return status.authKind && status.authKind !== "UNKNOWN"
      ? "UNSUPPORTED_AUTH_METHOD"
      : "AUTH_METHOD_UNVERIFIED";
  },

  reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authKind !== ANTIGRAVITY_ACCOUNT_KIND
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  },

  // The bundled `agy models` table is not an account catalog.
  async listModels() {
    return { ok: false, code: "MODEL_DISCOVERY_UNAVAILABLE" };
  },

  buildSmokeInvocation(args) {
    return buildAntigravityPrintInvocation({
      ...args,
      prompt: ANTIGRAVITY_SMOKE_PROMPT,
    });
  },

  buildTextInvocation(args) {
    return buildAntigravityPrintInvocation(args);
  },

  extractText({ result }) {
    return parseAntigravityPrintResult(result);
  },

  extractSmokeText({ result }) {
    return parseAntigravityPrintResult(result);
  },
};

module.exports = {
  ANTIGRAVITY_ACCOUNT_KIND,
  ANTIGRAVITY_ACCOUNT_PROVIDER,
  ANTIGRAVITY_ACP_METHOD,
  ANTIGRAVITY_BACKEND_KIND,
  ANTIGRAVITY_SMOKE_EXPECTED,
  ANTIGRAVITY_SMOKE_PROMPT,
  antigravityAdapter,
  buildAntigravityLoginInvocation,
  buildAntigravityLogoutInvocation,
  buildAntigravityPrintInvocation,
  classifyAntigravityAuthError,
  parseAntigravityPrintResult,
  resolveAntigravityExecutable,
  runAntigravityAcpAuthProbe,
};
