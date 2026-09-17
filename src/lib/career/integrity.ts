import type { PrismaClient } from "@prisma/client";
import { LEGACY, TARGET } from "@/lib/legacy-migration/identities";

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
  const [opps, attempts, variants, materials, maps] = await Promise.all([
    db.jobOpportunity.count(),
    db.applicationAttempt.count(),
    db.resumeVariant.count(),
    db.careerMaterialItem.count(),
    db.legacyMigrationMap.count(),
  ]);
  return opps + attempts + variants + materials + maps > 0;
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
  if (await hasAbDomainResidue(db)) {
    return fail("AB_ROWS_WITHOUT_MIGRATION");
  }
  return PASS;
}
