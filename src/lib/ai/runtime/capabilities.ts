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

/** The consolidated descriptor emitted by runtime:list/getCapabilities. */
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
  execution: { localOneShot: boolean; acp?: boolean };
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
