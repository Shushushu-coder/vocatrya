/**
 * Online runtime update-check contract — the backend-side typed mirror of
 * desktop/main/runtime/update-check.js.
 *
 * The update check is read-only: it reports the upstream-advertised latest
 * version, the verdict against the locally probed version, and the
 * exact-version capability certification axis. Execution is never enabled
 * here — install/update methods remain documentation metadata.
 */

/** The update-check verdict reported by the main-process service. */
export const RUNTIME_UPDATE_CHECK_STATES = [
  // Runtime not installed — upstream was not queried.
  "NOT_RUN",
  // No upstream source is declared for this runtime.
  "UNSUPPORTED",
  // Every upstream attempt failed or returned nothing parseable —
  // NEVER presented as "up to date".
  "CHECK_FAILED",
  // Installed but the local version could not be probed (BROKEN);
  // the advertised latest is still reported.
  "CURRENT_UNKNOWN",
  // One of the two versions could not be parsed for comparison.
  "UNCOMPARABLE",
  "UP_TO_DATE",
  "UPDATE_AVAILABLE",
  // The installed build is newer than the channel's promoted latest.
  "AHEAD_OF_CHANNEL",
] as const;
export type RuntimeUpdateCheckStatus =
  (typeof RUNTIME_UPDATE_CHECK_STATES)[number];

/** Upstream source kinds declared in the runtime registry. */
export const RUNTIME_UPDATE_SOURCE_KINDS = [
  "npm-latest",
  "channel-file",
  "json-manifest",
  "install-script",
] as const;
export type RuntimeUpdateSourceKind =
  (typeof RUNTIME_UPDATE_SOURCE_KINDS)[number];

/**
 * Exact-version capability compatibility — separate from "a newer build
 * exists". Managed capabilities are certified against precise runtime
 * versions, so a build is only VERIFIED when it equals a certified one.
 */
export const RUNTIME_UPDATE_COMPATIBILITY = [
  "VERIFIED",
  "UNVERIFIED",
  "NO_CERTIFIED_BASELINE",
] as const;
export type RuntimeUpdateCompatibility =
  (typeof RUNTIME_UPDATE_COMPATIBILITY)[number];

export interface RuntimeUpdateCheckErrorCodes {
  NETWORK: "NETWORK";
  TIMEOUT: "TIMEOUT";
  INVALID_RESPONSE: "INVALID_RESPONSE";
  /** HTTP failures arrive as `HTTP_<status>` (e.g. HTTP_503). */
}

export interface RuntimeUpdateRecovery {
  kind: string;
  /** The certified version the recovery path restores. */
  version: string;
  /**
   * A real, documented command the user may run themselves to restore the
   * certified version — display text only, never executed by the app.
   * Null when no scripted downgrade path exists.
   */
  command: string | null;
}

/** The composite update report returned by runtime:checkUpdate. */
export interface RuntimeUpdateCheckResult {
  backendKind: string;
  runtimeVendor: string;
  installed: boolean;
  /** Raw local detect state: NOT_INSTALLED | READY | BROKEN. */
  installState: string;
  /**
   * installState upgraded by the check verdict — UPDATE_AVAILABLE only
   * when an online comparison proved a newer published build.
   */
  effectiveState: string;
  currentVersion: string | null;
  check: {
    supported: boolean;
    status: RuntimeUpdateCheckStatus;
    latestVersion: string | null;
    /** ISO timestamp of the actual upstream fetch (cache hits keep it). */
    checkedAt: string | null;
    source: string | null;
    /** True when the upstream verdict came from the shared cache. */
    fromCache: boolean;
    /** How many network attempts the verdict cost. */
    attempts: number;
    /** Stable failure code: NETWORK | TIMEOUT | INVALID_RESPONSE | HTTP_*. */
    error: string | null;
  };
  compatibility: {
    /** Precise versions holding a capability certification. */
    certifiedVersions: string[];
    current: RuntimeUpdateCompatibility | null;
    available: RuntimeUpdateCompatibility | null;
  };
  /** Honest downgrade guidance for certified versions, when one exists. */
  recovery: RuntimeUpdateRecovery | null;
  /** Update execution stays disabled — methods are documentation only. */
  executionEnabled: false;
  methods: {
    kind: string;
    summary: string;
    executable: string;
    args: string[];
    documentationUrl?: string;
  }[];
}
