// Antigravity adapter for ANTIGRAVITY_RUNTIME (Google account login).
//
// Command surface observed on agy 1.5.12 (`agy --help`, `agy acp --help`):
// - Login is `agy acp --login` ("Log in with Google interactively, then
//   exit"). There is no headless `auth status` or `auth logout`. `/logout`
//   is a TUI slash command, not a subcommand.
// - `agy models` prints a tab-separated id/name table. On 1.5.12 it did so
//   under a fresh USERPROFILE with no Google sign-in, so that table is not
//   an account-session proof and is not used as a catalog.
// - `agy --print` accepts `--output-format`, `--json-schema`, `--sandbox`,
//   `--mode`, and `--model`. Whether `--print` reads the prompt from stdin,
//   streams, or stays inside `--sandbox` on Windows has not been trialled.
// - Redirecting USERPROFILE moved `~\.gemini` into that home. Official docs
//   also store the Google token in the OS keyring. That split is not
//   verified, so a model list or a zero exit never completes ACCOUNT_LOGIN.
//
// Verification of login, catalog, inference, streaming, and permissions is
// PENDING. This file does not mark any of those PASS.
const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeDefinition } = require("./registry");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");
const { promptStdinWriter } = require("./prompt-input");

const ANTIGRAVITY_BACKEND_KIND = "ANTIGRAVITY_RUNTIME";
const ANTIGRAVITY_ACCOUNT_PROVIDER = "ANTIGRAVITY";
const ANTIGRAVITY_ACCOUNT_KIND = "GOOGLE_ACCOUNT";

const ANTIGRAVITY_SMOKE_PROMPT = "Reply with exactly: VOCATRYA_ANTIGRAVITY_OK";
const ANTIGRAVITY_SMOKE_EXPECTED = "VOCATRYA_ANTIGRAVITY_OK";

const NOT_SIGNED_IN = /not signed in|not logged in/i;

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

function antigravityEnv({ profileDir, baseEnv }) {
  return buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition: antigravityDefinition(),
    profileDir,
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
// help text says the flow is interactive; the exit code is not a verdict.
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
      path.join(geminiDir, "antigravity-cli"),
    ],
    cwd: profileDir,
    env: antigravityEnv({ profileDir, baseEnv }),
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

function buildAntigravityStatusInvocation({
  executablePath,
  profileDir,
  baseEnv,
}) {
  ensureAntigravityHome(profileDir);
  return {
    executable: executablePath,
    args: antigravityArgs({
      profileDir,
      commandArgs: antigravityDefinition().commands.status,
    }),
    cwd: profileDir,
    env: antigravityEnv({ profileDir, baseEnv }),
  };
}

function antigravityAuthResult(authState, extra = {}) {
  return {
    authState,
    authKind: null,
    accountIdentity: null,
    providerMetadata: null,
    ...extra,
  };
}

// Only an explicit signed-out phrase is classified. A model table, a zero
// exit, or any other text stays UNKNOWN and cannot complete ACCOUNT_LOGIN.
function parseAntigravityAuthStatus({ stdout, stderr }) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  if (NOT_SIGNED_IN.test(text)) {
    return antigravityAuthResult("NOT_AUTHENTICATED");
  }
  return antigravityAuthResult("UNKNOWN");
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
    "--print",
    "--output-format",
    "text",
    "--sandbox",
    "--disable-slash-commands",
    "--mode",
    "plan",
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
    onStdinReady: promptStdinWriter(prompt),
  };
}

function parseAntigravityPrintResult({ stdout, stderr, exitCode }) {
  const lines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = lines.find((line) => line === ANTIGRAVITY_SMOKE_EXPECTED);
  return {
    text: marker ?? lines[lines.length - 1] ?? "",
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
  buildStatusInvocation: buildAntigravityStatusInvocation,
  parseAuthStatus: parseAntigravityAuthStatus,
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
  ANTIGRAVITY_BACKEND_KIND,
  ANTIGRAVITY_SMOKE_EXPECTED,
  ANTIGRAVITY_SMOKE_PROMPT,
  antigravityAdapter,
  buildAntigravityLoginInvocation,
  buildAntigravityLogoutInvocation,
  buildAntigravityPrintInvocation,
  buildAntigravityStatusInvocation,
  parseAntigravityAuthStatus,
  parseAntigravityPrintResult,
  resolveAntigravityExecutable,
};
