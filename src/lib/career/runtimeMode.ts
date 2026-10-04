import type { PrismaClient } from "@prisma/client";
import {
  isAbRuntimeFeatureEnabled,
  isAbRuntimeFeatureEnvPresent,
} from "./featureGate";
import {
  AB_ROLLOUT_SCOPE,
  isAbRolloutScopeEnvPresent,
  resolveAbRolloutScope,
  type AbRolloutScope,
} from "./rolloutScope";
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
  countMigrationStateRows,
  isKnownAbMigrationStatus,
  readInstanceMigrationState,
  type InstanceMigrationState,
} from "./migrationState";

export const CAREER_CONFIG_SOURCE = {
  explicitEnv: "explicit-env",
  freshDefault: "fresh-default",
  conservativeDefault: "conservative-default",
} as const;

export type CareerConfigSource =
  (typeof CAREER_CONFIG_SOURCE)[keyof typeof CAREER_CONFIG_SOURCE];

export type CareerRuntimeConfigSource = {
  feature: CareerConfigSource;
  scope: CareerConfigSource;
};

export const CAREER_DATA_ORIGIN = {
  fresh: "fresh",
  migrated: "migrated",
  legacy: "legacy",
  unknown: "unknown",
} as const;

export type CareerDataOrigin =
  (typeof CAREER_DATA_ORIGIN)[keyof typeof CAREER_DATA_ORIGIN];

export type CareerRuntimeResolution = {
  mode: CareerRuntimeMode;
  writeFamily: CareerWriteFamily;
  featureEnabled: boolean;
  migrationStatus: string;
  verifiedAt: Date | null;
  integrity: IntegrityResult;
  reason: string;
  rolloutScope: AbRolloutScope;
  configSource: CareerRuntimeConfigSource;
  origin: CareerDataOrigin;
};

export type EffectiveCareerRuntimeConfig = {
  featureEnabled: boolean;
  rolloutScope: AbRolloutScope;
  configSource: CareerRuntimeConfigSource;
};

const EMPTY_INTEGRITY: IntegrityResult = {
  ok: true,
  code: null,
  unmappedJobIds: [],
  unmappedResumeIds: [],
};

/**
 * State-aware effective config. Raw parsers stay environment-only.
 * A fresh default is granted only after the caller has proved a trusted
 * fresh identity. Explicit presence, including blank and invalid tokens,
 * always wins and fails closed through the raw parser.
 */
export function resolveEffectiveCareerRuntimeConfig(
  env: NodeJS.ProcessEnv,
  trustedFresh: boolean,
): EffectiveCareerRuntimeConfig {
  const featurePresent = isAbRuntimeFeatureEnvPresent(env);
  const scopePresent = isAbRolloutScopeEnvPresent(env);
  return {
    featureEnabled: featurePresent
      ? isAbRuntimeFeatureEnabled(env)
      : trustedFresh,
    rolloutScope: scopePresent
      ? resolveAbRolloutScope(env)
      : trustedFresh
        ? AB_ROLLOUT_SCOPE.full
        : AB_ROLLOUT_SCOPE.none,
    configSource: {
      feature: featurePresent
        ? CAREER_CONFIG_SOURCE.explicitEnv
        : trustedFresh
          ? CAREER_CONFIG_SOURCE.freshDefault
          : CAREER_CONFIG_SOURCE.conservativeDefault,
      scope: scopePresent
        ? CAREER_CONFIG_SOURCE.explicitEnv
        : trustedFresh
          ? CAREER_CONFIG_SOURCE.freshDefault
          : CAREER_CONFIG_SOURCE.conservativeDefault,
    },
  };
}

type ResolutionFields = Omit<CareerRuntimeResolution, "mode" | "writeFamily">;

function blocked(base: ResolutionFields): CareerRuntimeResolution {
  return {
    ...base,
    mode: CAREER_RUNTIME_MODE.BLOCKED,
    writeFamily: CAREER_WRITE_FAMILY.blocked,
  };
}

function legacy(base: ResolutionFields): CareerRuntimeResolution {
  return {
    ...base,
    mode: CAREER_RUNTIME_MODE.LEGACY_ONLY,
    writeFamily: CAREER_WRITE_FAMILY.legacy,
  };
}

function fields(input: {
  env: NodeJS.ProcessEnv;
  trustedFresh: boolean;
  state: InstanceMigrationState;
  integrity: IntegrityResult;
  reason: string;
  origin?: CareerDataOrigin;
}): ResolutionFields {
  const config = resolveEffectiveCareerRuntimeConfig(input.env, input.trustedFresh);
  return {
    ...config,
    migrationStatus: input.state.status,
    verifiedAt: input.state.verifiedAt,
    integrity: input.integrity,
    reason: input.reason,
    origin: input.origin ?? originForState(input.state),
  };
}

