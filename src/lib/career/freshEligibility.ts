import type { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  FRESH_NATIVE_KEY,
} from "./identities";
import { readInstanceMigrationState } from "./migrationState";

export type FreshCountMap = Record<string, number>;

export type FreshAbEligibility = {
  eligible: boolean;
  alreadyFreshReady: boolean;
  legacyDomainRowCounts: FreshCountMap;
  abDomainRowCounts: FreshCountMap;
  migrationBookkeepingCounts: FreshCountMap;
  blockers: string[];
};

export const LEGACY_FRESH_DOMAIN_DELEGATES = [
  "job",
  "resume",
  "workExperience",
  "education",
  "skill",
  "licenseOrCertification",
  "resumeSection",
  "contactInfo",
  "summary",
  "otherSection",
  "interview",
  "jobContact",
  "coverLetter",
  "note",
] as const;

export const AB_FRESH_DOMAIN_DELEGATES = [
  "recruitmentCampaign",
  "jobOpportunity",
  "applicationAttempt",
  "applicationProcessStep",
  "jobDescriptionVersion",
  "jobOpportunityNote",
  "jobSearchPreference",
  "resumeContactProfile",
  "careerMaterialItem",
  "resumeVariant",
  "matchAnalysis",
] as const;

export async function countFreshDelegate(
  db: object,
  name: string,
): Promise<number> {
  const delegate = (db as Record<string, { count?: () => Promise<number> }>)[
    name
  ];
  if (typeof delegate?.count !== "function") {
    throw new Error(`missing-delegate:${name}`);
  }
  return delegate.count();
}

async function countAll(
  db: object,
  names: readonly string[],
): Promise<FreshCountMap> {
  const entries = await Promise.all(
    names.map(async (name) => [name, await countFreshDelegate(db, name)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Prove the instance has no career/application domain data that would need
 * Phase 3 migration. Auth/bootstrap rows (User, JobStatus, JobSource,
 * ContactRole, empty Company/JobTitle/Location catalogs) are allowed.
 */
export async function checkFreshAbEligibility(
  db: PrismaClient | object,
): Promise<FreshAbEligibility> {
  const blockers: string[] = [];
  const state = await readInstanceMigrationState(db);

  let legacyDomainRowCounts: FreshCountMap = {};
  let abDomainRowCounts: FreshCountMap = {};
  let migrationBookkeepingCounts: FreshCountMap = {
    LegacyMigrationMap: 0,
    DataMigrationRun: 0,
    AbMigrationState: state.id ? 1 : 0,
  };

  try {
    legacyDomainRowCounts = await countAll(db, LEGACY_FRESH_DOMAIN_DELEGATES);
    abDomainRowCounts = await countAll(db, AB_FRESH_DOMAIN_DELEGATES);
    migrationBookkeepingCounts = {
      LegacyMigrationMap: await countFreshDelegate(db, "legacyMigrationMap"),
      DataMigrationRun: await countFreshDelegate(db, "dataMigrationRun"),
      AbMigrationState: await countFreshDelegate(db, "abMigrationState"),
    };
  } catch (error) {
    blockers.push(
      error instanceof Error && error.message.startsWith("missing-delegate:")
        ? `SCHEMA_UNAVAILABLE:${error.message.slice("missing-delegate:".length)}`
        : "SCHEMA_UNAVAILABLE",
    );
    return {
      eligible: false,
      alreadyFreshReady: false,
      legacyDomainRowCounts,
      abDomainRowCounts,
      migrationBookkeepingCounts,
      blockers,
    };
  }

  const alreadyFreshReady =
    state.status === AB_MIGRATION_STATUS.FRESH_READY &&
    state.migrationKey === FRESH_NATIVE_KEY &&
    state.verifiedAt !== null &&
    state.completedAt === null &&
    migrationBookkeepingCounts.AbMigrationState === 1;

  if (migrationBookkeepingCounts.AbMigrationState > (state.id ? 1 : 0)) {
    blockers.push(
      `UNEXPECTED_MIGRATION_STATE_ROWS=${migrationBookkeepingCounts.AbMigrationState}`,
    );
  }

  if (state.status === AB_MIGRATION_STATUS.FRESH_READY && !alreadyFreshReady) {
    if (state.migrationKey !== FRESH_NATIVE_KEY) {
      blockers.push("FRESH_STATE_KEY_MISMATCH");
    }
    if (!state.verifiedAt) {
      blockers.push("FRESH_STATE_UNVERIFIED");
    }
    if (state.completedAt) {
      blockers.push("FRESH_STATE_HAS_COMPLETED_AT");
    }
  } else if (
    state.status === AB_MIGRATION_STATUS.IN_PROGRESS ||
    state.status === AB_MIGRATION_STATUS.FAILED
  ) {
    blockers.push(`MIGRATION_${state.status}`);
  } else if (state.status === AB_MIGRATION_STATUS.COMPLETED) {
    blockers.push("PHASE3_COMPLETED");
  } else if (
    state.id &&
    state.status !== AB_MIGRATION_STATUS.NOT_STARTED &&
    state.status !== AB_MIGRATION_STATUS.FRESH_READY
  ) {
    blockers.push(`UNKNOWN_STATE:${state.status}`);
  }

  for (const [name, count] of Object.entries(legacyDomainRowCounts)) {
    if (count > 0) {
      blockers.push(`LEGACY_DOMAIN:${name}=${count}`);
    }
  }

  if (migrationBookkeepingCounts.LegacyMigrationMap > 0) {
    blockers.push(
      `MIGRATION_MAPS=${migrationBookkeepingCounts.LegacyMigrationMap}`,
    );
  }
  if (migrationBookkeepingCounts.DataMigrationRun > 0) {
    blockers.push(
      `DATA_MIGRATION_RUNS=${migrationBookkeepingCounts.DataMigrationRun}`,
    );
  }

  const abTotal = Object.values(abDomainRowCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (abTotal > 0 && !alreadyFreshReady) {
    blockers.push("AB_DATA_WITHOUT_RECOGNIZED_STATE");
  }

  return {
    eligible: blockers.length === 0,
    alreadyFreshReady,
    legacyDomainRowCounts,
    abDomainRowCounts,
    migrationBookkeepingCounts,
    blockers,
  };
}
