// Consolidated ACCOUNT_LOGIN capability matrix — the single source of
// truth for what each managed runtime can actually do. Every value is a
// verified fact about the runtime as integrated today; nothing here is
// aspirational and no field is a fake "safe: true" boolean.
//
// Composition: identity/vendor/profile facts come from the runtime
// definition registry (never duplicated); behavior, permission, and
// manual-verification truth live in the matrix below. The result is the
// stable descriptor the Settings UI (via runtime:list) and the next
// phase's connectionId+model execution seam consume — the UI must never
// re-derive capability decisions from backendKind itself.
const {
  getRuntimeDefinition,
  listRuntimeDefinitions,
} = require("./registry");

// How the user completes the account login.
const LOGIN_INTERACTIONS = Object.freeze({
  // The runtime prints an authorize URL the renderer surfaces for the
  // user to open manually (the spawned CLI cannot open a browser).
  BROWSER: "BROWSER",
  // The CLI opens and drives the system browser itself; Vocatrya waits.
  RUNTIME_MANAGED_BROWSER: "RUNTIME_MANAGED_BROWSER",
  // The login UI is an interactive TUI that requires a real console
  // window (console input events — pipes cannot drive it).
  VISIBLE_CONSOLE: "VISIBLE_CONSOLE",
  // Reserved: device-code flow. No current runtime uses it.
  DEVICE_CODE: "DEVICE_CODE",
});

// How the runtime proves auth state without reading credential files.
const AUTH_VERIFICATION = Object.freeze({
  // A one-shot status command (login status / auth status / auth list /
  // status --format json) inside the managed env.
  STATUS_COMMAND: "STATUS_COMMAND",
  // The runtime has no status command; auth is probed through the ACP
  // stdio handshake (initialize + authenticate(cached_token)).
  ACP_STDIO: "ACP_STDIO",
  // Probe exists in the registry but is provisional/unverified.
  PROVISIONAL: "PROVISIONAL",
});

// Where a connection's model catalog comes from.
const MODEL_STRATEGIES = Object.freeze({
  // Runtime enumerates the account-visible catalog.
  RUNTIME: "RUNTIME",
  // Runtime discovery first, then a bundled/curated fallback catalog.
  RUNTIME_WITH_FALLBACK: "RUNTIME_WITH_FALLBACK",
  // No machine-readable discovery — curated alias list only.
  CURATED: "CURATED",
});

// Permission classification — a level, never a boolean. Describes the
// strongest enforcement the runtime actually provides for headless
// one-shot execution on Windows today.
const PERMISSION_LEVELS = Object.freeze({
  // OS/workspace sandbox enforced by the runtime (e.g. codex read-only).
  STRONG_SANDBOX: "STRONG_SANDBOX",
  // No OS sandbox on this platform; enforcement is runtime-level config
  // and flags (deny rules, empty allowlists, dontAsk/ask modes, managed
  // config). Verified configuration, but escape resistance depends on
  // runtime internals.
  BEST_EFFORT_RUNTIME_PERMISSIONS: "BEST_EFFORT_RUNTIME_PERMISSIONS",
  LIMITED: "LIMITED",
  NOT_READY: "NOT_READY",
});

// Known runtime auto-update behaviour and whether our managed layer
// suppresses it. Automatic AI requests must never silently upgrade a
// runtime.
const AUTO_UPDATE_STATES = Object.freeze({
  // Runtime ships an auto-updater; the managed config/flags disable it.
  MANAGED_OFF: "MANAGED_OFF",
  // Only an explicit self-update command exists; no auto-update observed.
  NONE_OBSERVED: "NONE_OBSERVED",
  // Auto-update behaviour not yet determined.
  UNKNOWN: "UNKNOWN",
});

