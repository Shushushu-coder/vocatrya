/**
 * Deterministic Phase 3 migration identities.
 *
 * Idempotency is keyed by LegacyMigrationMap (legacy type + id + target type),
 * never by fuzzy matching of titles, dates, or content.
 */

export const PHASE3_MIGRATION_VERSION = "vocatrya-ab-phase3-legacy-backfill-v1";
export const PHASE3_CREATED_VIA = "LEGACY_BACKFILL";

/** Required by schema; not a claim that the application channel is known. */
export const UNSPECIFIED_CHANNEL_LABEL = "UNSPECIFIED";

export const LEGACY = {
  JOB: "Job",
  NOTE: "Note",
  RESUME: "Resume",
  WORK_EXPERIENCE: "WorkExperience",
  EDUCATION: "Education",
  LICENSE_OR_CERTIFICATION: "LicenseOrCertification",
  SKILL: "Skill",
  OTHER_SECTION: "OtherSection",
  USER_CONTACT_INFO: "UserContactInfo",
} as const;

export const TARGET = {
  JOB_OPPORTUNITY: "JobOpportunity",
  JOB_DESCRIPTION_VERSION: "JobDescriptionVersion",
  APPLICATION_ATTEMPT: "ApplicationAttempt",
  APPLICATION_PROCESS_STEP: "ApplicationProcessStep",
  JOB_OPPORTUNITY_NOTE: "JobOpportunityNote",
  RESUME_VARIANT: "ResumeVariant",
  RESUME_VARIANT_VERSION: "ResumeVariantVersion",
  CAREER_MATERIAL_ITEM: "CareerMaterialItem",
  CAREER_EVIDENCE: "CareerEvidence",
  CANDIDATE_PROFILE: "CandidateProfile",
  UNMAPPED_UNKNOWN_STATUS: "UNMAPPED_UNKNOWN_STATUS",
} as const;

/** Legacy alias persisted in older LegacyMigrationMap rows and v1/v2 backups. */
export const LEGACY_TARGET_ALIAS = {
  RESUME_CONTACT_PROFILE: "ResumeContactProfile",
} as const;

export function canonicalTargetEntityType(type: string): string {
  if (type === LEGACY_TARGET_ALIAS.RESUME_CONTACT_PROFILE) {
    return TARGET.CANDIDATE_PROFILE;
  }
  return type;
}

export function isCandidateProfileTarget(type: string): boolean {
  return (
    type === TARGET.CANDIDATE_PROFILE ||
    type === LEGACY_TARGET_ALIAS.RESUME_CONTACT_PROFILE
  );
}

export type LegacyEntityType = (typeof LEGACY)[keyof typeof LEGACY];
export type TargetEntityType = (typeof TARGET)[keyof typeof TARGET];
