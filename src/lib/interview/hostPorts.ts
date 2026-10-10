/**
 * Phase 3B — Frozen Host Port v0 interfaces (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/ports/*
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 * SPEC_TAG: interview-vocatrya-spec-v1
 * SPEC_COMMIT: a7a8e2ed75e3797c207851f62e3a13732d405f6d
 *
 * IMPORT_REWRITE only: import paths rewritten to Vocatrya layout.
 * No field renames, no error-code changes, no nullability changes.
 * Prisma / ORM / SDK internals must never leak through these interfaces.
 * Actual Vocatrya implementations live in ../vocatryaHostPorts.ts.
 */
import type { QuestionSourceKind } from "./persistence/interviewEnums";

export const HOST_PORT_CONTRACT_VERSION = "v0" as const;
export type HostPortContractVersion = typeof HOST_PORT_CONTRACT_VERSION;

export type UserId = string;

/** Minimal session ownership view an adapter must be able to load. */
export interface SessionOwnershipView {
  sessionId: string;
  ownerUserId: string;
  /** True when status === ARCHIVED or archivedAt is set. */
  isArchived: boolean;
}

export const OWNERSHIP_ERRORS = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  SESSION_ARCHIVED: "SESSION_ARCHIVED",
  CROSS_USER_RELATION: "CROSS_USER_RELATION",
  USER_NOT_FOUND: "USER_NOT_FOUND",
} as const;

export type OwnershipErrorCode =
  (typeof OWNERSHIP_ERRORS)[keyof typeof OWNERSHIP_ERRORS];

/** Host capability: load the ownership view for one session. */
export interface UserOwnershipPort {
  loadSessionOwnership(sessionId: string): Promise<SessionOwnershipView | null>;
}

export function assertOwnershipView(
  view: SessionOwnershipView | null,
  requestingUserId: string,
): asserts view is SessionOwnershipView {
  if (!requestingUserId) {
    const error = new Error("userId is required") as Error & { code: string };
    error.code = OWNERSHIP_ERRORS.SESSION_FORBIDDEN;
    throw error;
  }
  if (!view) {
    const error = new Error("Session not found") as Error & { code: string };
    error.code = OWNERSHIP_ERRORS.SESSION_NOT_FOUND;
    throw error;
  }
  if (view.ownerUserId !== requestingUserId) {
    const error = new Error("Session is not owned by the current user") as Error & {
      code: string;
    };
    error.code = OWNERSHIP_ERRORS.SESSION_FORBIDDEN;
    throw error;
  }
}

export function assertWritableView(view: SessionOwnershipView): void {
  if (view.isArchived) {
    const error = new Error("Archived sessions are read-only") as Error & {
      code: string;
    };
    error.code = OWNERSHIP_ERRORS.SESSION_ARCHIVED;
    throw error;
  }
}

export function assertSameUserId(ownerUserId: string, actorUserId: string): void {
  if (ownerUserId !== actorUserId) {
    const error = new Error("Cross-user relation rejected") as Error & {
      code: string;
    };
    error.code = OWNERSHIP_ERRORS.CROSS_USER_RELATION;
    throw error;
  }
}

/** Caller-provided question spec for session creation (domain input). */
export interface CommercialQuestionSpec {
  displayedText: string;
  sourceKind?: QuestionSourceKind;
  category?: string | null;
  sourceQuestionId?: string | null;
  referenceAnswerSnapshot?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
}

export interface InterviewQuestionSnapshot {
  sourceQuestionId: string;
  referenceAnswerSnapshot: string | null;
}

export const QUESTION_PORT_ERRORS = {
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  INVALID_QUESTIONS: "INVALID_QUESTIONS",
  INVALID_SOURCE_KIND: "INVALID_SOURCE_KIND",
} as const;

export type QuestionPortErrorCode =
  (typeof QUESTION_PORT_ERRORS)[keyof typeof QUESTION_PORT_ERRORS];

export interface QuestionPort {
  resolveSnapshot(input: {
    sourceQuestionId: string;
    requestingUserId: string;
  }): Promise<InterviewQuestionSnapshot>;
}

export interface JobContextInput {
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
}

export interface ResolvedJobContext {
  jobOpportunityId: string | null;
  jobDescriptionVersionId: string | null;
}

export const JOB_CONTEXT_ERRORS = {
  JOB_PAIR_REQUIRED: "JOB_PAIR_REQUIRED",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JD_NOT_FOUND: "JD_NOT_FOUND",
  JOB_JD_MISMATCH: "JOB_JD_MISMATCH",
  CROSS_USER_RELATION: "CROSS_USER_RELATION",
} as const;

export type JobContextErrorCode =
  (typeof JOB_CONTEXT_ERRORS)[keyof typeof JOB_CONTEXT_ERRORS];

