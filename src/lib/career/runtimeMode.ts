import type { PrismaClient } from "@prisma/client";
import { isAbRuntimeFeatureEnabled } from "./featureGate";
import {
  AB_MIGRATION_STATUS,
  AB_MIGRATION_KEY,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  FRESH_NATIVE_KEY,
  type CareerRuntimeMode,
  type CareerWriteFamily,
} from "./identities";
import {
  checkFreshNativeIntegrity,
  checkLegacyRootCoverage,
  checkNotStartedConsistency,
  type IntegrityResult,
} from "./integrity";
import {
  isKnownAbMigrationStatus,
  readInstanceMigrationState,
} from "./migrationState";

export type CareerRuntimeResolution = {
  mode: CareerRuntimeMode;
  writeFamily: CareerWriteFamily;
  featureEnabled: boolean;
  migrationStatus: string;
  verifiedAt: Date | null;
  integrity: IntegrityResult;
  reason: string;
};

function blocked(
  base: Omit<CareerRuntimeResolution, "mode" | "writeFamily">,
): CareerRuntimeResolution {
  return {
    ...base,
    mode: CAREER_RUNTIME_MODE.BLOCKED,
    writeFamily: CAREER_WRITE_FAMILY.blocked,
  };
}

function legacy(
  base: Omit<CareerRuntimeResolution, "mode" | "writeFamily">,
): CareerRuntimeResolution {
  return {
    ...base,
    mode: CAREER_RUNTIME_MODE.LEGACY_ONLY,
    writeFamily: CAREER_WRITE_FAMILY.legacy,
  };
}

export type ResolveCareerRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
};

export async function resolveCareerRuntimeMode(
  db: PrismaClient | object,
  options: ResolveCareerRuntimeOptions = {},
): Promise<CareerRuntimeResolution> {
  const featureEnabled = isAbRuntimeFeatureEnabled(options.env ?? process.env);
  const state = await readInstanceMigrationState(db);

  const inspectable =
    typeof (db as { abMigrationState?: { findUnique?: unknown } }).abMigrationState
      ?.findUnique === "function" &&
    typeof (db as { jobOpportunity?: { count?: unknown } }).jobOpportunity?.count ===
      "function" &&
    typeof (db as { legacyMigrationMap?: { findMany?: unknown } }).legacyMigrationMap
      ?.findMany === "function";

  if (!inspectable) {
    return legacy({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: {
        ok: true,
        code: null,
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "prisma-client-missing-ab-delegates",
    });
  }

  const client = db as PrismaClient;

  if (
    state.status === AB_MIGRATION_STATUS.IN_PROGRESS ||
    state.status === AB_MIGRATION_STATUS.FAILED
  ) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: {
        ok: false,
        code: state.status === AB_MIGRATION_STATUS.FAILED ? "MIGRATION_FAILED" : "MIGRATION_IN_PROGRESS",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason:
        state.status === AB_MIGRATION_STATUS.FAILED
          ? "migration-failed"
          : "migration-in-progress",
    });
  }

  if (
    state.id &&
    !isKnownAbMigrationStatus(state.status)
  ) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: {
        ok: false,
        code: "UNRECOGNIZED_MIGRATION_STATUS",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "unrecognized-migration-status",
    });
  }

  if (state.status === AB_MIGRATION_STATUS.NOT_STARTED) {
    const consistency = await checkNotStartedConsistency(client);
    if (!consistency.ok) {
      return blocked({
        featureEnabled,
        migrationStatus: state.status,
        verifiedAt: state.verifiedAt,
        integrity: consistency,
        reason: "partial-ab-residue",
      });
    }
    return legacy({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: consistency,
      reason: featureEnabled ? "feature-on-migration-incomplete" : "migration-not-started",
    });
  }

  if (state.status === AB_MIGRATION_STATUS.FRESH_READY) {
    if (state.migrationKey !== FRESH_NATIVE_KEY || state.completedAt !== null) {
      return blockedForStateOrigin({
        featureEnabled,
        state,
      });
    }
    return resolveReadyState({
      client,
      featureEnabled,
      state,
      integrity: await checkFreshNativeIntegrity(client),
      unverifiedReason: "fresh-unverified",
    });
  }

  // COMPLETED — Phase 3 legacy migration only.
  if (state.status !== AB_MIGRATION_STATUS.COMPLETED) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: {
        ok: false,
        code: "UNRECOGNIZED_MIGRATION_STATUS",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "unrecognized-migration-status",
    });
  }

  if (state.migrationKey !== AB_MIGRATION_KEY || state.completedAt === null) {
    return blockedForStateOrigin({
      featureEnabled,
      state,
    });
  }

  return resolveReadyState({
    client,
    featureEnabled,
    state,
    integrity: !state.verifiedAt
      ? {
          ok: false,
          code: "MISSING_VERIFIED_AT",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        }
      : await checkLegacyRootCoverage(client),
    unverifiedReason: "completed-unverified",
  });
}

function blockedForStateOrigin(input: {
  featureEnabled: boolean;
  state: Awaited<ReturnType<typeof readInstanceMigrationState>>;
}): CareerRuntimeResolution {
  const { featureEnabled, state } = input;
  return blocked({
    featureEnabled,
    migrationStatus: state.status,
    verifiedAt: state.verifiedAt,
    integrity: {
      ok: false,
      code: "MIGRATION_STATE_ORIGIN_MISMATCH",
      unmappedJobIds: [],
      unmappedResumeIds: [],
    },
    reason: "migration-state-origin-mismatch",
  });
}

async function resolveReadyState(input: {
  client: PrismaClient;
  featureEnabled: boolean;
  state: Awaited<ReturnType<typeof readInstanceMigrationState>>;
  integrity: IntegrityResult;
  unverifiedReason: string;
}): Promise<CareerRuntimeResolution> {
  const { featureEnabled, state, unverifiedReason } = input;
  let integrity = input.integrity;

  if (!state.verifiedAt) {
    integrity = {
      ok: false,
      code: "MISSING_VERIFIED_AT",
      unmappedJobIds: [],
      unmappedResumeIds: [],
    };
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity,
      reason: unverifiedReason,
    });
  }

  if (!integrity.ok) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity,
      reason: "integrity-failed",
    });
  }

  if (!featureEnabled) {
    return {
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
      writeFamily: CAREER_WRITE_FAMILY.blocked,
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity,
      reason: "feature-disabled",
    };
  }

  return {
    mode: CAREER_RUNTIME_MODE.AB_ENABLED,
    writeFamily: CAREER_WRITE_FAMILY.ab,
    featureEnabled,
    migrationStatus: state.status,
    verifiedAt: state.verifiedAt,
    integrity,
    reason: "gates-passed",
  };
}

export function careerWriteFamilyFor(
  mode: CareerRuntimeMode,
): CareerWriteFamily {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return CAREER_WRITE_FAMILY.ab;
  if (
    mode === CAREER_RUNTIME_MODE.BLOCKED ||
    mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED
  ) {
    return CAREER_WRITE_FAMILY.blocked;
  }
  return CAREER_WRITE_FAMILY.legacy;
}

export function careerReadFamilyFor(
  mode: CareerRuntimeMode,
): CareerWriteFamily {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return CAREER_WRITE_FAMILY.ab;
  if (mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) {
    return CAREER_WRITE_FAMILY.ab;
  }
  if (mode === CAREER_RUNTIME_MODE.BLOCKED) return CAREER_WRITE_FAMILY.blocked;
  return CAREER_WRITE_FAMILY.legacy;
}
