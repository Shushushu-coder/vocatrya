import { DomainError } from "./persistence/interviewErrors";

export const PRODUCT_ERROR_CODES = [
  "INTERVIEW_MODEL_NOT_CONFIGURED",
  "SESSION_NOT_FOUND",
  "SESSION_FORBIDDEN",
  "SESSION_ARCHIVED",
  "QUESTION_NOT_FOUND",
  "JOB_NOT_FOUND",
  "JD_NOT_FOUND",
  "JOB_JD_MISMATCH",
  "JOB_PAIR_REQUIRED",
  "CROSS_USER_RELATION",
  "GENERATION_FAILED",
  "INVALID_TRANSCRIPT_EVIDENCE",
  "INVALID_FEEDBACK_ITEM",
  "EMPTY_ITEMS",
  "INVALID_SUMMARY_OUTPUT",
  "SUMMARY_NOT_READY",
  "INVALID_DIALOGUE_TARGET",
  "INVALID_DIALOGUE_TEXT",
  "INVALID_TEXT",
  "USER_NOT_FOUND",
  "QUESTION_BANK_VERSION_CONFLICT",
  "PRESET_INVALID",
  "PRESET_DUPLICATE",
  "NO_ACTIVE_REVISION",
  "INVALID_INPUT_REVISION",
  "ATTEMPT_NOT_FOUND",
  "QUESTION_NOT_READY",
  "INVALID_QUESTION_PLAN",
  "INVALID_QUESTIONS",
  "FEEDBACK_ITEM_NOT_FOUND",
  "SUMMARY_NOT_FOUND",
  // AI assignment / account-runtime failures (stable business taxonomy).
  "AI_NOT_CONFIGURED",
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "REAUTH_REQUIRED",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "RUNTIME_NOT_AVAILABLE",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "MODEL_UNAVAILABLE",
  "RUNTIME_NOT_INSTALLED",
  "RUNTIME_BROKEN",
  "PERMISSION_BOUNDARY_NOT_READY",
  "AI_EXECUTION_TIMEOUT",
  "AI_EXECUTION_FAILED",
  "AI_REQUEST_TOO_LARGE",
  "BACKEND_UNAVAILABLE",
] as const;

export type ProductErrorCode = (typeof PRODUCT_ERROR_CODES)[number];

const PRODUCT_MESSAGES: Record<string, string> = {
  INTERVIEW_MODEL_NOT_CONFIGURED: "需要先配置 Interview AI 提供商和模型。",
  SESSION_NOT_FOUND: "面试会话不存在。",
  SESSION_FORBIDDEN: "无法访问该面试会话。",
  SESSION_ARCHIVED: "已归档的面试会话只读。",
  QUESTION_NOT_FOUND: "题目不存在。",
  JOB_NOT_FOUND: "岗位不存在。",
  JD_NOT_FOUND: "职位描述版本不存在。",
  JOB_JD_MISMATCH: "职位描述不属于所选岗位。",
  JOB_PAIR_REQUIRED: "岗位与职位描述必须同时选择或同时留空。",
  CROSS_USER_RELATION: "不能绑定其他用户的岗位或题目。",
  GENERATION_FAILED: "生成失败，请重试。",
  INVALID_TRANSCRIPT_EVIDENCE: "反馈证据无法对应到回答原文。",
  INVALID_FEEDBACK_ITEM: "模型返回的反馈结构无效。",
  EMPTY_ITEMS: "模型没有生成可用反馈。",
  INVALID_SUMMARY_OUTPUT: "总结内容无效。",
  SUMMARY_NOT_READY: "还不能生成总结：需要已完成的回答和反馈。",
  INVALID_DIALOGUE_TARGET: "追问目标无效。",
  INVALID_DIALOGUE_TEXT: "请输入追问内容。",
  INVALID_TEXT: "请输入回答内容。",
  USER_NOT_FOUND: "用户不存在。",
  QUESTION_BANK_VERSION_CONFLICT: "系统题库元数据冲突，安装已中止。",
  PRESET_INVALID: "题库预设无效。",
  PRESET_DUPLICATE: "题库预设存在重复项。",
  NO_ACTIVE_REVISION: "当前回答没有可用的文本版本。",
  INVALID_INPUT_REVISION: "文本版本不属于该回答。",
  ATTEMPT_NOT_FOUND: "回答不存在。",
  QUESTION_NOT_READY: "需要先完成当前题目的回答和反馈。",
  INVALID_QUESTION_PLAN: "面试问题生成结果无效。",
  INVALID_QUESTIONS: "面试问题无效。",
  FEEDBACK_ITEM_NOT_FOUND: "反馈项不存在。",
  SUMMARY_NOT_FOUND: "面试总结不存在。",
  AI_NOT_CONFIGURED: "需要先配置 Interview AI 提供商和模型。",
  ASSIGNED_CONNECTION_UNAVAILABLE: "分配的 AI 连接不可用或已归档。",
  REAUTH_REQUIRED: "分配的 AI 连接需要重新认证。",
  CONNECTION_DISCONNECTED: "分配的 AI 连接已断开。",
  CONNECTION_ERROR: "分配的 AI 连接处于错误状态。",
  RUNTIME_NOT_AVAILABLE: "分配的 AI 连接没有可用的运行时。",
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION: "该提供商不支持此运行时。",
  MODEL_UNAVAILABLE: "模型不可用或未配置。",
  RUNTIME_NOT_INSTALLED: "对应的运行时未安装。",
  RUNTIME_BROKEN: "对应的运行时不可用。",
  PERMISSION_BOUNDARY_NOT_READY: "运行时权限边界未就绪。",
  AI_EXECUTION_TIMEOUT: "AI 执行超时，请重试。",
  AI_EXECUTION_FAILED: "AI 执行失败，请重试。",
  AI_REQUEST_TOO_LARGE: "请求内容过大。",
  BACKEND_UNAVAILABLE: "桌面运行时通道不可达。",
};

function isSecretLike(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("authorization") ||
    lower.includes("sk-") ||
    lower.includes("prisma") ||
    lower.includes("sqlite") ||
    lower.includes("sql")
  );
}

export type InterviewActionFailure = {
  success: false;
  code: string;
  message: string;
};

export type InterviewActionResult<T> =
  | { success: true; data: T }
  | InterviewActionFailure;

export function mapInterviewError(error: unknown): InterviewActionFailure {
  const code =
    error instanceof DomainError
      ? error.code
      : typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code)
        : "GENERATION_FAILED";
  const mapped = PRODUCT_ERROR_CODES.includes(code as ProductErrorCode)
    ? code
    : "GENERATION_FAILED";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message =
    PRODUCT_MESSAGES[mapped] ??
    (isSecretLike(rawMessage) ? PRODUCT_MESSAGES.GENERATION_FAILED : rawMessage);
  return { success: false, code: mapped, message };
}
