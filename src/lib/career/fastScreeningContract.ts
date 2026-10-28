/**
 * Wire contract for the canonical minimal match chain (RM-MATCH,
 * FAST_SCREENING only). Shared between server actions and client
 * components — keep this module free of server-only imports.
 */

/** Material source the user picks on the job-detail match tab. */
export type FastScreeningSource =
  | { kind: "career-profile" }
  | { kind: "resume-version"; versionId: string };

export type FastScreeningResumeOption = {
  versionId: string;
  variantId: string;
  variantName: string;
  versionNumber: number;
  status: string;
};

export type FastScreeningAssignmentState =
  | { status: "RESOLVED"; provider: string; model: string }
  | { status: "NOT_CONFIGURED" }
  | { status: "INVALID_ASSIGNMENT"; code: string };

export type FastScreeningPreflight = {
  hasJobDescription: boolean;
  materialsCount: number;
  resumeVersions: FastScreeningResumeOption[];
  hasPreference: boolean;
  assignment: FastScreeningAssignmentState;
};

export type FastScreeningDetailDTO = {
  verdict: string;
  hardRequirements: string | null;
  coreMatch: string | null;
  preferenceMatch: string | null;
  reasons: string | null;
};

export type MatchAnalysisListItem = {
  id: string;
  analysisType: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  provider: string | null;
  model: string | null;
  isStale: boolean;
  staleReasonCodes: string[];
  fastScreeningDetail: FastScreeningDetailDTO | null;
};

/**
 * A run either persisted an analysis (`ok`) or failed before/during
 * execution (`failed` with a stable code — retryable by the user; nothing
 * partial is persisted on failure).
 */
export type FastScreeningRunResult =
  | { kind: "ok"; analysis: MatchAnalysisListItem }
  | { kind: "failed"; code: string; detail?: string | null };

export const FAST_SCREENING_ERROR_CODES = {
  JD_MISSING: "MATCH_JD_MISSING",
  INSUFFICIENT_MATERIAL: "MATCH_INSUFFICIENT_MATERIAL",
  NOT_CONFIGURED: "NOT_CONFIGURED",
} as const;