// Manual verification maturity — development truth, NOT user-facing
// connection state. "PASS" means a real run against the real CLI was
// performed; "PENDING" means it has not been done yet.
const VERIFICATION_STATES = Object.freeze({
  PASS: "PASS",
  PENDING: "PENDING",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

// Structured-output mechanism classification — what the ACCOUNT_LOGIN
// one-shot CLI invocation itself can carry (audited against the installed
// versions). A provider's REST/SDK structured-output feature never counts.
const STRUCTURED_OUTPUT_STRATEGIES = Object.freeze({
  // The invocation transports a JSON Schema to the runtime and the
  // runtime claims enforcement (codex --output-schema, claude/grok
  // --json-schema).
  NATIVE_JSON_SCHEMA: "NATIVE_JSON_SCHEMA",
  // No schema transport — the schema rides inside the prompt and local
  // parse+validate (with at most one retry) decides conformance.
  PROMPT_AND_VALIDATE: "PROMPT_AND_VALIDATE",
  // No usable structured assistant-text path.
  UNSUPPORTED: "UNSUPPORTED",
});

// Structured-output verification — PASS/FAIL/PENDING bound to the
// verifiedRuntimeVersion actually trialled; NOT_APPLICABLE when the
// runtime is not implemented at all.
const STRUCTURED_OUTPUT_VERIFICATIONS = Object.freeze({
  PASS: "PASS",
  PENDING: "PENDING",
  FAIL: "FAIL",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

// ---------------------------------------------------------------------------
// The matrix. One entry per implemented ACCOUNT_LOGIN runtime plus the
// registered-but-unimplemented Copilot runtime (implemented: false — the
// registry knows it, no lifecycle adapter exists yet).
// ---------------------------------------------------------------------------
const ACCOUNT_RUNTIME_CAPABILITY_MATRIX = Object.freeze({
  CODEX_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      interaction: LOGIN_INTERACTIONS.RUNTIME_MANAGED_BROWSER,
      surfacesAuthorizationUrl: false,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.STATUS_COMMAND,
      // `codex login status` prints the account email when present.
      accountIdentity: true,
      // Only a ChatGPT session completes ACCOUNT_LOGIN.
      requiredMethod: "chatgpt",
    }),
    models: Object.freeze({
      // `codex debug models` (account-aware) → bundled catalog → curated
      // fallback, in that order.
      strategy: MODEL_STRATEGIES.RUNTIME_WITH_FALLBACK,
      dynamicDiscovery: true,
      customModel: true,
    }),
    execution: Object.freeze({
      // `codex exec --ephemeral -s read-only` in a Vocatrya temp cwd.
      localOneShot: true,
      // Re-verified 2026-10-28 on codex-cli 0.164.0, gpt-5.6-luna,
      // through the production app-server adapter: P1/P2/P3 reconstructed
      // exactly; P2 delivered 820 deltas across 497 chunks before completion.
      // P4 aborted at the first delta with no late deltas. Unknown
      // notifications remain ignored. Exact version equality stays closed.
      streaming: true,
      streamingVerification: VERIFICATION_STATES.PASS,
      streamingMechanism:
        "codex app-server (item/agentMessage/delta over stdio JSON-RPC)",
      streamingVerifiedRuntimeVersion: "0.164.0",
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.STRONG_SANDBOX,
      osSandbox: "READ_ONLY_WORKSPACE",
      toolRestriction: "SANDBOX_SCOPED",
      summary:
        "codex exec runs under the runtime's read-only workspace sandbox " +
        "with a Vocatrya-owned temp cwd and verified safe exec flags.",
    }),
    update: Object.freeze({ autoUpdate: AUTO_UPDATE_STATES.NONE_OBSERVED }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.PASS,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // `codex exec --output-schema <file>` — the schema file is written
    // into the fresh Vocatrya-owned exec cwd; the final message lands
    // in -o output. Re-verified 2026-10-28 on codex-cli 0.164.0,
    // gpt-5.6-luna, through production executeText: 9/9 synthetic trials
    // (flat, job-like, resume-like) first-pass VALID under NATIVE_JSON_SCHEMA,
    // no retries or native violations. Exact version equality stays closed.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.NATIVE_JSON_SCHEMA,
      mechanism: "codex exec --output-schema <schema-file>",
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PASS,
      verifiedRuntimeVersion: "0.164.0",
    }),
  }),

  CLAUDE_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      interaction: LOGIN_INTERACTIONS.RUNTIME_MANAGED_BROWSER,
      surfacesAuthorizationUrl: false,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.STATUS_COMMAND,
      // `claude auth status --json` reports email/org/subscriptionType.
      accountIdentity: true,
      requiredMethod: "CLAUDE_AI_SUBSCRIPTION",
    }),
    models: Object.freeze({
      // claude 2.1.203 has no machine-readable model enumeration.
      strategy: MODEL_STRATEGIES.CURATED,
      dynamicDiscovery: false,
      customModel: true,
    }),
    execution: Object.freeze({
      localOneShot: true,
      acp: true,
      // `claude -p --output-format stream-json --verbose
      // --include-partial-messages` is the CLI's NDJSON assistant-delta
      // mode (verified in --help on 2.1.203); not yet exercised through
      // the managed locked-down print invocation.
      streaming: false,
      streamingVerification: VERIFICATION_STATES.PENDING,
      streamingMechanism:
        "claude -p --output-format stream-json --verbose --include-partial-messages",
      streamingVerifiedRuntimeVersion: null,
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS,
      // No OS-level sandbox exists for Claude Code on native Windows.
      osSandbox: "NONE_ON_WINDOWS",
      toolRestriction: "EMPTY_ALLOWLIST_SAFE_MODE_DONTASK",
      summary:
        "--tools \"\" + --disallowedTools mcp__* + --safe-mode + " +
        "--permission-mode dontAsk + --no-session-persistence in a " +
        "Vocatrya temp cwd; no OS sandbox on Windows.",
    }),
    update: Object.freeze({ autoUpdate: AUTO_UPDATE_STATES.UNKNOWN }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.NOT_APPLICABLE,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // `claude -p --output-format json --json-schema <schema>` verified in
    // `claude --help` on 2.1.203 — the envelope's `structured_output`
    // field carries the validated object (result stays empty). The
    // StructuredOutput tool mechanism requires tools disabled, which the
    // managed print invocation already enforces (--tools "").
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.NATIVE_JSON_SCHEMA,
      mechanism: "claude -p --output-format json --json-schema <schema>",
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PENDING,
      verifiedRuntimeVersion: null,
    }),
  }),

  OPENCODE_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      // `opencode auth login` renders a clack TUI that reads console
      // input (provider/method selection, API-key entry) — it cannot be
      // driven over pipes. The adapter launches it inside a real console
      // window and the CLI owns the credential entry entirely.
      interaction: LOGIN_INTERACTIONS.VISIBLE_CONSOLE,
      surfacesAuthorizationUrl: false,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.STATUS_COMMAND,
      // `auth list` carries provider+auth-type only, never an identity.
      accountIdentity: false,
      // Zen/Go complete with the vendor API-key credential inside the
      // managed profile — an OAuth entry is never the expected method.
      requiredMethod: "api",
    }),
    models: Object.freeze({
      // `opencode models <provider>` — provider-filtered runtime catalog.
      strategy: MODEL_STRATEGIES.RUNTIME,
      dynamicDiscovery: true,
      customModel: true,
      // Arbitrary ids are accepted only under the bound account
      // provider's route (e.g. openai/<id>); foreign routes are refused.
      customModelConstraint: "PROVIDER_PREFIXED",
    }),
    execution: Object.freeze({
      // `opencode run --pure --format json` under a deny-all managed
      // config in a Vocatrya temp cwd.
      localOneShot: true,
      // `opencode run --format json` is already the JSONL event stream the
      // one-shot adapter parses — part.text cumulative snapshots are
      // diffable into deltas. Live incremental emission (not a buffered
      // dump at exit) inside the managed invocation is unverified.
      streaming: false,
      streamingVerification: VERIFICATION_STATES.PENDING,
      streamingMechanism: "opencode run --format json",
      streamingVerifiedRuntimeVersion: null,
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS,
      osSandbox: "NONE",
      toolRestriction: "DENY_ALL_CONFIG_AND_PURE",
      summary:
        "Vocatrya-managed opencode.json permission:{\"*\":\"deny\"} + " +
        "--pure (no plugins/MCP) + temp cwd; adversarial runtime " +
        "verification is still pending.",
    }),
    update: Object.freeze({ autoUpdate: AUTO_UPDATE_STATES.UNKNOWN }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.PASS,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // `opencode run --format json` is a JSONL event stream — transport,
    // not schema enforcement. `opencode run --help` on 1.18.31 exposes no
    // schema flag, so structured output is prompt + local validation only.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.PROMPT_AND_VALIDATE,
      mechanism: null,
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PENDING,
      verifiedRuntimeVersion: null,
    }),
  }),

  GROK_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      interaction: LOGIN_INTERACTIONS.BROWSER,
      surfacesAuthorizationUrl: true,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.ACP_STDIO,
      // authenticate(cached_token) returns {email, auth_mode, tier}.
      accountIdentity: true,
      requiredMethod: "XAI_OAUTH_SESSION",
    }),
    models: Object.freeze({
      // `grok models` — account-visible catalog; unauthenticated output
      // is the bundled list and is reported as discovery-unavailable.
      strategy: MODEL_STRATEGIES.RUNTIME,
      dynamicDiscovery: true,
      customModel: true,
    }),
    execution: Object.freeze({
      localOneShot: true,
      acp: true,
      // `grok -p --output-format streaming-messages-json
      // --include-partial-messages` is a direct print-mode delta channel
      // (verified in --help on 1.0.41 — emits incremental stream_event
      // lines in the Anthropic Messages wire format); not yet exercised
      // through the managed locked-down invocation.
      streaming: false,
      streamingVerification: VERIFICATION_STATES.PENDING,
      streamingMechanism:
        "grok -p --output-format streaming-messages-json --include-partial-messages",
      streamingVerifiedRuntimeVersion: null,
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS,
      // --sandbox strict is a documented no-op on Windows (Landlock /
      // Seatbelt only); still passed because it refuses leader mode.
      osSandbox: "NO_OP_ON_WINDOWS",
      toolRestriction: "EMPTY_ALLOWLIST_DENY_DONTASK",
      summary:
        "--tools \"\" + deny rules (Bash/Read/Edit/Write/Grep/WebFetch/" +
        "MCPTool) + --permission-mode dontAsk + --no-auto-update/" +
        "--no-memory/--no-subagents in a Vocatrya temp cwd; the OS " +
        "sandbox flag is a no-op on Windows.",
    }),
    update: Object.freeze({
      // grok ships an auto-updater; the managed config (auto_update =
      // false) and --no-auto-update flag keep AI runs off it.
      autoUpdate: AUTO_UPDATE_STATES.MANAGED_OFF,
    }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      // The ACP initialize/authenticate exchange was verified against
      // real grok builds — a real OAuth login E2E has not been run.
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.PASS,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // `grok -p --json-schema <schema>` verified in `grok --help` on
    // 1.0.41 — "the model is constrained to produce JSON matching this
    // schema"; implies --output-format json so the {text,...} envelope
    // carries the constrained object. xAI REST structured outputs are a
    // different layer and are never counted.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.NATIVE_JSON_SCHEMA,
      mechanism: "grok -p --json-schema <schema>",
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PENDING,
      verifiedRuntimeVersion: null,
    }),
  }),

  CURSOR_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      interaction: LOGIN_INTERACTIONS.BROWSER,
      // NO_OPEN_BROWSER=1 makes `agent login` print the loginDeepControl
      // URL, which the adapter surfaces to the renderer.
      surfacesAuthorizationUrl: true,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.STATUS_COMMAND,
      // `agent status --format json` carries userInfo.email/userId.
      accountIdentity: true,
      // Provenance-based: inside the managed profile only `agent login`
      // can write credentials, so AUTHENTICATED implies the browser flow.
      requiredMethod: "CURSOR_BROWSER_ACCOUNT",
    }),
    models: Object.freeze({
      strategy: MODEL_STRATEGIES.RUNTIME,
      dynamicDiscovery: true,
      customModel: true,
    }),
    execution: Object.freeze({
      localOneShot: true,
      acp: true,
      // `agent -p --output-format streaming-json` exists on
      // 2026.09.18-9a7762b (verified in --help — "one ACP session update
      // per line"); whether it delivers consumable assistant-text deltas
      // inside the managed invocation is unverified.
      streaming: false,
      streamingVerification: VERIFICATION_STATES.PENDING,
      streamingMechanism: "agent -p --output-format streaming-json",
      streamingVerifiedRuntimeVersion: null,
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS,
      // --sandbox enabled is the runtime's sandbox flag, not a verified
      // OS sandbox on Windows.
      osSandbox: "RUNTIME_FLAG_UNVERIFIED",
      toolRestriction: "DENY_ALL_CONFIG_ASK_MODE",
      summary:
        "Managed cli-config.json permissions.allow=[] + broad deny rules " +
        "+ approvalMode allowlist + --mode ask + --sandbox enabled + " +
        "--disable-project-configs/--exclude-workspace-context in a " +
        "Vocatrya temp cwd; runtime-level adversarial test is pending.",
    }),
    update: Object.freeze({
      // cursor-agent auto-updates; --disable-auto-update is passed on
      // every managed invocation.
      autoUpdate: AUTO_UPDATE_STATES.MANAGED_OFF,
    }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.PASS,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // `agent -p --output-format json` on 2026.09.18-9a7762b is a
    // {type:"result", result:"..."} envelope — transport only. `agent -p
    // --help` exposes no schema flag: prompt + local validation only.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.PROMPT_AND_VALIDATE,
      mechanism: null,
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PENDING,
      verifiedRuntimeVersion: null,
    }),
  }),

  DEVIN_RUNTIME: Object.freeze({
    implemented: true,
    login: Object.freeze({
      // `devin auth login` renders a console-input TUI; the adapter
      // launches it inside a real console window (cmd start /wait) and
      // the CLI owns the browser flow entirely.
      interaction: LOGIN_INTERACTIONS.VISIBLE_CONSOLE,
      surfacesAuthorizationUrl: false,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.STATUS_COMMAND,
      accountIdentity: true,
      // Only "Logged in (via Devin)" completes ACCOUNT_LOGIN.
      requiredMethod: "DEVIN_ACCOUNT",
    }),
    models: Object.freeze({
      // `devin models list --format json` — families[].variants[].
      strategy: MODEL_STRATEGIES.RUNTIME,
      dynamicDiscovery: true,
      customModel: true,
    }),
    execution: Object.freeze({
      // `devin -p` under --permission-mode auto in a Vocatrya temp cwd.
      localOneShot: true,
      acp: true,
      // VERIFIED_DELTA_STREAMING (managed E2E, devin 3000.10.31,
      // scripts/runtime-streaming-probe.mts): `devin -p` flushes
      // assistant text incrementally on stdout — P2 produced 307 deltas
      // across 307 deliveries over ~17s with the first delta ~6s before
      // process exit; abort terminates the child with no late deltas.
      // `devin acp` (session/update over stdio) remains an unverified
      // structured-delta fallback.
      streaming: true,
      streamingVerification: VERIFICATION_STATES.PASS,
      streamingMechanism: "devin -p",
      streamingVerifiedRuntimeVersion: "3000.10.31",
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS,
      // --sandbox requires WSL and refuses to start on native Windows.
      osSandbox: "UNAVAILABLE_ON_WINDOWS",
      toolRestriction: "DENY_RULES_AUTO_MODE",
      summary:
        "Managed config deny rules (exec/edit/mcp__*/Write/Read(/**)) + " +
        "--permission-mode auto + read_config_from/subagents/auto_update " +
        "disabled + Vocatrya temp cwd; adversarial permission test passed.",
    }),
    update: Object.freeze({
      // devin auto-updates in the background; the managed config sets
      // auto_update = false.
      autoUpdate: AUTO_UPDATE_STATES.MANAGED_OFF,
    }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PASS,
      authProbe: VERIFICATION_STATES.PASS,
      realModelCatalog: VERIFICATION_STATES.PASS,
      realInferenceE2E: VERIFICATION_STATES.PASS,
      adversarialPermissions: VERIFICATION_STATES.PASS,
    }),
    // `devin -p` on 3000.10.31 has no schema flag — plain stdout text.
    // Devin Cloud/API session-level structured output is a different
    // layer and never counts toward the local CLI contract.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.PROMPT_AND_VALIDATE,
      mechanism: null,
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.PASS,
      verifiedRuntimeVersion: "3000.10.31",
    }),
  }),

  // Registered in the runtime registry but intentionally without a
  // lifecycle adapter this phase — every capability is latent metadata,
  // nothing is implemented or verified.
  COPILOT_RUNTIME: Object.freeze({
    implemented: false,
    login: Object.freeze({
      interaction: LOGIN_INTERACTIONS.RUNTIME_MANAGED_BROWSER,
      surfacesAuthorizationUrl: false,
    }),
    auth: Object.freeze({
      verification: AUTH_VERIFICATION.PROVISIONAL,
      accountIdentity: false,
      requiredMethod: null,
    }),
    models: Object.freeze({
      strategy: MODEL_STRATEGIES.RUNTIME,
      dynamicDiscovery: true,
      customModel: false,
    }),
    execution: Object.freeze({
      localOneShot: false,
      // Lifecycle unimplemented — no invocation exists to stream from.
      streaming: false,
      streamingVerification: VERIFICATION_STATES.NOT_APPLICABLE,
      streamingMechanism: null,
      streamingVerifiedRuntimeVersion: null,
    }),
    permission: Object.freeze({
      level: PERMISSION_LEVELS.NOT_READY,
      osSandbox: "UNKNOWN",
      toolRestriction: "UNKNOWN",
      summary: "Registered runtime definition only — lifecycle not implemented.",
    }),
    update: Object.freeze({ autoUpdate: AUTO_UPDATE_STATES.UNKNOWN }),
    verification: Object.freeze({
      realLoginE2E: VERIFICATION_STATES.PENDING,
      authProbe: VERIFICATION_STATES.PENDING,
      realModelCatalog: VERIFICATION_STATES.PENDING,
      realInferenceE2E: VERIFICATION_STATES.PENDING,
      adversarialPermissions: VERIFICATION_STATES.PENDING,
    }),
    // Lifecycle not implemented — no one-shot structured path exists.
    structuredOutput: Object.freeze({
      strategy: STRUCTURED_OUTPUT_STRATEGIES.UNSUPPORTED,
      mechanism: null,
      verification: STRUCTURED_OUTPUT_VERIFICATIONS.NOT_APPLICABLE,
      verifiedRuntimeVersion: null,
    }),
  }),
});

