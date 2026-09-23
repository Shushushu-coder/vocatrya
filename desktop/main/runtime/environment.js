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

function expandProfileValue(template, profileDir) {
  return template.replaceAll("$PROFILE_DIR", profileDir);
}

// profileDir must already be resolved by RuntimeProfileManager — this
// builder never derives paths from the raw ref.
function buildRuntimeProcessEnvironment({
  baseEnv = {},
  definition,
  profileDir,
  extraEnv = {},
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

  // Strip credential-override env for EVERY provider, not just the target —
  // a Codex spawn must not inherit the user's GITHUB_TOKEN either.
  for (const key of collectSensitiveEnvKeys()) {
    delete env[key];
  }

  // Provider profile injection. "$PROFILE_DIR" expands to the managed dir;
  // every value is an absolute managed path or a profile-scoped name.
  for (const [name, template] of Object.entries(definition.profile.env || {})) {
    env[name] = expandProfileValue(template, profileDir);
  }

  for (const [name, value] of Object.entries(extraEnv)) {
    if (collectSensitiveEnvKeys().has(name)) continue;
    env[name] = value;
  }

  return env;
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
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
  expandProfileValue,
};
