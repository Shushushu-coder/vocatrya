import type { PrismaClient } from "@prisma/client";
import {
  isResumeV1CapabilityEnabled,
  resolveAbRolloutScope,
  type AbRolloutScope,
} from "./capabilities";
import { CareerRuntimeError } from "./errors";
import { type CareerRuntimeMode } from "./identities";
import { resolveCareerRuntimeMode } from "./runtimeMode";

/**
 * Career domain access guard.
 *
 * This is the ONLY place allowed to interpret the runtime mode for
 * CandidateProfile / CandidateSensitiveInfo / CandidateFamilyMember /
 * CareerMaterial / JobSearchPreference / Application Profile aggregation.
 *
 * Matrix (locked):
 *   AB_ENABLED + resume_v1|full -> READ/COPY/WRITE YES
 *   AB_ENABLED + none           -> READ/COPY/WRITE NO
 *   AB_READY_DISABLED           -> READ/COPY/WRITE NO
 *   LEGACY_ONLY                 -> READ/COPY/WRITE NO
 *
 * COPY uses the READ gate. A separate canCopy/assert helper exists so tests
 * cover COPY independently without duplicating the matrix.
 *
 * Missing scope defaults to none (fail closed). Runtime mode remains the
 * integrity gate; rollout scope cannot enable data in LEGACY_ONLY /
 * AB_READY_DISABLED / BLOCKED.
 */

export function canReadCareerData(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope = "none",
): boolean {
  return isResumeV1CapabilityEnabled(mode, scope);
}

export function canWriteCareerData(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope = "none",
): boolean {
  return isResumeV1CapabilityEnabled(mode, scope);
}

export function canCopyCareerData(
  mode: CareerRuntimeMode | string,
  scope: AbRolloutScope = "none",
): boolean {
  return canReadCareerData(mode, scope);
}

export async function assertCareerDataReadable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (!canReadCareerData(resolved.mode, scope)) {
    throw new CareerRuntimeError(
      "CAREER_READ_NOT_ENABLED",
      `Career data is only readable when A+B is enabled; current mode is ${resolved.mode}`,
    );
  }
  return resolved.mode;
}

export async function assertCareerDataWritable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  const scope = resolveAbRolloutScope(env ?? process.env);
  if (!canWriteCareerData(resolved.mode, scope)) {
    throw new CareerRuntimeError(
      "CAREER_WRITE_NOT_ENABLED",
      `Career data is only writable when A+B is enabled; current mode is ${resolved.mode}`,
    );
  }
  return resolved.mode;
}

export async function assertCareerDataCopyable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  return assertCareerDataReadable(db, env);
}
