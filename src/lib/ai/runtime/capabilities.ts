/**
 * Consolidated ACCOUNT_LOGIN capability contract — the backend-side typed
 * mirror of desktop/main/runtime/capabilities.js.
 *
 * The capability DATA lives only in the Electron main registry/matrix;
 * this module contains pure types plus the small helpers a UI or the
 * future execution seam needs to reason about a descriptor it was handed
 * (over IPC or an internal API). Nothing here may spawn, read files, or
 * touch the database.
 *
 * It also defines the next phase's provider-neutral execution seam
 * (executeAIConnection contract) — types only. No business surface
 * consumes runtime execution yet.
 */

/** How the user completes an account login. */
export const RUNTIME_LOGIN_INTERACTIONS = [
  "BROWSER",
  "DEVICE_CODE",
  "VISIBLE_CONSOLE",
  "RUNTIME_MANAGED_BROWSER",
] as const;
export type RuntimeLoginInteraction =
  (typeof RUNTIME_LOGIN_INTERACTIONS)[number];

/** How the runtime proves auth state without reading credential files. */
export const RUNTIME_AUTH_VERIFICATION = [
  "STATUS_COMMAND",
  "ACP_STDIO",
  "PROVISIONAL",
] as const;
export type RuntimeAuthVerification =
  (typeof RUNTIME_AUTH_VERIFICATION)[number];

/** Where a connection's model catalog comes from. */
export const RUNTIME_MODEL_STRATEGIES = [
  "RUNTIME",
  "RUNTIME_WITH_FALLBACK",
  "CURATED",
] as const;
export type RuntimeModelStrategy = (typeof RUNTIME_MODEL_STRATEGIES)[number];

/**
 * Permission classification — a level, never a `safe: true` boolean.
 * Describes the strongest enforcement the runtime actually provides for
 * headless one-shot execution on this platform today.
 */
export const RUNTIME_PERMISSION_LEVELS = [
  "STRONG_SANDBOX",
  "BEST_EFFORT_RUNTIME_PERMISSIONS",
  "LIMITED",
  "NOT_READY",
] as const;
export type RuntimePermissionLevel =
  (typeof RUNTIME_PERMISSION_LEVELS)[number];

/** Known runtime auto-update behaviour under our managed profile. */
export const RUNTIME_AUTO_UPDATE_STATES = [
  "MANAGED_OFF",
  "NONE_OBSERVED",
  "UNKNOWN",
] as const;
export type RuntimeAutoUpdateState =
  (typeof RUNTIME_AUTO_UPDATE_STATES)[number];

/**
 * Manual verification maturity — development truth only. These flags are
 * runtime/integration maturity metadata; they must never be persisted to
 * a user-facing AIConnection row or presented as a safety claim.
 */
export const RUNTIME_VERIFICATION_STATES = [
  "PASS",
  "PENDING",
  "NOT_APPLICABLE",
] as const;
export type RuntimeVerificationState =
  (typeof RUNTIME_VERIFICATION_STATES)[number];

// ---------------------------------------------------------------------------
// Structured-output capability — the cross-runtime validation contract.
// ---------------------------------------------------------------------------

/**
 * How the runtime's ACCOUNT_LOGIN one-shot invocation can produce
 * schema-shaped output. REST/SDK structured-output features of a provider
 * are NEVER counted — only what the managed CLI invocation exposes.
 */
export const STRUCTURED_OUTPUT_STRATEGIES = [
  "NATIVE_JSON_SCHEMA",
  "PROMPT_AND_VALIDATE",
  "UNSUPPORTED",
] as const;
export type StructuredOutputStrategy =
  (typeof STRUCTURED_OUTPUT_STRATEGIES)[number];

/**
 * Engineering verification state for the strategy. FAIL means a real
 * managed trial ran and the mechanism did not hold; PENDING means it has
 * not been proven for the recorded runtime version.
 */
export const STRUCTURED_OUTPUT_VERIFICATIONS = [
  "PASS",
  "PENDING",
  "FAIL",
  "NOT_APPLICABLE",
] as const;
export type StructuredOutputVerification =
  (typeof STRUCTURED_OUTPUT_VERIFICATIONS)[number];

/**
 * Future-consumer eligibility: which structured-output consumers (Resume,
 * JobDescriptionParse) may bind to this runtime once migrated. Never a
 * ranking — a mechanism verdict only.
 */
export const STRUCTURED_OUTPUT_ELIGIBILITIES = [
  "ELIGIBLE_NATIVE",
  "ELIGIBLE_PROMPT_RETRY",
  "PENDING",
  "NOT_ELIGIBLE",
] as const;
export type StructuredOutputEligibility =
  (typeof STRUCTURED_OUTPUT_ELIGIBILITIES)[number];

export interface StructuredOutputCapability {
  strategy: StructuredOutputStrategy;
  /**
   * The concrete ACCOUNT_LOGIN CLI mechanism (e.g.
   * `codex exec --output-schema <file>`), or null for prompt-only.
   */
  mechanism: string | null;
  verification: StructuredOutputVerification;
  /** The runtime binary version the verification ran against. */
  verifiedRuntimeVersion: string | null;
}