export type ResolveCareerRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
};

function originForState(state: InstanceMigrationState): CareerDataOrigin {
  if (
    state.id &&
    state.status === AB_MIGRATION_STATUS.FRESH_READY &&
    state.migrationKey === FRESH_NATIVE_KEY &&
    state.completedAt === null
  ) {
    return CAREER_DATA_ORIGIN.fresh;
  }
  if (
    state.id &&
    state.status === AB_MIGRATION_STATUS.COMPLETED &&
    state.migrationKey === AB_MIGRATION_KEY
  ) {
    return CAREER_DATA_ORIGIN.migrated;
  }
  if (!state.id || state.status === AB_MIGRATION_STATUS.NOT_STARTED) {
    return CAREER_DATA_ORIGIN.legacy;
  }
  return CAREER_DATA_ORIGIN.unknown;
}

function isFreshIdentity(state: InstanceMigrationState): boolean {
  return originForState(state) === CAREER_DATA_ORIGIN.fresh;
}

function hasRequiredReadyDelegates(client: object): boolean {
  const record = client as Record<string, { count?: unknown; findMany?: unknown; findUnique?: unknown }>;
  return (
    typeof record.abMigrationState?.findUnique === "function" &&
    typeof record.abMigrationState?.count === "function" &&
    typeof record.job?.count === "function" &&
    typeof record.resume?.count === "function" &&
    typeof record.jobOpportunity?.count === "function" &&
    typeof record.legacyMigrationMap?.findMany === "function" &&
    typeof record.legacyMigrationMap?.count === "function"
  );
}

