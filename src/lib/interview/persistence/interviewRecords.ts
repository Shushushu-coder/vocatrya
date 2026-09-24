/**
 * Phase 3B — Frozen Interview domain records (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/domain/records.ts
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 * SPEC_TAG: interview-vocatrya-spec-v1
 * SPEC_COMMIT: a7a8e2ed75e3797c207851f62e3a13732d405f6d
 *
 * Plain TypeScript DTOs mirroring the interview tables without importing
 * `@prisma/client`. Production services depend ONLY on these shapes plus
 * Host Port v0. The Vocatrya Prisma adapter maps these to/from Prisma rows.
 * IMPORT_REWRITE only: field semantics (nullable, enums, error codes)
 * follow Host Port v0. No ORM, no Prisma types, no stub metadata.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  status: string;
  coachingMode: string;
  feedbackReleasePolicy: string;
  feedbackReleasedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  statusBeforeArchive: string | null;
  knowledgeBaseVersion: string;
  currentQuestionInstanceId: string | null;
  jobOpportunityId: string | null;
  jobDescriptionVersionId: string | null;
  createdVia: string | null;
  // Vocatrya extension (assignment migration): AI lock captured once at
  // creation. Account sessions hold connectionId + model; legacy-locked
  // sessions keep connectionId null and carry an encoded provider/model
  // envelope in resolvedModel; historical sessions stay null/null.
  resolvedConnectionId?: string | null;
  resolvedModel?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface QuestionInstanceRecord {
  id: string;
  sessionId: string;
  sourceQuestionId: string | null;
  displayOrder: number;
  displayedText: string;
  sourceKind: string;
  category: string | null;
  sourceMetadata: string | null;
  referenceAnswerSnapshot: string | null;
  status: string;
}

export interface AnswerAttemptRecord {
  id: string;
  questionInstanceId: string;
  sessionId: string;
  attemptNumber: number;
  inputType: string;
  status: string;
  startedAt: Date | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  activeRevisionId: string | null;
  deletedAt: Date | null;
}

export interface AnswerInputArtifactRecord {
  id: string;
  answerAttemptId: string;
  sessionId: string;
  inputType: string;
  role: string;
  filePath: string | null;
  fileFormat: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  textContent: string | null;
}

export interface TranscriptRecord {
  id: string;
  sessionId: string;
  answerAttemptId: string;
  sourceArtifactId: string | null;
  fullText: string;
  segments: string;
  asrModel: string | null;
  asrStatus: string | null;
}

export interface TranscriptRevisionRecord {
  id: string;
  transcriptId: string;
  answerAttemptId: string;
  revisionNumber: number;
  revisionKind: string;
  fullText: string;
  segments: string | null;
  alignmentStatus: string;
  contentHash: string;
  createdByUserId: string | null;
  createdVia: string | null;
}

export interface FeedbackGenerationRecord {
  id: string;
  answerAttemptId: string;
  questionInstanceId: string;
  sessionId: string;
  versionNumber: number;
  isCurrent: boolean;
  status: string;
  inputRevisionId: string;
  inputContentHash: string;
  model: string | null;
  provider: string | null;
  promptVersion: string | null;
  knowledgeBaseVersion: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FeedbackItemRecord {
  id: string;
  sessionId: string;
  transcriptId: string;
  generationId: string;
  itemOrder: number;
  problemLabel: string;
  evidence: string;
  explanation: string;
  suggestion: string;
}

export interface SessionSummaryGenerationRecord {
  id: string;
  sessionId: string;
  versionNumber: number;
  status: string;
  isCurrent: boolean;
  bodyText: string | null;
  structuredPayload: string | null;
  inputHash: string;
  model: string | null;
  provider: string | null;
  promptVersion: string | null;
  knowledgeBaseVersion: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface SessionSummaryInputRecord {
  id: string;
  summaryGenerationId: string;
  sessionId: string;
  questionInstanceId: string;
  feedbackGenerationId: string;
  inputOrder: number;
}

export interface CoachingConversationRecord {
  id: string;
  sessionId: string;
  status: string;
}

export interface DialogueTurnRecord {
  id: string;
  sessionId: string;
  conversationId: string;
  turnNumber: number;
  userText: string;
  entryMode: string;
  assistantReply: string;
  replyModel: string | null;
  replyPromptVersion: string | null;
  contextSnapshot: string | null;
  targetType: string;
  questionInstanceId: string | null;
  answerAttemptId: string | null;
  commercialFeedbackItemId: string | null;
  summaryGenerationId: string | null;
}
