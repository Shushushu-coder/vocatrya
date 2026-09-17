import type { PrismaClient } from "@prisma/client";
import { isAbRuntimeFeatureEnabled } from "./featureGate";
import {
  AB_MIGRATION_STATUS,
  CAREER_RUNTIME_MODE,
  CAREER_WRITE_FAMILY,
  type CareerRuntimeMode,
  type CareerWriteFamily,
} from "./identities";
import {
  checkLegacyRootCoverage,
  checkNotStartedConsistency,
  type IntegrityResult,
} from "./integrity";
import { readInstanceMigrationState } from "./migrationState";

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

  // COMPLETED
  if (!state.verifiedAt) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: {
        ok: false,
        code: "MISSING_VERIFIED_AT",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "completed-unverified",
    });
  }

  const coverage = await checkLegacyRootCoverage(client);
  if (!coverage.ok) {
    return blocked({
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: coverage,
      reason: "integrity-failed",
    });
  }

  if (!featureEnabled) {
    return {
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
      writeFamily: CAREER_WRITE_FAMILY.legacy,
      featureEnabled,
      migrationStatus: state.status,
      verifiedAt: state.verifiedAt,
      integrity: coverage,
      reason: "feature-disabled",
    };
  }

  return {
    mode: CAREER_RUNTIME_MODE.AB_ENABLED,
    writeFamily: CAREER_WRITE_FAMILY.ab,
    featureEnabled,
    migrationStatus: state.status,
    verifiedAt: state.verifiedAt,
    integrity: coverage,
    reason: "gates-passed",
  };
}

export function careerWriteFamilyFor(
  mode: CareerRuntimeMode,
): CareerWriteFamily {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return CAREER_WRITE_FAMILY.ab;
  if (mode === CAREER_RUNTIME_MODE.BLOCKED) return CAREER_WRITE_FAMILY.blocked;
  return CAREER_WRITE_FAMILY.legacy;
}

export function careerReadFamilyFor(
  mode: CareerRuntimeMode,
): CareerWriteFamily {
  return careerWriteFamilyFor(mode);
}
