/**
 * Phase 3B — Frozen Interview domain errors (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/errors/index.ts
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 * SPEC_TAG: interview-vocatrya-spec-v1
 * SPEC_COMMIT: a7a8e2ed75e3797c207851f62e3a13732d405f6d
 *
 * IMPORT_REWRITE only: error codes, classes and semantics are frozen.
 * Cross-user / not-found / mismatch codes must stay distinct; repository
 * error mapping must use these codes verbatim.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Session not found", code = "SESSION_NOT_FOUND") {
    super(code, message);
    this.name = "NotFoundError";
  }
}

export class OwnershipError extends DomainError {
  constructor(message = "Session is not owned by the current user") {
    super("SESSION_FORBIDDEN", message);
    this.name = "OwnershipError";
  }
}

export class ArchivedSessionError extends DomainError {
  constructor(message = "Archived sessions are read-only") {
    super("SESSION_ARCHIVED", message);
    this.name = "ArchivedSessionError";
  }
}

export class SummaryNotReadyError extends DomainError {
  constructor(message = "Session summary is not ready") {
    super("SUMMARY_NOT_READY", message);
    this.name = "SummaryNotReadyError";
  }
}

export const ErrorCodes = {
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_ARCHIVED: "SESSION_ARCHIVED",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  INVALID_COACHING_MODE: "INVALID_COACHING_MODE",
  INVALID_QUESTIONS: "INVALID_QUESTIONS",
  INVALID_SOURCE_KIND: "INVALID_SOURCE_KIND",
  INVALID_FEEDBACK_RELEASE_POLICY: "INVALID_FEEDBACK_RELEASE_POLICY",
  INVALID_INPUT_TYPE: "INVALID_INPUT_TYPE",
  INVALID_TEXT: "INVALID_TEXT",
  INVALID_AUDIO: "INVALID_AUDIO",
  INVALID_PROMPT: "INVALID_PROMPT",
  INVALID_REVISION_KIND: "INVALID_REVISION_KIND",
  INVALID_ALIGNMENT_STATUS: "INVALID_ALIGNMENT_STATUS",
  NO_ACTIVE_REVISION: "NO_ACTIVE_REVISION",
  INVALID_INPUT_REVISION: "INVALID_INPUT_REVISION",
  TRANSCRIPT_EXISTS: "TRANSCRIPT_EXISTS",
  ORIGINAL_REVISION_EXISTS: "ORIGINAL_REVISION_EXISTS",
  ORIGINAL_REVISION_MISSING: "ORIGINAL_REVISION_MISSING",
  INTERVIEW_MODEL_NOT_CONFIGURED: "INTERVIEW_MODEL_NOT_CONFIGURED",
  EMPTY_ITEMS: "EMPTY_ITEMS",
  INVALID_FEEDBACK_ITEM: "INVALID_FEEDBACK_ITEM",
  GENERATION_FAILED: "GENERATION_FAILED",
  SUMMARY_NOT_READY: "SUMMARY_NOT_READY",
  SUMMARY_PROVIDER_MISSING: "SUMMARY_PROVIDER_MISSING",
  INVALID_SUMMARY_OUTPUT: "INVALID_SUMMARY_OUTPUT",
  INVALID_DIALOGUE_TARGET: "INVALID_DIALOGUE_TARGET",
  INVALID_TARGET_TYPE: "INVALID_TARGET_TYPE",
  INVALID_DIALOGUE_TEXT: "INVALID_DIALOGUE_TEXT",
  JOB_JD_MISMATCH: "JOB_JD_MISMATCH",
  JOB_PAIR_REQUIRED: "JOB_PAIR_REQUIRED",
  CROSS_USER_RELATION: "CROSS_USER_RELATION",
  STALE_PENDING: "STALE_PENDING",
  INVALID_STALE_THRESHOLD: "INVALID_STALE_THRESHOLD",
  PRESET_INVALID: "PRESET_INVALID",
  PRESET_DUPLICATE: "PRESET_DUPLICATE",
  ATTEMPT_CONFLICT: "ATTEMPT_CONFLICT",
  FEEDBACK_ITEM_NOT_COMMERCIAL: "FEEDBACK_ITEM_NOT_COMMERCIAL",
} as const;
