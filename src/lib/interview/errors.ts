/**
 * Phase 2 interview adapter errors.
 *
 * Forward-compatible with the frozen Phase 1 domain codes. Adapter code
 * throws InterviewAdapterError so HTTP/server-action layers can map codes
 * onto Vocatrya conventions later without parsing message strings.
 */
export const INTERVIEW_ADAPTER_ERROR_CODES = {
  INTERVIEW_MODEL_NOT_CONFIGURED: "INTERVIEW_MODEL_NOT_CONFIGURED",
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  CROSS_USER_RELATION: "CROSS_USER_RELATION",
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  QUESTION_INVALID: "QUESTION_INVALID",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JD_NOT_FOUND: "JD_NOT_FOUND",
  JOB_PAIR_REQUIRED: "JOB_PAIR_REQUIRED",
  JOB_JD_MISMATCH: "JOB_JD_MISMATCH",
  INTERVIEW_SETTINGS_INVALID: "INTERVIEW_SETTINGS_INVALID",
} as const;

export type InterviewAdapterErrorCode =
  (typeof INTERVIEW_ADAPTER_ERROR_CODES)[keyof typeof INTERVIEW_ADAPTER_ERROR_CODES];

export class InterviewAdapterError extends Error {
  readonly code: InterviewAdapterErrorCode | string;

  constructor(code: InterviewAdapterErrorCode | string, message: string) {
    super(message);
    this.name = "InterviewAdapterError";
    this.code = code;
  }
}

export function isInterviewModelNotConfigured(error: unknown): boolean {
  return (
    error instanceof InterviewAdapterError &&
    error.code ===
      INTERVIEW_ADAPTER_ERROR_CODES.INTERVIEW_MODEL_NOT_CONFIGURED
  );
}
