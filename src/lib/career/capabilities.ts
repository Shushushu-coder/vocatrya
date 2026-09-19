import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { CAREER_RUNTIME_MODE, type CareerRuntimeMode } from "./identities";
import {
  AB_ROLLOUT_SCOPE,
  resolveAbRolloutScope,
  type AbRolloutScope,
} from "./rolloutScope";
import { resolveCareerRuntimeMode } from "./runtimeMode";

export { AB_ROLLOUT_SCOPE, resolveAbRolloutScope };
export type { AbRolloutScope };

/**
 * Product capability layer. Runtime mode remains the data/migration
 * integrity gate. VOCATRYA_AB_ROLLOUT_SCOPE is parsed only in rolloutScope.ts.
 */

export function isResumeV1CapabilityEnabled(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope,
): boolean {
  return (
    mode === CAREER_RUNTIME_MODE.AB_ENABLED &&
    (scope === AB_ROLLOUT_SCOPE.resume_v1 || scope === AB_ROLLOUT_SCOPE.full)
  );
}

export function isFullAbCapabilityEnabled(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope,
): boolean {
  return (
    mode === CAREER_RUNTIME_MODE.AB_ENABLED && scope === AB_ROLLOUT_SCOPE.full
  );
}

export function isRestrictedResumeBindingSurfaceEnabled(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope,
): boolean {
  return (
    isResumeV1CapabilityEnabled(mode, scope) &&
    !isFullAbCapabilityEnabled(mode, scope)
  );
}

export function isLegacyResumeEditorReadOnly(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope,
): boolean {
  if (mode === CAREER_RUNTIME_MODE.LEGACY_ONLY) return false;
  if (
    mode === CAREER_RUNTIME_MODE.AB_ENABLED &&
    scope === AB_ROLLOUT_SCOPE.none
  ) {
    return false;
  }
  return true;
}

async function resolveModeAndScope(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<{ mode: CareerRuntimeMode; scope: AbRolloutScope; reason: string }> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  return {
    mode: resolved.mode,
    scope: resolveAbRolloutScope(env ?? process.env),
    reason: resolved.reason,
  };
}

export async function assertResumeV1Readable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const { mode } = await resolveModeAndScope(db, env);
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (!isResumeV1CapabilityEnabled(mode, scope)) {
    throw new CareerRuntimeError(
      "CAREER_READ_NOT_ENABLED",
      `Career data is only readable when A+B is enabled; current mode is ${mode}`,
    );
  }
  return mode;
}

export async function assertResumeV1Writable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const { mode, reason } = await resolveModeAndScope(db, env);
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (mode !== CAREER_RUNTIME_MODE.AB_ENABLED) {
    throw new CareerRuntimeError(
      "AB_WRITES_NOT_ENABLED",
      `A+B writes require AB_ENABLED; current mode is ${mode} (${reason})`,
    );
  }
  if (!isResumeV1CapabilityEnabled(mode, scope)) {
    throw new CareerRuntimeError(
      "CAREER_WRITE_NOT_ENABLED",
      `Career data is only writable when A+B is enabled; current mode is ${mode}`,
    );
  }
  return mode;
}

export async function assertFullAbReadable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const { mode } = await resolveModeAndScope(db, env);
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) return mode;
  if (!isFullAbCapabilityEnabled(mode, scope)) {
    throw new CareerRuntimeError(
      "APPLICATION_TIMELINE_UNAVAILABLE",
      `Application timeline is not available in ${mode}`,
    );
  }
  return mode;
}

export async function assertFullAbWritable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const { mode, reason } = await resolveModeAndScope(db, env);
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (mode !== CAREER_RUNTIME_MODE.AB_ENABLED) {
    throw new CareerRuntimeError(
      "AB_WRITES_NOT_ENABLED",
      `A+B writes require AB_ENABLED; current mode is ${mode} (${reason})`,
    );
  }
  if (!isFullAbCapabilityEnabled(mode, scope)) {
    throw new CareerRuntimeError(
      "AB_WRITES_NOT_ENABLED",
      `A+B writes require AB_ENABLED; current mode is ${mode} (${reason})`,
    );
  }
  return mode;
}
