import type { PrismaClient } from "@prisma/client";
import {
  isResumeV1CapabilityEnabled,
  type AbRolloutScope,
} from "./capabilities";
import { CareerRuntimeError } from "./errors";
import { CAREER_READ_DENIED_MESSAGE, CAREER_WRITE_DENIED_MESSAGE } from "./userMessages";
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
  if (!canReadCareerData(resolved.mode, resolved.rolloutScope)) {
    throw new CareerRuntimeError(
      "CAREER_READ_NOT_ENABLED",
      CAREER_READ_DENIED_MESSAGE,
    );
  }
  return resolved.mode;
}

export async function assertCareerDataWritable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  if (!canWriteCareerData(resolved.mode, resolved.rolloutScope)) {
    throw new CareerRuntimeError(
      "CAREER_WRITE_NOT_ENABLED",
      CAREER_WRITE_DENIED_MESSAGE,
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