/**
 * Readiness gate for the future structured-output consumers
 * (`consumerKind` is reserved — "RESUME" | "JOB_DESCRIPTION_PARSE" — and
 * does not change the verdict today). Pure: takes the descriptor the
 * caller was handed; never derives anything from backendKind itself.
 */
export function checkStructuredOutputReadiness({
  capabilities,
}: {
  capabilities: AccountRuntimeCapabilities | null | undefined;
  consumerKind?: "RESUME" | "JOB_DESCRIPTION_PARSE";
}): StructuredOutputEligibility {
  if (!capabilities || capabilities.implemented !== true) {
    return "NOT_ELIGIBLE";
  }
  const structured = capabilities.structuredOutput;
  if (!structured || structured.strategy === "UNSUPPORTED") {
    return "NOT_ELIGIBLE";
  }
  if (structured.verification === "PENDING") return "PENDING";
  if (structured.verification !== "PASS") return "NOT_ELIGIBLE";
  return structured.strategy === "NATIVE_JSON_SCHEMA"
    ? "ELIGIBLE_NATIVE"
    : "ELIGIBLE_PROMPT_RETRY";
}

/** The consolidated descriptor emitted by runtime:list. */
export interface AccountRuntimeCapabilities {
  backendKind: string;
  displayName: string;
  runtimeVendor: string;
  supportedAccountProviders: string[];
  /** False for registry-known runtimes with no lifecycle adapter yet. */
  implemented: boolean;
  capabilities: {
    accountLogin: boolean;
    browserLogin: boolean;
    deviceLogin: boolean;
    authVerification: RuntimeAuthVerification;
    /** The auth probe can report a non-secret account identity. */
    accountIdentity: boolean;
    dynamicModelDiscovery: boolean;
    /** The runtime accepts an arbitrary model id (see models constraint). */
    customModel: boolean;
    /** Headless one-shot invocation exists (exec/-p/run). */
    localOneShot: boolean;
    acp: boolean;
    install: { available: boolean; executionEnabled: boolean };
    update: {
      available: boolean;
      executionEnabled: boolean;
      selfUpdate: boolean;
      autoUpdate: RuntimeAutoUpdateState;
    };
    multiAccountIsolation: boolean;
  };
  login: {
    interaction: RuntimeLoginInteraction;
    /** The adapter may emit an authorize URL the UI must render. */
    surfacesAuthorizationUrl: boolean;
  };
  auth: {
    verification: RuntimeAuthVerification;
    accountIdentity: boolean;
    /** The only auth method/kind that completes ACCOUNT_LOGIN. */
    requiredMethod: string | null;
  };
  models: {
    strategy: RuntimeModelStrategy;
    dynamicDiscovery: boolean;
    customModel: boolean;
    customModelConstraint?: string;
  };
  execution: {
    localOneShot: boolean;
    /**
     * Verified consumable assistant-text deltas through the managed
     * locked-down invocation — the capability streaming consumers (Career
     * Dialogue) gate on. True only after a real managed run observed
     * incremental output; a runtime whose CLI merely documents a stream
     * mode stays false.
     */
    streaming: boolean;
    /** Verification state behind `streaming` — PENDING is not permission. */
    streamingVerification?: RuntimeVerificationState;
    /** The candidate/verified delta transport, or null when none exists. */
    streamingMechanism?: string | null;
    /**
     * The runtime binary version the streaming verification ran against,
     * or the exact-membership list of accepted builds (Devin). A PASS
     * applies only to that version or to a listed member — anything else
     * stays unverified.
     */
    streamingVerifiedRuntimeVersion?: string | readonly string[] | null;
    acp?: boolean;
  };
  permission: {
    level: RuntimePermissionLevel;
    osSandbox: string;
    toolRestriction: string;
    summary: string;
  };
  profile: {
    strategy: string;
    /** Env keys whose managed redirect the credential store depends on. */
    credentialBoundary: string[];
    /** Additional defensive roots redirected into the profile. */
    isolationRoots: string[];
    /** Host env keys restored only for browser-facing login spawns. */
    browserLoginEnvPassthrough: string[];
  };
  verification: {
    realLoginE2E: RuntimeVerificationState;
    authProbe: RuntimeVerificationState;
    realModelCatalog: RuntimeVerificationState;
    realInferenceE2E: RuntimeVerificationState;
    adversarialPermissions: RuntimeVerificationState;
  };
  structuredOutput: StructuredOutputCapability;
}

// ---------------------------------------------------------------------------
// Execution seam (next phase) — contract only.
// ---------------------------------------------------------------------------

/**
 * The permission scope a business surface requests. The provider runtime
 * never decides file access itself — Vocatrya does. Only TEXT_ONLY exists
 * today; file authorization scopes land with the execution phase.
 */
export const AI_PERMISSION_SCOPES = [
  "TEXT_ONLY",
  "USER_SELECTED_FILES_READ",
  "USER_SELECTED_FILES_READ_WRITE",
] as const;
export type AIPermissionScope = (typeof AI_PERMISSION_SCOPES)[number];

