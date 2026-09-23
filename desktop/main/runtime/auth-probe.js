// Phase C RuntimeAuthStatusProbe — read-only auth state contract.
//
// Probes never log in, never log out, never touch credential files, and
// never mint tokens. They run the vendor's documented status subcommand
// inside the managed profile env and classify the output. Any probe whose
// network/billing behaviour is not yet confirmed is kept as metadata-only
// (mode: "READ_ONLY" definitions still execute via the runner — they are
// read-only commands — but provisional ones are flagged in the result so
// callers can choose not to rely on them).
const { getRuntimeDefinition } = require("./registry");
const { runRuntimeCommand } = require("./runner");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");

const AUTH_PROBE_TIMEOUT_MS = 15_000;

// Generic keyword classifier shared by providers. Conservative ordering:
// re-auth signals beat unauthenticated signals beat authenticated signals.
function classifyAuthProbeOutput({ exitCode, stdout, stderr }) {
  const text = `${stdout || ""}\n${stderr || ""}`.toLowerCase();
  if (/reauth|expired|refresh|revoked|invalid_grant/.test(text)) {
    return "REAUTH_REQUIRED";
  }
  if (
    /not\s+(logged|authenticated|signed)|unauthorized|unauthenticated|login required|no credentials|not logged in|"loggedin"\s*:\s*false/.test(
      text,
    )
  ) {
    return "NOT_AUTHENTICATED";
  }
  if (
    /authenticated|logged in|signed in|active account|credentials?:\s*(ok|valid)/.test(
      text,
    )
  ) {
    return "AUTHENTICATED";
  }
  if (
    exitCode === 0 &&
    (/"authenticated"\s*:\s*true/.test(text) || /"loggedin"\s*:\s*true/.test(text))
  ) {
    return "AUTHENTICATED";
  }
  return "UNKNOWN";
}

// probeRuntimeAuthState({ backendKind, executablePath, profileDir, baseEnv, runner })
//   → { backendKind, authState, raw: {exitCode, timedOut} }
// profileDir is required: an auth probe outside the managed profile would
// read the HOST account state and report the wrong user.
async function probeRuntimeAuthState({
  backendKind,
  executablePath,
  profileDir,
  baseEnv,
  runner = runRuntimeCommand,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
} = {}) {
  const definition = getRuntimeDefinition(backendKind);
  if (!definition) {
    throw new Error(`Unknown runtime backendKind: ${backendKind}`);
  }
  const probe = definition.authProbe;
  if (!probe || !Array.isArray(probe.args)) {
    return { backendKind, authState: "UNKNOWN", reason: "NO_PROBE_DEFINED" };
  }
  if (!executablePath) {
    return { backendKind, authState: "UNKNOWN", reason: "NOT_INSTALLED" };
  }
  if (!profileDir) {
    return { backendKind, authState: "UNKNOWN", reason: "PROFILE_REQUIRED" };
  }

  const env = buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition,
    profileDir,
  });
  const args = [
    ...buildRuntimeInvocationArgs({ definition, profileDir }),
    ...probe.args,
  ];
  const result = await runner({
    executable: executablePath,
    args,
    env,
    timeoutMs,
    sanitize: true,
  });
  if (result.error) {
    return { backendKind, authState: "UNKNOWN", reason: "SPAWN_FAILED" };
  }
  if (result.timedOut) {
    return { backendKind, authState: "UNKNOWN", reason: "TIMEOUT" };
  }
  return {
    backendKind,
    authState: classifyAuthProbeOutput(result),
    provisional: /provisional/i.test(probe.notes || ""),
  };
}

module.exports = {
  AUTH_PROBE_TIMEOUT_MS,
  classifyAuthProbeOutput,
  probeRuntimeAuthState,
};
