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
const { bundleEntrypointArgs } = require("./detector");
const {
  buildRuntimeInvocationArgs,
  buildRuntimeProcessEnvironment,
} = require("./environment");

const AUTH_PROBE_TIMEOUT_MS = 15_000;

// Generic keyword classifier shared by providers. Conservative ordering:
// re-auth signals beat unauthenticated signals beat authenticated signals.
function classifyAuthProbeOutput({ exitCode, stdout, stderr }) {
  // Machine-readable probes win over keyword matching — a JSON status
  // payload's field names ("hasRefreshToken") would otherwise trip the
  // re-auth keyword list even in a clean unauthenticated state.
  const trimmed = (stdout || "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.status === "string") {
        const status = parsed.status.toLowerCase();
        if (status === "authenticated") return "AUTHENTICATED";
        if (status === "partially-authenticated") return "REAUTH_REQUIRED";
        if (status === "unauthenticated") return "NOT_AUTHENTICATED";
      }
    } catch {
      // not a JSON payload — fall through to keyword classification
    }
  }
  const text = `${stdout || ""}\n${stderr || ""}`.toLowerCase();
  if (/reauth|expired|refresh|revoked|invalid_grant/.test(text)) {
    return "REAUTH_REQUIRED";
  }
  if (
    /not\s+(logged|authenticated|signed)|unauthorized|unauthenticated|login required|no credentials|not logged in|"loggedin"\s*:\s*false|\b0 credentials?\b/.test(
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

// ACP_STDIO probes live on the provider adapter (they carry provider-
// specific method ids and classification). Lazy requires keep the module
// graph cycle-free.
function acpStdioProbeFor(backendKind) {
  switch (backendKind) {
    case "GROK_RUNTIME":
      return require("./grok").runGrokAcpAuthProbe;
    case "ANTIGRAVITY_RUNTIME":
      return require("./antigravity").runAntigravityAcpAuthProbe;
    default:
      return null;
  }
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
  spawnImpl,
  terminateImpl,
} = {}) {
  const definition = getRuntimeDefinition(backendKind);
  if (!definition) {
    throw new Error(`Unknown runtime backendKind: ${backendKind}`);
  }
  const probe = definition.authProbe;
  if (!probe) {
    return { backendKind, authState: "UNKNOWN", reason: "NO_PROBE_DEFINED" };
  }
  if (!executablePath) {
    return { backendKind, authState: "UNKNOWN", reason: "NOT_INSTALLED" };
  }
  if (!profileDir) {
    return { backendKind, authState: "UNKNOWN", reason: "PROFILE_REQUIRED" };
  }

  // Some runtimes have no one-shot status command — their only verified
  // auth surface is the ACP stdio handshake (Grok: agent --no-leader stdio
  // + authenticate(cached_token); Antigravity: acp +
  // authenticate(oauth-personal)). The adapter owns that exchange; this
  // probe delegates so getRuntimeStatus stays truthful for ACP_STDIO
  // backends.
  if (probe.kind === "ACP_STDIO") {
    const acpProbe = acpStdioProbeFor(backendKind);
    if (!acpProbe) {
      return { backendKind, authState: "UNKNOWN", reason: "NO_PROBE_DEFINED" };
    }
    const result = await acpProbe({
      executablePath,
      profileDir,
      baseEnv,
      timeoutMs,
      spawnImpl,
      terminateImpl,
    });
    return { backendKind, authState: result.authState };
  }

  if (!Array.isArray(probe.args)) {
    return { backendKind, authState: "UNKNOWN", reason: "NO_PROBE_DEFINED" };
  }

  const env = buildRuntimeProcessEnvironment({
    baseEnv: baseEnv || process.env,
    definition,
    profileDir,
  });
  const args = [
    // Bundle runtimes spawn the interpreter, so the bundle entrypoint
    // heads argv (e.g. node.exe index.js status --format json).
    ...bundleEntrypointArgs(definition, executablePath),
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
