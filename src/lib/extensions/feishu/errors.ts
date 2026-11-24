// Stable machine-facing error codes for the Feishu extension. Anything the
// renderer or the model sees is one of these codes plus fixed copy — raw
// provider, fetch or SDK messages never cross the boundary because they can
// carry request context, remote text, or credentials.
export const FEISHU_ERROR = {
  NOT_CONNECTED: "FEISHU_NOT_CONNECTED",
  INVALID_CREDENTIALS: "FEISHU_INVALID_CREDENTIALS",
  REAUTH_REQUIRED: "FEISHU_REAUTH_REQUIRED",
  CREDENTIAL_UNAVAILABLE: "FEISHU_CREDENTIAL_UNAVAILABLE",
  TOOL_UNAVAILABLE: "FEISHU_TOOL_UNAVAILABLE",
  PERMISSION_DENIED: "FEISHU_PERMISSION_DENIED",
  RATE_LIMITED: "FEISHU_RATE_LIMITED",
  OBJECT_NOT_FOUND: "FEISHU_OBJECT_NOT_FOUND",
  // The target exists but is not a docx document the first version can
  // handle (legacy docs, sheets, bitable, files, wiki non-docx objects).
  UNSUPPORTED_TARGET: "FEISHU_UNSUPPORTED_TARGET",
  NETWORK: "FEISHU_NETWORK",
  OUTCOME_UNKNOWN: "FEISHU_OUTCOME_UNKNOWN",
  VERIFICATION_REQUIRED: "FEISHU_VERIFICATION_REQUIRED",
  VALIDATION_FAILED: "FEISHU_VALIDATION_FAILED",
  REMOTE_FAILED: "FEISHU_REMOTE_FAILED",
} as const;

export type FeishuErrorCode =
  (typeof FEISHU_ERROR)[keyof typeof FEISHU_ERROR];

export class FeishuError extends Error {
  readonly code: FeishuErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: FeishuErrorCode,
    options?: { retryable?: boolean; retryAfterMs?: number; message?: string },
  ) {
    super(options?.message ?? code);
    this.name = "FeishuError";
    this.code = code;
    this.retryable = options?.retryable === true;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function isFeishuError(error: unknown): error is FeishuError {
  return error instanceof FeishuError;
}