/**
 * Provider-neutral execution request for a future
 * `executeAIConnection(...)`. Model is always explicit — AIConnection is
 * never a model. Deliberately excludes threads, tool orchestration, ACP
 * sessions, cloud handoff, and multi-turn state.
 */
export interface AIConnectionExecutionRequest {
  connectionId: string;
  model: string;
  prompt: string;
  permissionScope: AIPermissionScope;
  /** Vocatrya-owned working directory; required for non-TEXT_ONLY later. */
  workingDirectory?: string;
}

export interface AIConnectionExecutionResult {
  text: string;
  provider: string;
  backendKind: string;
  model: string;
}

export type ExecutionReadiness =
  | { ready: true }
  | { ready: false; code: string };

/**
 * Pure pre-flight check for the future execution seam: a
 * connectionId+model pair may run a TEXT_ONLY one-shot only when the
 * runtime implements the lifecycle, exposes local one-shot execution, the
 * connection is authenticated, and the requested scope is TEXT_ONLY.
 *
 * The capability descriptor is passed in (fetched over IPC or the internal
 * API) — this helper never re-derives capability from backendKind.
 */
export function checkTextOnlyExecutionReadiness({
  capabilities,
  connectionStatus,
  permissionScope,
}: {
  capabilities: AccountRuntimeCapabilities | null | undefined;
  connectionStatus: string;
  permissionScope: AIPermissionScope;
}): ExecutionReadiness {
  if (!capabilities || !capabilities.implemented) {
    return { ready: false, code: "UNSUPPORTED_BACKEND" };
  }
  if (permissionScope !== "TEXT_ONLY") {
    return { ready: false, code: "PERMISSION_BOUNDARY_NOT_READY" };
  }
  if (!capabilities.execution.localOneShot) {
    return { ready: false, code: "PERMISSION_BOUNDARY_NOT_READY" };
  }
  if (connectionStatus === "REAUTH_REQUIRED") {
    return { ready: false, code: "REAUTH_REQUIRED" };
  }
  if (connectionStatus !== "CONNECTED") {
    return { ready: false, code: "AUTH_NOT_CONFIRMED" };
  }
  return { ready: true };
}

/**
 * Exact binding for a streaming PASS. A string must match that version.
 * A list matches only its members. Keep this identical to
 * `streamingRuntimeVersionMatches` in desktop/main/runtime/capabilities.js.
 */
export function streamingRuntimeVersionMatches(
  bound: string | readonly string[] | null | undefined,
  runtimeVersion: string | null | undefined,
): boolean {
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
    return false;
  }
  if (typeof bound === "string") {
    return bound.length > 0 && runtimeVersion === bound;
  }
  if (Array.isArray(bound)) return bound.includes(runtimeVersion);
  return false;
}

/**
 * Pure pre-flight check for a streaming conversation turn (Career
 * Dialogue): same gates as the one-shot check plus verified incremental
 * output bound to the installed runtime version. execution.streaming is
 * the verdict — a runtime without it can never serve a streaming surface,
 * and STREAMING_NOT_SUPPORTED is the stable failure code (no silent
 * downgrade to a buffered one-shot, which would be fake streaming). A PASS
 * verdict is bound to `streamingVerifiedRuntimeVersion`; the caller must
 * supply `runtimeVersion` — the version probed on the installed binary —
 * and any mismatch (including an absent one, or a version missing from
 * a verified list) is STREAMING_NOT_VERIFIED.
 */
export function checkStreamingExecutionReadiness({
  capabilities,
  connectionStatus,
  permissionScope,
  runtimeVersion,
}: {
  capabilities: AccountRuntimeCapabilities | null | undefined;
  connectionStatus: string;
  permissionScope: AIPermissionScope;
  /** The version probed on the currently installed runtime binary. */
  runtimeVersion?: string | null;
}): ExecutionReadiness {
  if (!capabilities || !capabilities.implemented) {
    return { ready: false, code: "UNSUPPORTED_BACKEND" };
  }
  if (permissionScope !== "TEXT_ONLY") {
    return { ready: false, code: "PERMISSION_BOUNDARY_NOT_READY" };
  }
  if (!capabilities.execution.streaming) {
    return { ready: false, code: "STREAMING_NOT_SUPPORTED" };
  }
  // Verified-version binding: a PASS applies to the measured version or
  // to a member of the verified list. PENDING/FAIL, a missing binding,
  // and any other version fail closed here.
  if (capabilities.execution.streamingVerification !== "PASS") {
    return { ready: false, code: "STREAMING_NOT_VERIFIED" };
  }
  if (
    !streamingRuntimeVersionMatches(
      capabilities.execution.streamingVerifiedRuntimeVersion,
      runtimeVersion,
    )
  ) {
    return { ready: false, code: "STREAMING_NOT_VERIFIED" };
  }
  if (connectionStatus === "REAUTH_REQUIRED") {
    return { ready: false, code: "REAUTH_REQUIRED" };
  }
  if (connectionStatus !== "CONNECTED") {
    return { ready: false, code: "AUTH_NOT_CONFIRMED" };
  }
  return { ready: true };
}
