import type { PrismaClient } from "@prisma/client";
import { isFullAbCapabilityEnabled } from "./capabilities";
import { CareerRuntimeError } from "./errors";
import {
  CAREER_LEGACY_EDITOR_UNAVAILABLE_MESSAGE,
  CAREER_WRITE_DENIED_MESSAGE,
  careerMutationDeniedMessage,
} from "./userMessages";
import {
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
} from "./identities";
import { CAREER_DATA_ORIGIN, resolveCareerRuntimeMode } from "./runtimeMode";

export async function assertAbWritesAllowed(
  db: PrismaClient | object,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const resolved = await resolveCareerRuntimeMode(db, { env });
  if (resolved.mode !== CAREER_RUNTIME_MODE.AB_ENABLED) {
    throw new CareerRuntimeError(
      "AB_WRITES_NOT_ENABLED",
      careerMutationDeniedMessage(resolved.mode),
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
      careerMutationDeniedMessage(resolved.mode),
    );
  }
  if (resolved.origin === CAREER_DATA_ORIGIN.fresh) {
    throw new CareerRuntimeError(
      "LEGACY_WRITE_BLOCKED",
      CAREER_LEGACY_EDITOR_UNAVAILABLE_MESSAGE,
    );
  }
  if (resolved.mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) {
    throw new CareerRuntimeError(
      "LEGACY_WRITE_BLOCKED",
      careerMutationDeniedMessage(resolved.mode),
    );
  }
  if (
    resolved.mode === CAREER_RUNTIME_MODE.AB_ENABLED &&
    isFullAbCapabilityEnabled(resolved.mode, resolved.rolloutScope)
  ) {
    throw new CareerRuntimeError(
      "LEGACY_WRITE_BLOCKED",
      CAREER_WRITE_DENIED_MESSAGE,
    );
  }
  if (resolved.writeFamily === CAREER_WRITE_FAMILY.blocked) {
    throw new CareerRuntimeError(
      "CAREER_RUNTIME_BLOCKED",
      careerMutationDeniedMessage(resolved.mode),
    );
  }
}