export async function resolveCareerRuntimeMode(
  db: PrismaClient | object,
  options: ResolveCareerRuntimeOptions = {},
): Promise<CareerRuntimeResolution> {
  const env = options.env ?? process.env;
  const state = await readInstanceMigrationState(db);
  const origin = originForState(state);

  if (!hasRequiredReadyDelegates(db)) {
    const base = fields({
      env,
      trustedFresh: false,
      state,
      integrity: {
        ok: false,
        code: "AB_SCHEMA_UNAVAILABLE",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "prisma-client-missing-ab-delegates",
      origin,
    });
    if (state.id && state.status !== AB_MIGRATION_STATUS.NOT_STARTED) {
      return blocked(base);
    }
    return legacy({
      ...base,
      integrity: EMPTY_INTEGRITY,
    });
  }

  const cardinality = await countMigrationStateRows(db);

  if (
    state.status === AB_MIGRATION_STATUS.IN_PROGRESS ||
    state.status === AB_MIGRATION_STATUS.FAILED
  ) {
    return blocked(
      fields({
        env,
        trustedFresh: false,
        state,
        integrity: {
          ok: false,
          code:
            state.status === AB_MIGRATION_STATUS.FAILED
              ? "MIGRATION_FAILED"
              : "MIGRATION_IN_PROGRESS",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        },
        reason:
          state.status === AB_MIGRATION_STATUS.FAILED
            ? "migration-failed"
            : "migration-in-progress",
        origin,
      }),
    );
  }

  if (state.id && !isKnownAbMigrationStatus(state.status)) {
    return blocked(
      fields({
        env,
        trustedFresh: false,
        state,
        integrity: {
          ok: false,
          code: "UNRECOGNIZED_MIGRATION_STATUS",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        },
        reason: "unrecognized-migration-status",
        origin,
      }),
    );
  }

  if (isFreshIdentity(state) && cardinality !== 1) {
    return blocked(
      fields({
        env,
        trustedFresh: false,
        state,
        integrity: {
          ok: false,
          code: "MIGRATION_STATE_CARDINALITY",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        },
        reason: "migration-state-cardinality",
        origin,
      }),
    );
  }

  if (state.status === AB_MIGRATION_STATUS.NOT_STARTED) {
    const client = db as PrismaClient;
    const consistency = await checkNotStartedConsistency(client);
    if (!consistency.ok) {
      return blocked(
        fields({
          env,
          trustedFresh: false,
          state,
          integrity: consistency,
          reason: "partial-ab-residue",
          origin,
        }),
      );
    }
    const featureOn = isAbRuntimeFeatureEnvPresent(env) && isAbRuntimeFeatureEnabled(env);
    return legacy(
      fields({
        env,
        trustedFresh: false,
        state,
        integrity: consistency,
        reason: featureOn ? "feature-on-migration-incomplete" : "migration-not-started",
        origin,
      }),
    );
  }

  if (state.status === AB_MIGRATION_STATUS.FRESH_READY) {
    if (state.migrationKey !== FRESH_NATIVE_KEY || state.completedAt !== null) {
      return blockedForStateOrigin({ env, state, origin });
    }
    return resolveReadyState({
      client: db as PrismaClient,
      env,
      state,
      origin,
      integrity: await checkFreshNativeIntegrity(db as PrismaClient),
      unverifiedReason: "fresh-unverified",
      freshOrigin: true,
    });
  }

  if (state.status !== AB_MIGRATION_STATUS.COMPLETED) {
    return blocked(
      fields({
        env,
        trustedFresh: false,
        state,
        integrity: {
          ok: false,
          code: "UNRECOGNIZED_MIGRATION_STATUS",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        },
        reason: "unrecognized-migration-status",
        origin,
      }),
    );
  }

  if (state.migrationKey !== AB_MIGRATION_KEY || state.completedAt === null) {
    return blockedForStateOrigin({ env, state, origin });
  }

  return resolveReadyState({
    client: db as PrismaClient,
    env,
    state,
    origin,
    integrity: !state.verifiedAt
      ? {
          ok: false,
          code: "MISSING_VERIFIED_AT",
          unmappedJobIds: [],
          unmappedResumeIds: [],
        }
      : await checkLegacyRootCoverage(db as PrismaClient),
    unverifiedReason: "completed-unverified",
    freshOrigin: false,
  });
}

function blockedForStateOrigin(input: {
  env: NodeJS.ProcessEnv;
  state: InstanceMigrationState;
  origin: CareerDataOrigin;
}): CareerRuntimeResolution {
  return blocked(
    fields({
      env: input.env,
      trustedFresh: false,
      state: input.state,
      integrity: {
        ok: false,
        code: "MIGRATION_STATE_ORIGIN_MISMATCH",
        unmappedJobIds: [],
        unmappedResumeIds: [],
      },
      reason: "migration-state-origin-mismatch",
      origin: input.origin,
    }),
  );
}

const FRESH_POLLUTION_CODES = new Set([
  "FRESH_HAS_LEGACY_JOBS",
  "FRESH_HAS_LEGACY_RESUMES",
  "FRESH_HAS_LEGACY_CAREER_ROWS",
  "FRESH_HAS_MIGRATION_MAPS",
  "FRESH_HAS_DATA_MIGRATION_RUNS",
]);

const MIGRATED_FULL_CUTOVER_CODES = new Set([
  "UNMAPPED_LEGACY_JOBS",
  "UNMAPPED_LEGACY_RESUMES",
]);

async function resolveReadyState(input: {
  client: PrismaClient;
  env: NodeJS.ProcessEnv;
  state: InstanceMigrationState;
  origin: CareerDataOrigin;
  integrity: IntegrityResult;
  unverifiedReason: string;
  freshOrigin: boolean;
}): Promise<CareerRuntimeResolution> {
  const { state, origin, freshOrigin } = input;
  let integrity = input.integrity;

  if (!state.verifiedAt) {
    integrity = {
      ok: false,
      code: "MISSING_VERIFIED_AT",
      unmappedJobIds: [],
      unmappedResumeIds: [],
    };
    return blocked(
      fields({
        env: input.env,
        trustedFresh: false,
        state,
        integrity,
        reason: input.unverifiedReason,
        origin,
      }),
    );
  }

  const trustedFresh = freshOrigin && integrity.ok;
  const configFields = fields({
    env: input.env,
    trustedFresh,
    state,
    integrity,
    reason: "pending",
    origin,
  });

  if (!integrity.ok) {
    const code = integrity.code ?? "";
    const migratedPartial =
      !freshOrigin &&
      MIGRATED_FULL_CUTOVER_CODES.has(code) &&
      configFields.rolloutScope !== AB_ROLLOUT_SCOPE.full;
    const freshPollution = freshOrigin && FRESH_POLLUTION_CODES.has(code);
    if (freshPollution || !migratedPartial) {
      return blocked({
        ...configFields,
        integrity,
        reason: "integrity-failed",
      });
    }
  }

  if (!configFields.featureEnabled) {
    return {
      ...configFields,
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
      writeFamily: CAREER_WRITE_FAMILY.blocked,
      reason: "feature-disabled",
    };
  }

  if (freshOrigin && configFields.rolloutScope === AB_ROLLOUT_SCOPE.none) {
    return {
      ...configFields,
      mode: CAREER_RUNTIME_MODE.AB_READY_DISABLED,
      writeFamily: CAREER_WRITE_FAMILY.blocked,
      reason: "rollout-scope-disabled",
    };
  }

  return {
    ...configFields,
    mode: CAREER_RUNTIME_MODE.AB_ENABLED,
    writeFamily: CAREER_WRITE_FAMILY.ab,
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
