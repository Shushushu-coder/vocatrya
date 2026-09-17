import type { PrismaClient } from "@prisma/client";
import { LEGACY, TARGET } from "@/lib/legacy-migration/identities";
import {
  AB_FRESH_DOMAIN_DELEGATES,
  LEGACY_FRESH_DOMAIN_DELEGATES,
  countFreshDelegate,
} from "./freshEligibility";

export type CareerDb = Pick<
  PrismaClient,
  | "job"
  | "resume"
  | "jobOpportunity"
  | "applicationAttempt"
  | "resumeVariant"
  | "careerMaterialItem"
  | "legacyMigrationMap"
>;

export type IntegrityResult = {
  ok: boolean;
  code: string | null;
  unmappedJobIds: string[];
  unmappedResumeIds: string[];
};

const PASS: IntegrityResult = {
  ok: true,
  code: null,
  unmappedJobIds: [],
  unmappedResumeIds: [],
};

function fail(
  code: string,
  extras: Partial<IntegrityResult> = {},
): IntegrityResult {
  return {
    ok: false,
    code,
    unmappedJobIds: [],
    unmappedResumeIds: [],
    ...extras,
  };
}

function hasDelegate(
  client: object,
  name: string,
): client is CareerDb {
  const delegate = (client as Record<string, { count?: unknown }>)[name];
  return typeof delegate?.count === "function";
}

export function canInspectAbDomain(client: object): boolean {
  return (
    hasDelegate(client, "job") &&
    hasDelegate(client, "resume") &&
    hasDelegate(client, "jobOpportunity") &&
    hasDelegate(client, "legacyMigrationMap")
  );
}

export async function hasAbDomainResidue(db: CareerDb): Promise<boolean> {
  const counts = await Promise.all([
    ...AB_FRESH_DOMAIN_DELEGATES.map((name) => countFreshDelegate(db, name)),
    db.legacyMigrationMap.count(),
    countFreshDelegate(db, "dataMigrationRun"),
  ]);
  return counts.some((count) => count > 0);
}

/**
 * Cheap coverage: every legacy Job/Resume root is accounted for by a Phase 3
 * mapping. Unknown-status jobs may map to UNMAPPED_UNKNOWN_STATUS instead of
 * JobOpportunity. This is not the Phase 2 auditor.
 */
export async function checkLegacyRootCoverage(
  db: CareerDb,
): Promise<IntegrityResult> {
  const [jobs, resumes, jobMaps, resumeMaps] = await Promise.all([
    db.job.findMany({ select: { id: true } }),
    db.resume.findMany({ select: { id: true } }),
    db.legacyMigrationMap.findMany({
      where: {
        legacyEntityType: LEGACY.JOB,
        targetEntityType: {
          in: [TARGET.JOB_OPPORTUNITY, TARGET.UNMAPPED_UNKNOWN_STATUS],
        },
      },
      select: { legacyEntityId: true },
    }),
    db.legacyMigrationMap.findMany({
      where: {
        legacyEntityType: LEGACY.RESUME,
        targetEntityType: TARGET.RESUME_VARIANT,
      },
      select: { legacyEntityId: true },
    }),
  ]);

  const mappedJobs = new Set(jobMaps.map((row) => row.legacyEntityId));
  const mappedResumes = new Set(resumeMaps.map((row) => row.legacyEntityId));
  const unmappedJobIds = jobs
    .map((row) => row.id)
    .filter((id) => !mappedJobs.has(id));
  const unmappedResumeIds = resumes
    .map((row) => row.id)
    .filter((id) => !mappedResumes.has(id));

  if (unmappedJobIds.length > 0) {
    return fail("UNMAPPED_LEGACY_JOBS", { unmappedJobIds, unmappedResumeIds });
  }
  if (unmappedResumeIds.length > 0) {
    return fail("UNMAPPED_LEGACY_RESUMES", { unmappedJobIds, unmappedResumeIds });
  }

  const opportunityMaps = await db.legacyMigrationMap.count({
    where: {
      legacyEntityType: LEGACY.JOB,
      targetEntityType: TARGET.JOB_OPPORTUNITY,
    },
  });
  if (opportunityMaps > 0) {
    const opportunities = await db.jobOpportunity.count();
    if (opportunities === 0) {
      return fail("ORPHAN_JOB_MAPPINGS");
    }
  }

  return { ...PASS, unmappedJobIds, unmappedResumeIds };
}

export async function checkNotStartedConsistency(
  db: CareerDb,
): Promise<IntegrityResult> {
  try {
    if (await hasAbDomainResidue(db)) {
      return fail("AB_ROWS_WITHOUT_MIGRATION");
    }
    return PASS;
  } catch {
    return fail("AB_SCHEMA_UNAVAILABLE");
  }
}

/**
 * Cheap fresh-native integrity. A FRESH_READY instance has no legacy source
 * to cover, so LegacyMigrationMap is a contradiction rather than a requirement.
 */
export async function checkFreshNativeIntegrity(
  db: PrismaClient | CareerDb,
): Promise<IntegrityResult> {
  try {
    const legacyEntries = await Promise.all(
      LEGACY_FRESH_DOMAIN_DELEGATES.map(
        async (name) => [name, await countFreshDelegate(db, name)] as const,
      ),
    );
    const legacyCounts = Object.fromEntries(legacyEntries);
    await Promise.all(
      AB_FRESH_DOMAIN_DELEGATES.map((name) => countFreshDelegate(db, name)),
    );
    const [maps, migrationRuns] = await Promise.all([
      countFreshDelegate(db, "legacyMigrationMap"),
      countFreshDelegate(db, "dataMigrationRun"),
    ]);

    if (maps > 0) {
      return fail("FRESH_HAS_MIGRATION_MAPS");
    }
    if (migrationRuns > 0) {
      return fail("FRESH_HAS_DATA_MIGRATION_RUNS");
    }
    if (legacyCounts.job > 0) {
      return fail("FRESH_HAS_LEGACY_JOBS");
    }
    if (legacyCounts.resume > 0) {
      return fail("FRESH_HAS_LEGACY_RESUMES");
    }
    if (
      Object.entries(legacyCounts).some(
        ([name, count]) => name !== "job" && name !== "resume" && count > 0,
      )
    ) {
      return fail("FRESH_HAS_LEGACY_CAREER_ROWS");
    }
    return PASS;
  } catch {
    return fail("AB_SCHEMA_UNAVAILABLE");
  }
}
