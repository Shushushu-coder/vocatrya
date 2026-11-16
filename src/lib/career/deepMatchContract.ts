/**
 * Wire contract for the durable deep-match task surface. Shared between
 * server actions and client components — keep this module free of
 * server-only imports.
 */

export type DeepMatchTaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "CANCELLING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/** Pinned-source summary resolved for display — null fields mean the
 *  referenced row is gone, never that the task switched inputs. */
export type DeepMatchTaskSource = {
  jobOpportunityId: string;
  jobDescriptionVersionId: string;
  jdVersionNumber: number | null;
  resumeVariantVersionId: string;
  resumeVariantName: string | null;
  resumeVersionNumber: number | null;
};

export type DeepMatchTaskDTO = {
  id: string;
  status: DeepMatchTaskStatus;
  /** Server step key while RUNNING — the UI localizes it, never shows raw. */
  currentStep: string | null;
  /** True when the current claim is a recovery (claimEpoch > 1). */
  recovered: boolean;
  attemptCount: number;
  /** Set once a cancel request landed; the task is CANCELLING until the
   *  runner finishes in-flight work — never earlier. */
  cancelRequested: boolean;
  failureCode: string | null;
  /** True when failureCode names a pinned input that is gone — the UI
   *  offers "start a new analysis" instead of retry. */
  inputLost: boolean;
  resultAnalysisId: string | null;
  jobOpportunityId: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  source: DeepMatchTaskSource | null;
};

export type DeepMatchDetailDTO = {
  overallSummary: string;
  overallScore: number | null;
  hardRequirements: string | null;
  responsibilityAlignment: string | null;
  experienceRelevance: string | null;
  skillCoverage: string | null;
  educationExperienceFit: string | null;
  strengths: string | null;
  gaps: string | null;
  resumeOptimizationOpportunities: string | null;
  nonFixableGaps: string | null;
};

export type DeepMatchAnalysisItem = {
  id: string;
  createdAt: Date;
  completedAt: Date | null;
  provider: string | null;
  model: string | null;
  isStale: boolean;
  staleReasonCodes: string[];
  deepMatchDetail: DeepMatchDetailDTO | null;
  /** Bound task id when the analysis came from the harness task path. */
  taskId: string | null;
  source: {
    jdVersionNumber: number | null;
    resumeVariantVersionId: string | null;
    resumeVariantName: string | null;
    resumeVersionNumber: number | null;
  } | null;
};

/** Codes the start action returns before a task exists — the request was
 *  validated and refused, nothing is running. */
export const DEEP_MATCH_START_ERROR_CODES = {
  OPPORTUNITY_NOT_FOUND: "OPPORTUNITY_NOT_FOUND",
  OPPORTUNITY_ARCHIVED: "OPPORTUNITY_ARCHIVED",
  JD_MISSING: "MATCH_JD_MISSING",
  RESUME_VERSION_MISSING: "DEEP_RESUME_VERSION_MISSING",
  RESUME_NOT_SUBMITTABLE: "RESUME_VERSION_NOT_SUBMITTABLE",
  INSUFFICIENT_MATERIAL: "MATCH_INSUFFICIENT_MATERIAL",
  REQUEST_CONFLICT: "DEEP_MATCH_REQUEST_CONFLICT",
} as const;
