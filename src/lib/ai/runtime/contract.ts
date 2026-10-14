/**
 * Phase C runtime/profile contract — the backend-side typed seam.
 *
 * The authoritative runtime implementation (registry, profile manager,
 * environment isolation, command runner, probes) lives in the Electron main
 * process under desktop/main/runtime/. This module deliberately contains
 * only pure contracts: types, the opaque profile-ref validator, and the
 * connection → profile resolution helper. It has no filesystem access and
 * never turns a ref into a path — managed directories are an Electron-main
 * implementation detail, not a database contract.
 */
import {
  AI_RESOLUTION_ERROR_CODES,
  AIResolutionError,
  isAIBackendKind,
  type AIBackendKind,
} from "@/lib/ai/connections";

export const RUNTIME_INSTALLATION_STATES = [
  "NOT_INSTALLED",
  "READY",
  "UPDATE_AVAILABLE",
  "BROKEN",
] as const;
export type RuntimeInstallationState =
  (typeof RUNTIME_INSTALLATION_STATES)[number];

export const RUNTIME_AUTH_STATES = [
  "AUTHENTICATED",
  "NOT_AUTHENTICATED",
  "REAUTH_REQUIRED",
  "UNKNOWN",
] as const;
export type RuntimeAuthState = (typeof RUNTIME_AUTH_STATES)[number];

// Keep in sync with desktop/main/runtime/profiles.js — the opaque ref format
// is a shared contract even though the two layers never import each other.
export const RUNTIME_PROFILE_REF_PATTERN =
  /^rp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RuntimeProfileRef = `rp_${string}`;

export function isRuntimeProfileRef(
  value: unknown,
): value is RuntimeProfileRef {
  return (
    typeof value === "string" && RUNTIME_PROFILE_REF_PATTERN.test(value)
  );
}

/** Minimal AIConnection shape the resolver reads — nothing else is touched. */
export interface RuntimeProfileConnectionRow {
  id: string;
  backendKind: string;
  runtimeProfileRef: string | null;
}

export interface ResolvedRuntimeProfile {
  connectionId: string;
  backendKind: Exclude<AIBackendKind, "MANAGED_GATEWAY" | "LOCAL_BYOK">;
  runtimeProfileRef: RuntimeProfileRef;
}

/**
 * Pure infrastructure resolution: AIConnection → the opaque profile binding
 * the Electron runtime layer uses to build the isolated process environment.
 * A connection without a valid ref/backend fails as RUNTIME_NOT_AVAILABLE —
 * it means the profile was never provisioned, which is infra, not auth.
 */
export function resolveRuntimeProfile(
  connection: RuntimeProfileConnectionRow,
): ResolvedRuntimeProfile {
  if (!isAIBackendKind(connection.backendKind) || connection.backendKind === "MANAGED_GATEWAY" || connection.backendKind === "LOCAL_BYOK") {
    throw new AIResolutionError(
      AI_RESOLUTION_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      `Connection ${connection.id} references unknown backendKind "${connection.backendKind}".`,
    );
  }
  if (!isRuntimeProfileRef(connection.runtimeProfileRef)) {
    throw new AIResolutionError(
      AI_RESOLUTION_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      `Connection ${connection.id} has no valid runtime profile.`,
    );
  }
  return {
    connectionId: connection.id,
    backendKind: connection.backendKind,
    runtimeProfileRef: connection.runtimeProfileRef,
  };
}