// Composes a registry definition with its capability-matrix entry into the
// stable descriptor consumed by IPC/UI/future execution seam. Returns null
// for an unknown backendKind — never a guessed capability set.
function getAccountRuntimeCapabilities(backendKind) {
  const definition = getRuntimeDefinition(backendKind);
  if (!definition) return null;
  const matrix = ACCOUNT_RUNTIME_CAPABILITY_MATRIX[backendKind];
  if (!matrix) {
    // A registered runtime without a matrix entry is a registry bug —
    // fail closed rather than invent capabilities.
    return null;
  }
  return {
    backendKind: definition.backendKind,
    displayName: definition.displayName,
    runtimeVendor: definition.runtimeVendor,
    supportedAccountProviders: definition.supportedAccountProviders.slice(),
    implemented: matrix.implemented,
    capabilities: {
      accountLogin: definition.capabilities.accountLogin === true,
      browserLogin: true,
      deviceLogin:
        matrix.login.interaction === LOGIN_INTERACTIONS.DEVICE_CODE,
      authVerification: matrix.auth.verification,
      accountIdentity: matrix.auth.accountIdentity,
      dynamicModelDiscovery: matrix.models.dynamicDiscovery,
      customModel: matrix.models.customModel,
      localOneShot: matrix.execution.localOneShot,
      acp:
        matrix.execution.acp === true ||
        definition.capabilities.acp === true,
      install: {
        available: definition.install.methods.length > 0,
        executionEnabled: definition.install.executionEnabled === true,
      },
      update: {
        available: definition.update.methods.length > 0,
        executionEnabled: definition.update.executionEnabled === true,
        selfUpdate: definition.update.methods.some(
          (method) => method.kind === "self-update",
        ),
        autoUpdate: matrix.update.autoUpdate,
      },
      // Per-connection managed profiles give true multi-account
      // isolation for every registered runtime.
      multiAccountIsolation: true,
    },
    login: matrix.login,
    auth: matrix.auth,
    models: matrix.models,
    execution: matrix.execution,
    permission: matrix.permission,
    profile: {
      strategy: definition.profile.strategy,
      credentialBoundary: (definition.profile.credentialBoundary || []).slice(),
      // Defensive redirects that are not credential-bearing.
      isolationRoots: Object.keys(definition.profile.env || {}).filter(
        (key) => !(definition.profile.credentialBoundary || []).includes(key),
      ),
      browserLoginEnvPassthrough: (
        definition.profile.browserLoginEnvPassthrough || []
      ).slice(),
    },
    verification: matrix.verification,
    structuredOutput: matrix.structuredOutput,
  };
}

function listAccountRuntimeCapabilities() {
  return listRuntimeDefinitions()
    .map((definition) => getAccountRuntimeCapabilities(definition.backendKind))
    .filter(Boolean);
}

module.exports = {
  ACCOUNT_RUNTIME_CAPABILITY_MATRIX,
  AUTH_VERIFICATION,
  AUTO_UPDATE_STATES,
  LOGIN_INTERACTIONS,
  MODEL_STRATEGIES,
  PERMISSION_LEVELS,
  STRUCTURED_OUTPUT_STRATEGIES,
  STRUCTURED_OUTPUT_VERIFICATIONS,
  VERIFICATION_STATES,
  getAccountRuntimeCapabilities,
  listAccountRuntimeCapabilities,
};
