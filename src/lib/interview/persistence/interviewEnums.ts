/**
 * Phase 3B — Frozen Interview domain enums (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/domain/enums.ts
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 * SPEC_TAG: interview-vocatrya-spec-v1
 * SPEC_COMMIT: a7a8e2ed75e3797c207851f62e3a13732d405f6d
 *
 * IMPORT_REWRITE only: no field renames, no nullability changes,
 * no status-semantics changes. Host-specific storage mapping lives in
 * vocatryaInterviewPersistence.ts, never here.
 */
export const SESSION_STATUSES = [
  "DRAFT",
  "IN_PROGRESS",
  "COACHING",
  "COMPLETED",
  "ARCHIVED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const COACHING_MODES = ["PRACTICE", "MOCK"] as const;
export type CoachingMode = (typeof COACHING_MODES)[number];

export const FEEDBACK_RELEASE_POLICIES = ["IMMEDIATE", "ON_SESSION_COMPLETE"] as const;
export type FeedbackReleasePolicy = (typeof FEEDBACK_RELEASE_POLICIES)[number];

export const DEFAULT_FEEDBACK_RELEASE_POLICY: Record<CoachingMode, FeedbackReleasePolicy> = {
  PRACTICE: "IMMEDIATE",
  MOCK: "ON_SESSION_COMPLETE",
};

export const QUESTION_SOURCE_KINDS = [
  "USER_PROVIDED",
  "QUESTION_BANK",
  "AI_GENERATED",
  "TEMPLATE",
] as const;
export type QuestionSourceKind = (typeof QUESTION_SOURCE_KINDS)[number];

export const QUESTION_INSTANCE_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "ANSWERED",
  "SKIPPED",
] as const;
export type QuestionInstanceStatus = (typeof QUESTION_INSTANCE_STATUSES)[number];

export const ANSWER_INPUT_TYPES = ["TEXT", "AUDIO"] as const;
export type AnswerInputType = (typeof ANSWER_INPUT_TYPES)[number];

export const ANSWER_ATTEMPT_STATUSES = [
  "STARTED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "DISCARDED",
] as const;
export type AnswerAttemptStatus = (typeof ANSWER_ATTEMPT_STATUSES)[number];

export const ARTIFACT_ROLES = ["SOURCE", "NORMALIZED"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const REVISION_KINDS = ["ORIGINAL_ASR", "ORIGINAL_TEXT", "USER_CORRECTED"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const ALIGNMENT_STATUSES = [
  "PRESERVED",
  "PARTIAL",
  "DROPPED",
  "NOT_APPLICABLE",
] as const;
export type AlignmentStatus = (typeof ALIGNMENT_STATUSES)[number];

export const GENERATION_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const DIALOGUE_TARGET_TYPES = [
  "SESSION",
  "QUESTION_INSTANCE",
  "ANSWER_ATTEMPT",
  "FEEDBACK_ITEM",
  "SESSION_SUMMARY",
] as const;
export type DialogueTargetType = (typeof DIALOGUE_TARGET_TYPES)[number];

export const CONVERSATION_STATUSES = ["OPEN", "CLOSED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const FEEDBACK_PROMPT_VERSION = "commercial_feedback_v1";
export const SUMMARY_PROMPT_VERSION = "commercial_summary_v1";
export const COACHING_PROMPT_VERSION = "commercial_coaching_v1";
export const DEFAULT_KNOWLEDGE_VERSION = "v1.0";
