import { PHASE3_MIGRATION_VERSION } from "@/lib/legacy-migration/identities";

export const AB_INSTANCE_SCOPE_KEY = "instance";
export const AB_MIGRATION_KEY = PHASE3_MIGRATION_VERSION;
export const AB_RUNTIME_FEATURE_ENV = "VOCATRYA_AB_RUNTIME_ENABLED";

export const AB_MIGRATION_STATUS = {
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type AbMigrationStatus =
  (typeof AB_MIGRATION_STATUS)[keyof typeof AB_MIGRATION_STATUS];

export const CAREER_RUNTIME_MODE = {
  LEGACY_ONLY: "LEGACY_ONLY",
  AB_READY_DISABLED: "AB_READY_DISABLED",
  AB_ENABLED: "AB_ENABLED",
  BLOCKED: "BLOCKED",
} as const;

export type CareerRuntimeMode =
  (typeof CAREER_RUNTIME_MODE)[keyof typeof CAREER_RUNTIME_MODE];

export const CAREER_WRITE_FAMILY = {
  legacy: "legacy",
  ab: "ab",
  blocked: "blocked",
} as const;

export type CareerWriteFamily =
  (typeof CAREER_WRITE_FAMILY)[keyof typeof CAREER_WRITE_FAMILY];

export const OPPORTUNITY_STATUS = {
  UNKNOWN: "UNKNOWN",
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
  EXPIRED: "EXPIRED",
} as const;

export const FORBIDDEN_OPPORTUNITY_STATUSES = [
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "APPLIED",
  "HIRED",
  "DECLINED",
] as const;

export const RESUME_VERSION_STATUS = {
  DRAFT: "DRAFT",
  FROZEN: "FROZEN",
  SUBMITTED: "SUBMITTED",
  ARCHIVED: "ARCHIVED",
} as const;

export const ATTEMPT_STAGE = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
} as const;

export const ATTEMPT_OUTCOME = {
  ACTIVE: "ACTIVE",
  WITHDRAWN: "WITHDRAWN",
  REJECTED: "REJECTED",
  OFFER: "OFFER",
  HIRED: "HIRED",
} as const;

export const CAREER_MATERIAL_TYPE = {
  EMPLOYMENT: "EMPLOYMENT",
  INTERNSHIP: "INTERNSHIP",
  PROJECT: "PROJECT",
  RESEARCH: "RESEARCH",
  PUBLICATION: "PUBLICATION",
  COMPETITION: "COMPETITION",
  CAMPUS_ACTIVITY: "CAMPUS_ACTIVITY",
  EDUCATION: "EDUCATION",
  AWARD: "AWARD",
  SKILL: "SKILL",
  CERTIFICATION: "CERTIFICATION",
  CUSTOM: "CUSTOM",
} as const;

export type CareerMaterialType =
  (typeof CAREER_MATERIAL_TYPE)[keyof typeof CAREER_MATERIAL_TYPE];
