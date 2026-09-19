import type { PrismaClient } from "@prisma/client";
import { isFullAbCapabilityEnabled, resolveAbRolloutScope } from "./capabilities";
import { CareerRuntimeError } from "./errors";
import {
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
} from "./identities";
import { resolveCareerRuntimeMode } from "./runtimeMode";

export async function assertAbWritesAllowed(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  if (resolved.mode !== CAREER_RUNTIME_MODE.AB_ENABLED) {
    throw new CareerRuntimeError(
      "AB_WRITES_NOT_ENABLED",
      `A+B writes require AB_ENABLED; current mode is ${resolved.mode} (${resolved.reason})`,
    );
  }
}

export async function assertLegacyCareerWriteAllowed(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  if (resolved.mode === CAREER_RUNTIME_MODE.BLOCKED) {
    throw new CareerRuntimeError(
      "CAREER_RUNTIME_BLOCKED",
      `Career writes are blocked: ${resolved.reason}`,
    );
  }
  if (resolved.mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) {
    throw new CareerRuntimeError(
      "LEGACY_WRITE_BLOCKED",
      "AB_READY_DISABLED: legacy Job/Resume writes would drift a ready A+B instance",
    );
  }
  if (
    resolved.mode === CAREER_RUNTIME_MODE.AB_ENABLED &&
    isFullAbCapabilityEnabled(
      resolved.mode,
      resolveAbRolloutScope(env ?? process.env),
    )
  ) {
    throw new CareerRuntimeError(
      "LEGACY_WRITE_BLOCKED",
      "AB_ENABLED: write Job/Resume through OpportunityService / ResumeVariantService, not legacy Prisma",
    );
  }
  if (resolved.writeFamily === CAREER_WRITE_FAMILY.blocked) {
    throw new CareerRuntimeError(
      "CAREER_RUNTIME_BLOCKED",
      `Career writes are blocked: ${resolved.reason}`,
    );
  }
}
