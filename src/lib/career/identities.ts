import { PHASE3_MIGRATION_VERSION } from "../legacy-migration/identities";

export const AB_INSTANCE_SCOPE_KEY = "instance";
export const AB_MIGRATION_KEY = PHASE3_MIGRATION_VERSION;
export const FRESH_NATIVE_KEY = "vocatrya-ab-fresh-native-v1";
export const AB_RUNTIME_FEATURE_ENV = "VOCATRYA_AB_RUNTIME_ENABLED";
export const AB_ROLLOUT_SCOPE_ENV = "VOCATRYA_AB_ROLLOUT_SCOPE";

export const AB_MIGRATION_STATUS = {
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  // Fresh instance explicitly initialized for A+B. This is not Phase 3
  // legacy-backfill completion and must never be written as COMPLETED.
  FRESH_READY: "FRESH_READY",
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
  SCREENING: "SCREENING",
  ASSESSMENT: "ASSESSMENT",
  INTERVIEW: "INTERVIEW",
  OFFER: "OFFER",
  CLOSED: "CLOSED",
} as const;

export const ATTEMPT_OUTCOME = {
  ACTIVE: "ACTIVE",
  WITHDRAWN: "WITHDRAWN",
  REJECTED: "REJECTED",
  OFFER: "OFFER",
  HIRED: "HIRED",
  TRANSFERRED: "TRANSFERRED",
} as const;

export type AttemptOutcome =
  (typeof ATTEMPT_OUTCOME)[keyof typeof ATTEMPT_OUTCOME];

export const TERMINAL_ATTEMPT_OUTCOMES = new Set<string>([
  ATTEMPT_OUTCOME.WITHDRAWN,
  ATTEMPT_OUTCOME.REJECTED,
  ATTEMPT_OUTCOME.HIRED,
  ATTEMPT_OUTCOME.TRANSFERRED,
]);

export function isTerminalAttemptOutcome(outcome: string): boolean {
  return TERMINAL_ATTEMPT_OUTCOMES.has(outcome);
}

export const PROCESS_STEP_STATUS = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

export type ProcessStepStatus =
  (typeof PROCESS_STEP_STATUS)[keyof typeof PROCESS_STEP_STATUS];

export const PROCESS_STEP_SOURCE = {
  USER: "USER",
  SYSTEM: "SYSTEM",
  IMPORT: "IMPORT",
  AUTOMATION: "AUTOMATION",
} as const;

export type ProcessStepSource =
  (typeof PROCESS_STEP_SOURCE)[keyof typeof PROCESS_STEP_SOURCE];

export const PROCESS_STEP_CATEGORY = {
  SCREENING: "SCREENING",
  ASSESSMENT: "ASSESSMENT",
  INTERVIEW: "INTERVIEW",
  OFFER: "OFFER",
  ONBOARDING: "ONBOARDING",
  OTHER: "OTHER",
} as const;

export type ProcessStepCategory =
  (typeof PROCESS_STEP_CATEGORY)[keyof typeof PROCESS_STEP_CATEGORY];

export const PROCESS_STEP_CATEGORIES = new Set<string>(
  Object.values(PROCESS_STEP_CATEGORY),
);

export const COMPATIBILITY_PROCESS_STEPS = {
  INTERVIEW: {
    category: ATTEMPT_STAGE.INTERVIEW,
    label: "Interview",
    sortOrder: 20,
  },
  OFFER: {
    category: ATTEMPT_STAGE.OFFER,
    label: "Offer",
    sortOrder: 30,
  },
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
  LANGUAGE: "LANGUAGE",
  CUSTOM: "CUSTOM",
} as const;

export type CareerMaterialType =
  (typeof CAREER_MATERIAL_TYPE)[keyof typeof CAREER_MATERIAL_TYPE];

export const EVIDENCE_STATUS = {
  UNLINKED: "UNLINKED",
  LINKED: "LINKED",
} as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUS)[keyof typeof EVIDENCE_STATUS];

export const MATCH_ANALYSIS_TYPE = {
  FAST_SCREENING: "FAST_SCREENING",
  DEEP_MATCH: "DEEP_MATCH",
} as const;

export type MatchAnalysisType =
  (typeof MATCH_ANALYSIS_TYPE)[keyof typeof MATCH_ANALYSIS_TYPE];

export const MATCH_ANALYSIS_STATUS = {
  COMPLETED: "COMPLETED",
} as const;

export const MATCH_ANALYSIS_SCHEMA_VERSION = "1";

export const MATCH_STALE_REASON = {
  JD_CHANGED: "JD_CHANGED",
  CAREER_MATERIAL_CHANGED: "CAREER_MATERIAL_CHANGED",
  PREFERENCE_CHANGED: "PREFERENCE_CHANGED",
  RESUME_VERSION_CHANGED: "RESUME_VERSION_CHANGED",
} as const;
