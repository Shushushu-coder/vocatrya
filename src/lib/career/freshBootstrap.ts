import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { activateFreshAbNative } from "./freshActivation";
import { checkFreshAbEligibility } from "./freshEligibility";
import {
  AB_MIGRATION_STATUS,
  FRESH_NATIVE_KEY,
} from "./identities";
import {
  countMigrationStateRows,
  readInstanceMigrationState,
  type InstanceMigrationState,
} from "./migrationState";

export const FRESH_NATIVE_BOOTSTRAP_RESULT = {
  ACTIVATED: "ACTIVATED",
  ALREADY_FRESH_READY: "ALREADY_FRESH_READY",
  SKIPPED_MIGRATED_INSTANCE: "SKIPPED_MIGRATED_INSTANCE",
  SKIPPED_LEGACY_DATA: "SKIPPED_LEGACY_DATA",
  SKIPPED_NOT_ELIGIBLE: "SKIPPED_NOT_ELIGIBLE",
} as const;

export type FreshNativeBootstrapResult =
  (typeof FRESH_NATIVE_BOOTSTRAP_RESULT)[keyof typeof FRESH_NATIVE_BOOTSTRAP_RESULT];

export type FreshNativeBootstrapOutcome = {
  result: FreshNativeBootstrapResult;
  mutated: boolean;
};

export function isValidFreshReadyState(state: InstanceMigrationState): boolean {
  return (
    Boolean(state.id) &&
    state.status === AB_MIGRATION_STATUS.FRESH_READY &&
    state.migrationKey === FRESH_NATIVE_KEY &&
    state.verifiedAt !== null &&
    state.completedAt === null
  );
}

/**
 * Startup log line. Legacy skips use the same not-eligible line: the
 * outcome code stays specific, and the log stays free of row contents.
 */
export function freshNativeActivationLogLine(
  result: FreshNativeBootstrapResult,
): string {
  switch (result) {
    case FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED:
      return "fresh-native activation: activated";
    case FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY:
      return "fresh-native activation: already-ready";
    case FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_MIGRATED_INSTANCE:
      return "fresh-native activation: skipped-migrated";
    case FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_LEGACY_DATA:
    case FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE:
      return "fresh-native activation: skipped-not-eligible";
    default:
      return "fresh-native activation: failed";
  }
}

function hasLegacyDomainBlocker(blockers: readonly string[]): boolean {
  return blockers.some((blocker) => blocker.startsWith("LEGACY_DOMAIN:"));
}

async function readValidFreshReady(
  db: PrismaClient | object,
): Promise<boolean> {
  const current = await readInstanceMigrationState(db);
  if (!isValidFreshReadyState(current)) return false;
  const rows = await countMigrationStateRows(db);
  return rows === null || rows === 1;
}

/**
 * Idempotent fresh-native bootstrap for a database the application already
 * opened. Does not accept a filesystem path, does not delete rows, and does
 * not repair or rewrite an existing migration state.
 *
 * Eligibility and the FRESH_READY write stay in checkFreshAbEligibility and
 * activateFreshAbNative. A failed activation throws so startup can fail
 * closed. An ineligible database is left untouched.
 */
export async function ensureFreshNativeState(
  db: PrismaClient | object,
): Promise<FreshNativeBootstrapOutcome> {
  const state = await readInstanceMigrationState(db);

  if (isValidFreshReadyState(state)) {
    const rows = await countMigrationStateRows(db);
    if (rows !== null && rows !== 1) {
      return {
        result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE,
        mutated: false,
      };
    }
    return {
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
      mutated: false,
    };
  }

  if (state.id && state.status === AB_MIGRATION_STATUS.COMPLETED) {
    return {
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_MIGRATED_INSTANCE,
      mutated: false,
    };
  }

  const notStarted =
    !state.id || state.status === AB_MIGRATION_STATUS.NOT_STARTED;
  if (!notStarted) {
    return {
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE,
      mutated: false,
    };
  }

  const eligibility = await checkFreshAbEligibility(db);
  if (eligibility.alreadyFreshReady) {
    return {
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
      mutated: false,
    };
  }
  if (!eligibility.eligible) {
    if (await readValidFreshReady(db)) {
      return {
        result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
        mutated: false,
      };
    }
    return {
      result: hasLegacyDomainBlocker(eligibility.blockers)
        ? FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_LEGACY_DATA
        : FRESH_NATIVE_BOOTSTRAP_RESULT.SKIPPED_NOT_ELIGIBLE,
      mutated: false,
    };
  }

  let activation;
  try {
    activation = await activateFreshAbNative(db as PrismaClient);
  } catch (error) {
    let recovered = false;
    try {
      recovered = await readValidFreshReady(db);
    } catch {
      recovered = false;
    }
    if (recovered) {
      return {
        result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
        mutated: false,
      };
    }
    throw error;
  }
  const persisted = await readInstanceMigrationState(db);
  if (!isValidFreshReadyState(persisted)) {
    throw new CareerRuntimeError(
      "FRESH_ACTIVATION_VERIFY_FAILED",
      "FRESH_READY state did not persist",
    );
  }

  if (activation.idempotent) {
    return {
      result: FRESH_NATIVE_BOOTSTRAP_RESULT.ALREADY_FRESH_READY,
      mutated: false,
    };
  }
  return {
    result: FRESH_NATIVE_BOOTSTRAP_RESULT.ACTIVATED,
    mutated: true,
  };
}