export interface JobContextPort {
  resolveJobContext(input: {
    requestingUserId: string;
    jobOpportunityId?: string | null;
    jobDescriptionVersionId?: string | null;
  }): Promise<ResolvedJobContext>;
}

export interface GenerateJsonInput {
  system: string;
  prompt: string;
}

/**
 * Durable invocation identity (M4). The caller names the business
 * operation (operationId) and its attempt index; the adapter forwards them
 * verbatim to the execution seam so a retried business operation replays
 * instead of double-billing. Optional — models that cannot honour
 * identity may ignore it.
 */
export interface InterviewInvocationIdentity {
  operationId: string;
  attemptIndex?: number;
}

export interface ResolvedInterviewModel {
  provider: string;
  model: string;
  generateJson(
    input: GenerateJsonInput,
    operation?: InterviewInvocationIdentity,
  ): Promise<unknown>;
}

export const INTERVIEW_MODEL_ERRORS = {
  INTERVIEW_MODEL_NOT_CONFIGURED: "INTERVIEW_MODEL_NOT_CONFIGURED",
  GENERATION_FAILED: "GENERATION_FAILED",
} as const;

export type InterviewModelErrorCode =
  (typeof INTERVIEW_MODEL_ERRORS)[keyof typeof INTERVIEW_MODEL_ERRORS];

/**
 * Creation-time runtime plan, as resolved once by
 * resolveInterviewAiRuntime(). Declared structurally so the frozen port
 * surface does not import the assignment module.
 */
export interface InterviewCreationPlanRef {
  kind: "account" | "managed" | "legacy" | "invalid" | "unconfigured";
  connectionId?: string;
  model?: string;
  provider?: string;
  /** Encoded managedAiProvenanceV1 — present only for kind "managed". */
  managedAiProvenance?: string;
  /** The resource identity the Managed binding was issued for. */
  resourceKey?: string;
}

export interface InterviewModelPort {
  resolveInterviewModel(input: {
    requestingUserId: string;
    /**
     * Vocatrya extension (assignment migration): the session the model is
     * resolved for. When the session carries a persisted AI lock the
     * adapter must honour it; absent means legacy live resolution.
     */
    sessionId?: string;
  }): Promise<ResolvedInterviewModel>;
  /**
   * Vocatrya extension (product flow): resolve a model bound to the
   * creation-time plan — before the session row exists. The returned
   * model executes on exactly the connection/model pair the session lock
   * will persist. Optional: injected test doubles may rely on the
   * resolveInterviewModel fallback.
   */
  resolveInterviewModelForPlan?(input: {
    requestingUserId: string;
    plan: InterviewCreationPlanRef;
  }): Promise<ResolvedInterviewModel>;
}

export const PERSISTENCE_ERRORS = {
  SESSION_ARCHIVED: "SESSION_ARCHIVED",
  TRANSCRIPT_EXISTS: "TRANSCRIPT_EXISTS",
  ORIGINAL_REVISION_EXISTS: "ORIGINAL_REVISION_EXISTS",
  ORIGINAL_REVISION_MISSING: "ORIGINAL_REVISION_MISSING",
  NO_ACTIVE_REVISION: "NO_ACTIVE_REVISION",
  INVALID_INPUT_REVISION: "INVALID_INPUT_REVISION",
  SUMMARY_NOT_READY: "SUMMARY_NOT_READY",
  STALE_PENDING: "STALE_PENDING",
  INVALID_STALE_THRESHOLD: "INVALID_STALE_THRESHOLD",
} as const;

export type PersistenceErrorCode =
  (typeof PERSISTENCE_ERRORS)[keyof typeof PERSISTENCE_ERRORS];

export interface AtomicSessionCreationBehaviour {
  readonly kind: "AtomicSessionCreation";
}

export interface AttemptNumberingBehaviour {
  readonly kind: "AttemptNumbering";
}

export interface ImmutableTranscriptHistoryBehaviour {
  readonly kind: "ImmutableTranscriptHistory";
}

export interface AtomicFeedbackPromotionBehaviour {
  readonly kind: "AtomicFeedbackPromotion";
}

export interface GuardedSummaryPromotionBehaviour {
  readonly kind: "GuardedSummaryPromotion";
}

export interface CoachingTurnPersistenceBehaviour {
  readonly kind: "CoachingTurnPersistence";
}

export interface ArchiveAndRecoveryBehaviour {
  readonly kind: "ArchiveAndRecovery";
}

export type PersistenceBehaviours =
  | AtomicSessionCreationBehaviour
  | AttemptNumberingBehaviour
  | ImmutableTranscriptHistoryBehaviour
  | AtomicFeedbackPromotionBehaviour
  | GuardedSummaryPromotionBehaviour
  | CoachingTurnPersistenceBehaviour
  | ArchiveAndRecoveryBehaviour;
