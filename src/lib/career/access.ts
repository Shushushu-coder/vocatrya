import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { CAREER_RUNTIME_MODE, type CareerRuntimeMode } from "./identities";
import { resolveCareerRuntimeMode } from "./runtimeMode";

/**
 * Career domain access guard.
 *
 * This is the ONLY place allowed to interpret the runtime mode for
 * CandidateProfile / CandidateSensitiveInfo / CandidateFamilyMember /
 * CareerMaterial / JobSearchPreference / Application Profile aggregation.
 *
 * Matrix (locked):
 *   AB_ENABLED        -> READ/COPY/WRITE YES
 *   AB_READY_DISABLED -> READ/COPY/WRITE NO
 *   LEGACY_ONLY       -> READ/COPY/WRITE NO
 *
 * COPY uses the READ gate. A separate canCopy/assert helper exists so tests
 * cover COPY independently without duplicating the matrix.
 *
 * The底层 `assertAbWritesAllowed` stays as defense-in-depth inside services
 * and is never bypassed by this guard.
 */

export function canReadCareerData(mode: CareerRuntimeMode | string): boolean {
  return mode === CAREER_RUNTIME_MODE.AB_ENABLED;
}

export function canWriteCareerData(mode: CareerRuntimeMode | string): boolean {
  return mode === CAREER_RUNTIME_MODE.AB_ENABLED;
}

export function canCopyCareerData(mode: CareerRuntimeMode | string): boolean {
  return canReadCareerData(mode);
}

export async function assertCareerDataReadable(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<CareerRuntimeMode> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  if (!canReadCareerData(resolved.mode)) {
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
  if (!canWriteCareerData(resolved.mode)) {
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
