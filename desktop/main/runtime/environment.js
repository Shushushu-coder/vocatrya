// Phase C RuntimeProcessEnvironmentBuilder — provider-specific process
// environment isolation for managed runtime profiles.
//
// Every spawn starts from a controlled base env, removes every credential
// override env var any registered provider could be poisoned by, then
// injects the connection-specific profile vars. The caller's env object and
// process.env are never mutated.
const { collectSensitiveEnvKeys } = require("./registry");

// Non-secret variables a spawned CLI legitimately needs (loader shims,
// temp dirs, locale). Everything else is dropped — whitelisting beats
// blocklisting because credential env names evolve faster than deny lists.
const BASE_ENV_ALLOWLIST = [

  "PATH",
  "Path",
  "path",
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "LANG",
  "TERM",
  "NO_COLOR",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
];

// Network settings are connectivity, not credential material — a managed
// CLI must still honor the account's HTTP proxy and custom CA bundle.
// They are restored explicitly so credential stripping can never eat them.
const NETWORK_ENV_PASSTHROUGH = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

function expandProfileValue(template, profileDir) {
  return template.replaceAll("$PROFILE_DIR", profileDir);
}

// profileDir must already be resolved by RuntimeProfileManager — this
// builder never derives paths from the raw ref.
//
// browserLogin: only for the login invocation of runtimes whose CLI opens
// the system browser itself. The definition's browserLoginEnvPassthrough
// restores the declared host roots (e.g. APPDATA/LOCALAPPDATA for Devin)
// so the spawned browser keeps the user's real profile/session — the
// credential boundary env is never passthrough-eligible. Every other
// invocation uses the plain managed environment.
function buildRuntimeProcessEnvironment({
  baseEnv = {},
  definition,
  profileDir,
  extraEnv = {},
  browserLogin = false,
}) {
  if (!definition || !definition.profile) {
    throw new Error("A runtime definition with a profile strategy is required");
  }
  if (typeof profileDir !== "string" || profileDir.length === 0) {
    throw new Error("profileDir must be a resolved managed directory");
  }

  const env = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    if (typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  }
  for (const key of NETWORK_ENV_PASSTHROUGH) {
    if (typeof baseEnv[key] === "string" && baseEnv[key]) {
      env[key] = baseEnv[key];
    }
  }

  // Strip credential-override env for EVERY provider, not just the target —
  // a Codex spawn must not inherit the user's GITHUB_TOKEN either.
  const sensitive = collectSensitiveEnvKeys();
  for (const key of sensitive) {
    delete env[key];
  }

  // Provider profile injection. "$PROFILE_DIR" expands to the managed dir;
  // every value is an absolute managed path or a profile-scoped name.
  for (const [name, template] of Object.entries(definition.profile.env || {})) {
    env[name] = expandProfileValue(template, profileDir);
  }

  // Browser-facing login override: restore ONLY the registry-declared host
  // roots, after the managed profile injection. Credential-boundary keys
  // (profile.credentialBoundary) are never passthrough-eligible — a
  // passthrough key that collides with the credential boundary is a
  // registry bug, so it is skipped here and pinned by tests.
  if (browserLogin) {
    const credentialBoundary = new Set(
      definition.profile.credentialBoundary || [],
    );
    for (const key of definition.profile.browserLoginEnvPassthrough || []) {
      if (sensitive.has(key) || credentialBoundary.has(key)) continue;
      if (typeof baseEnv[key] === "string" && baseEnv[key]) {
        env[key] = baseEnv[key];
      }
    }
  }

  for (const [name, value] of Object.entries(extraEnv)) {
    if (sensitive.has(name)) continue;
    env[name] = value;
  }

  return env;
}

// The browser-facing variant used by login invocations whose runtime opens
// the system browser itself (today: Devin). Equivalent to
// buildRuntimeProcessEnvironment({..., browserLogin: true}).
function buildBrowserLoginProcessEnvironment({
  baseEnv = {},
  definition,
  profileDir,
  extraEnv = {},
}) {
  return buildRuntimeProcessEnvironment({
    baseEnv,
    definition,
    profileDir,
    extraEnv,
    browserLogin: true,
  });
}

// Invocation metadata for runtimes whose profile strategy needs explicit
// CLI arguments (e.g. Devin "--config <managed path>"). Returns [] when the
// definition needs none.
function buildRuntimeInvocationArgs({ definition, profileDir }) {
  const configArgs = definition?.profile?.invocation?.configArgs;
  if (!Array.isArray(configArgs)) return [];
  return configArgs.map((arg) => expandProfileValue(arg, profileDir));
}

module.exports = {
  BASE_ENV_ALLOWLIST,
  NETWORK_ENV_PASSTHROUGH,
  buildBrowserLoginProcessEnvironment,
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
  expandProfileValue,
};
