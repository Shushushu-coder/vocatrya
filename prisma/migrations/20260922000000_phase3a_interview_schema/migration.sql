-- Phase 3A Interview schema transplant — SAFE handcrafted migration.
-- MIGRATION_CLASSIFICATION: ADDITIVE
--
-- Source contracts (read-only, never reinvented):
-- - E:\Projects\InterviewDx\migration\vocatrya-port\prisma\schema.prisma
-- - E:\Projects\InterviewDx\migration\vocatrya-port\prisma\transplant\interview-models.prisma
-- - E:\Projects\InterviewDx\migration\vocatrya-port\prisma\transplant\interview-constraints.sql
-- - E:\Projects\InterviewDx\migration\vocatrya-port\prisma\migrations\20260919120000_init_interview_port\migration.sql
--
-- Reference Prisma diff for this schema change contains RedefineTables for
-- "Question" (CREATE new_Question + INSERT...SELECT + DROP + RENAME), which is
-- classified UNACCEPTABLE_FOR_QUESTION_ADDITIVE_CHANGE. This handcrafted file
-- replaces it with per-column ALTER TABLE ... ADD COLUMN. Hard guarantees:
-- no DROP Question, no rename/rebuild Question, no copy-to-new-table Question.
-- Existing Question rows survive; new columns are NULL/defaulted, no backfill.
--
-- Every statement maps to either a schema.prisma change or a port DB invariant:
-- - Q1..Q7: Question additive columns (schema.prisma Question)
-- - Q8: @@unique([presetBankKey, presetItemKey]) (schema.prisma Question)
-- - J1: @@unique([id, jobOpportunityId]) (schema.prisma JobDescriptionVersion;
--   logically redundant, required for the InterviewSession composite FK)
-- - T01..T14: 14 new Interview-owned tables (schema.prisma, DIRECT_TRANSPLANT)
-- - CHECK constraints ck_*: port interview-constraints.sql verbatim
--   (Prisma schema cannot express them; see constraint provenance below)
-- - Partial uniques *_current_key: port interview-constraints.sql verbatim
--
-- Constraint provenance (name / source port invariant / why Prisma cannot
-- express it / expected SQLite behavior):
-- - ck_interview_sessions_status|coaching_mode|feedback_release_policy|job_pair:
--   SESSION_STATUS|SESSION_COACHING_MODE|SESSION_FEEDBACK_POLICY|SESSION_JOB_JD_PAIR;
--   String enums + pair rule are not Prisma-expressible; SQLite rejects
--   out-of-set status/mode/policy and XOR job/JD pairs at write time.
-- - ck_question_instances_display_order|source_kind|status:
--   INSTANCE_ORDER|INSTANCE_SOURCE_KIND|INSTANCE_STATUS; same reason.
-- - ck_answer_attempts_attempt_number|input_type|status:
--   ATTEMPT_NUMBER|ATTEMPT_INPUT_TYPE|ATTEMPT_STATUS; same reason.
-- - ck_answer_input_artifacts_input_type|role|payload:
--   ARTIFACT_INPUT_TYPE|ARTIFACT_ROLE|ARTIFACT_PAYLOAD; payload CHECK
--   (TEXT=>non-blank textContent, AUDIO=>non-empty filePath) is not
--   Prisma-expressible; SQLite rejects mismatched payloads.
-- - ck_transcript_revisions_revision_number|revision_kind|alignment_status:
--   REVISION_NUMBER|REVISION_KIND|REVISION_ALIGNMENT; same reason.
-- - ck_feedback_generations_version_number|status|current_requires_succeeded:
--   GENERATION_VERSION|GENERATION_STATUS|GENERATION_CURRENT_SUCCEEDED; the
--   current=>SUCCEEDED implication is not Prisma-expressible.
-- - ck_session_summary_generations_version_number|status|current_requires_succeeded:
--   SUMMARY_VERSION|SUMMARY_STATUS|SUMMARY_CURRENT_SUCCEEDED; same reason.
-- - ck_session_summary_inputs_input_order: SUMMARY_INPUT_ORDER; same reason.
-- - ck_coaching_conversations_status: CONVERSATION_STATUS; same reason.
-- - ck_dialogue_turns_target_type|commercial_target_xor:
--   DIALOGUE_TARGET_TYPE|DIALOGUE_TARGET_XOR; strict target XOR is not
--   Prisma-expressible; SQLite rejects rows where the non-null target id
--   does not exactly match targetType.
-- - FeedbackGeneration_attempt_current_key / SessionSummaryGeneration_session_current_key:
--   FEEDBACK_ONE_CURRENT_PER_ATTEMPT / SUMMARY_ONE_CURRENT_PER_SESSION;
--   partial unique WHERE isCurrent=1 is not Prisma-expressible; SQLite allows
--   many isCurrent=0 rows but at most one isCurrent=1 row per parent.

-- ---------------------------------------------------------------------------
-- Q1..Q7 — Question additive columns (explicit ALTER TABLE, no rebuild).
-- ---------------------------------------------------------------------------
ALTER TABLE "Question" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "Question" ADD COLUMN "category" TEXT;
ALTER TABLE "Question" ADD COLUMN "locale" TEXT DEFAULT 'zh';
ALTER TABLE "Question" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Question" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Question" ADD COLUMN "presetBankKey" TEXT;
ALTER TABLE "Question" ADD COLUMN "presetItemKey" TEXT;

-- Q8 — Question preset attribution unique (installer idempotency).
CREATE UNIQUE INDEX "Question_presetBankKey_presetItemKey_key" ON "Question"("presetBankKey", "presetItemKey");

-- ---------------------------------------------------------------------------
-- J1 — JobDescriptionVersion composite-FK support (additive unique index).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "JobDescriptionVersion_id_jobOpportunityId_key" ON "JobDescriptionVersion"("id", "jobOpportunityId");

-- ---------------------------------------------------------------------------
-- T01 — QuestionBank (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "QuestionBank" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'zh',
    "kind" TEXT NOT NULL DEFAULT 'SAMPLE_FIXTURE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- T02 — QuestionBankItem (new table, HOST_RELATION_REWRITE on questionId).
-- ---------------------------------------------------------------------------
CREATE TABLE "QuestionBankItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuestionBankItem_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QuestionBankItem_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- T03 — InterviewSession (new table, HOST_RELATION_REWRITE on
-- userId/jobOpportunityId/jobDescriptionVersionId).
-- ---------------------------------------------------------------------------
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "coachingMode" TEXT NOT NULL,
    "feedbackReleasePolicy" TEXT NOT NULL,
    "feedbackReleasedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "archivedAt" DATETIME,
    "statusBeforeArchive" TEXT,
    "knowledgeBaseVersion" TEXT NOT NULL,
    "currentQuestionInstanceId" TEXT,
    "jobOpportunityId" TEXT,
    "jobDescriptionVersionId" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewSession_jobOpportunityId_fkey" FOREIGN KEY ("jobOpportunityId") REFERENCES "JobOpportunity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewSession_jobDescriptionVersionId_jobOpportunityId_fkey" FOREIGN KEY ("jobDescriptionVersionId", "jobOpportunityId") REFERENCES "JobDescriptionVersion" ("id", "jobOpportunityId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewSession_currentQuestionInstanceId_fkey" FOREIGN KEY ("currentQuestionInstanceId") REFERENCES "QuestionInstance" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_interview_sessions_status" CHECK ("status" IN ('DRAFT', 'IN_PROGRESS', 'COACHING', 'COMPLETED', 'ARCHIVED')),
    CONSTRAINT "ck_interview_sessions_coaching_mode" CHECK ("coachingMode" IN ('PRACTICE', 'MOCK')),
    CONSTRAINT "ck_interview_sessions_feedback_release_policy" CHECK ("feedbackReleasePolicy" IN ('IMMEDIATE', 'ON_SESSION_COMPLETE')),
    CONSTRAINT "ck_interview_sessions_job_pair" CHECK (("jobOpportunityId" IS NULL AND "jobDescriptionVersionId" IS NULL) OR ("jobOpportunityId" IS NOT NULL AND "jobDescriptionVersionId" IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- T04 — QuestionInstance (new table, HOST_RELATION_REWRITE on sourceQuestionId).
-- ---------------------------------------------------------------------------
CREATE TABLE "QuestionInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sourceQuestionId" TEXT,
    "displayOrder" INTEGER NOT NULL,
    "displayedText" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "category" TEXT,
    "sourceMetadata" TEXT,
    "referenceAnswerSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuestionInstance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QuestionInstance_sourceQuestionId_fkey" FOREIGN KEY ("sourceQuestionId") REFERENCES "Question" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_question_instances_display_order" CHECK ("displayOrder" >= 0),
    CONSTRAINT "ck_question_instances_source_kind" CHECK ("sourceKind" IN ('USER_PROVIDED', 'QUESTION_BANK', 'AI_GENERATED', 'TEMPLATE')),
    CONSTRAINT "ck_question_instances_status" CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'ANSWERED', 'SKIPPED'))
);

-- ---------------------------------------------------------------------------
-- T05 — AnswerAttempt (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "AnswerAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "questionInstanceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "inputType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "startedAt" DATETIME,
    "submittedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "activeRevisionId" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnswerAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AnswerAttempt_questionInstanceId_sessionId_fkey" FOREIGN KEY ("questionInstanceId", "sessionId") REFERENCES "QuestionInstance" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AnswerAttempt_activeRevisionId_id_fkey" FOREIGN KEY ("activeRevisionId", "id") REFERENCES "TranscriptRevision" ("id", "answerAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_answer_attempts_attempt_number" CHECK ("attemptNumber" >= 1),
    CONSTRAINT "ck_answer_attempts_input_type" CHECK ("inputType" IN ('TEXT', 'AUDIO')),
    CONSTRAINT "ck_answer_attempts_status" CHECK ("status" IN ('STARTED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'DISCARDED'))
);

-- ---------------------------------------------------------------------------
-- T06 — AnswerInputArtifact (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "AnswerInputArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "answerAttemptId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "inputType" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "filePath" TEXT,
    "fileFormat" TEXT,
    "durationSeconds" REAL,
    "fileSizeBytes" INTEGER,
    "textContent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnswerInputArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AnswerInputArtifact_answerAttemptId_sessionId_fkey" FOREIGN KEY ("answerAttemptId", "sessionId") REFERENCES "AnswerAttempt" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_answer_input_artifacts_input_type" CHECK ("inputType" IN ('TEXT', 'AUDIO')),
    CONSTRAINT "ck_answer_input_artifacts_role" CHECK ("role" IN ('SOURCE', 'NORMALIZED')),
    CONSTRAINT "ck_answer_input_artifacts_payload" CHECK (("inputType" = 'TEXT' AND "textContent" IS NOT NULL AND trim("textContent") <> '') OR ("inputType" = 'AUDIO' AND "filePath" IS NOT NULL AND "filePath" <> ''))
);

-- ---------------------------------------------------------------------------
-- T07 — Transcript (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "answerAttemptId" TEXT NOT NULL,
    "sourceArtifactId" TEXT,
    "fullText" TEXT NOT NULL,
    "segments" TEXT NOT NULL DEFAULT '[]',
    "asrModel" TEXT,
    "asrStatus" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transcript_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transcript_answerAttemptId_fkey" FOREIGN KEY ("answerAttemptId") REFERENCES "AnswerAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transcript_sourceArtifactId_fkey" FOREIGN KEY ("sourceArtifactId") REFERENCES "AnswerInputArtifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- T08 — TranscriptRevision (new table, HOST_RELATION_REWRITE on createdByUserId).
-- ---------------------------------------------------------------------------
CREATE TABLE "TranscriptRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT NOT NULL,
    "answerAttemptId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "revisionKind" TEXT NOT NULL,
    "fullText" TEXT NOT NULL,
    "segments" TEXT,
    "alignmentStatus" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdVia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TranscriptRevision_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TranscriptRevision_answerAttemptId_fkey" FOREIGN KEY ("answerAttemptId") REFERENCES "AnswerAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TranscriptRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_transcript_revisions_revision_number" CHECK ("revisionNumber" >= 1),
    CONSTRAINT "ck_transcript_revisions_revision_kind" CHECK ("revisionKind" IN ('ORIGINAL_ASR', 'ORIGINAL_TEXT', 'USER_CORRECTED')),
    CONSTRAINT "ck_transcript_revisions_alignment_status" CHECK ("alignmentStatus" IN ('PRESERVED', 'PARTIAL', 'DROPPED', 'NOT_APPLICABLE'))
);

-- ---------------------------------------------------------------------------
-- T09 — FeedbackGeneration (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "FeedbackGeneration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "answerAttemptId" TEXT NOT NULL,
    "questionInstanceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "inputRevisionId" TEXT NOT NULL,
    "inputContentHash" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "promptVersion" TEXT,
    "knowledgeBaseVersion" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "FeedbackGeneration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FeedbackGeneration_answerAttemptId_questionInstanceId_sessionId_fkey" FOREIGN KEY ("answerAttemptId", "questionInstanceId", "sessionId") REFERENCES "AnswerAttempt" ("id", "questionInstanceId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FeedbackGeneration_inputRevisionId_answerAttemptId_fkey" FOREIGN KEY ("inputRevisionId", "answerAttemptId") REFERENCES "TranscriptRevision" ("id", "answerAttemptId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_feedback_generations_version_number" CHECK ("versionNumber" >= 1),
    CONSTRAINT "ck_feedback_generations_status" CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    CONSTRAINT "ck_feedback_generations_current_requires_succeeded" CHECK ("isCurrent" = 0 OR "status" = 'SUCCEEDED')
);

-- ---------------------------------------------------------------------------
-- T10 — FeedbackItem (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "FeedbackItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "itemOrder" INTEGER NOT NULL,
    "problemLabel" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FeedbackItem_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FeedbackItem_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "FeedbackGeneration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- T11 — SessionSummaryGeneration (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "SessionSummaryGeneration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "bodyText" TEXT,
    "structuredPayload" TEXT,
    "inputHash" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "promptVersion" TEXT,
    "knowledgeBaseVersion" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "SessionSummaryGeneration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_session_summary_generations_version_number" CHECK ("versionNumber" >= 1),
    CONSTRAINT "ck_session_summary_generations_status" CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    CONSTRAINT "ck_session_summary_generations_current_requires_succeeded" CHECK ("isCurrent" = 0 OR "status" = 'SUCCEEDED')
);

-- ---------------------------------------------------------------------------
-- T12 — SessionSummaryInput (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "SessionSummaryInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "summaryGenerationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionInstanceId" TEXT NOT NULL,
    "feedbackGenerationId" TEXT NOT NULL,
    "inputOrder" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSummaryInput_summaryGenerationId_sessionId_fkey" FOREIGN KEY ("summaryGenerationId", "sessionId") REFERENCES "SessionSummaryGeneration" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SessionSummaryInput_feedbackGenerationId_questionInstanceId_sessionId_fkey" FOREIGN KEY ("feedbackGenerationId", "questionInstanceId", "sessionId") REFERENCES "FeedbackGeneration" ("id", "questionInstanceId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_session_summary_inputs_input_order" CHECK ("inputOrder" >= 1)
);

-- ---------------------------------------------------------------------------
-- T13 — CoachingConversation (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "CoachingConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "CoachingConversation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_coaching_conversations_status" CHECK ("status" IN ('OPEN', 'CLOSED'))
);

-- ---------------------------------------------------------------------------
-- T14 — DialogueTurn (new table, DIRECT_TRANSPLANT).
-- ---------------------------------------------------------------------------
CREATE TABLE "DialogueTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "userText" TEXT NOT NULL,
    "entryMode" TEXT NOT NULL,
    "assistantReply" TEXT NOT NULL DEFAULT '',
    "replyModel" TEXT,
    "replyPromptVersion" TEXT,
    "contextSnapshot" TEXT,
    "targetType" TEXT NOT NULL,
    "questionInstanceId" TEXT,
    "answerAttemptId" TEXT,
    "commercialFeedbackItemId" TEXT,
    "summaryGenerationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DialogueTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialogueTurn_conversationId_sessionId_fkey" FOREIGN KEY ("conversationId", "sessionId") REFERENCES "CoachingConversation" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialogueTurn_questionInstanceId_sessionId_fkey" FOREIGN KEY ("questionInstanceId", "sessionId") REFERENCES "QuestionInstance" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialogueTurn_answerAttemptId_sessionId_fkey" FOREIGN KEY ("answerAttemptId", "sessionId") REFERENCES "AnswerAttempt" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialogueTurn_commercialFeedbackItemId_sessionId_fkey" FOREIGN KEY ("commercialFeedbackItemId", "sessionId") REFERENCES "FeedbackItem" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialogueTurn_summaryGenerationId_sessionId_fkey" FOREIGN KEY ("summaryGenerationId", "sessionId") REFERENCES "SessionSummaryGeneration" ("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ck_dialogue_turns_target_type" CHECK ("targetType" IN ('SESSION', 'QUESTION_INSTANCE', 'ANSWER_ATTEMPT', 'FEEDBACK_ITEM', 'SESSION_SUMMARY')),
    CONSTRAINT "ck_dialogue_turns_commercial_target_xor" CHECK (
        ("targetType" = 'SESSION' AND "questionInstanceId" IS NULL AND "answerAttemptId" IS NULL AND "commercialFeedbackItemId" IS NULL AND "summaryGenerationId" IS NULL)
        OR ("targetType" = 'QUESTION_INSTANCE' AND "questionInstanceId" IS NOT NULL AND "answerAttemptId" IS NULL AND "commercialFeedbackItemId" IS NULL AND "summaryGenerationId" IS NULL)
        OR ("targetType" = 'ANSWER_ATTEMPT' AND "questionInstanceId" IS NULL AND "answerAttemptId" IS NOT NULL AND "commercialFeedbackItemId" IS NULL AND "summaryGenerationId" IS NULL)
        OR ("targetType" = 'FEEDBACK_ITEM' AND "questionInstanceId" IS NULL AND "answerAttemptId" IS NULL AND "commercialFeedbackItemId" IS NOT NULL AND "summaryGenerationId" IS NULL)
        OR ("targetType" = 'SESSION_SUMMARY' AND "questionInstanceId" IS NULL AND "answerAttemptId" IS NULL AND "commercialFeedbackItemId" IS NULL AND "summaryGenerationId" IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Indexes for new tables (Prisma-expressible part, verbatim naming).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "QuestionBank_bankKey_version_key" ON "QuestionBank"("bankKey", "version");
CREATE UNIQUE INDEX "QuestionBankItem_bankId_questionId_key" ON "QuestionBankItem"("bankId", "questionId");
CREATE UNIQUE INDEX "QuestionBankItem_bankId_displayOrder_key" ON "QuestionBankItem"("bankId", "displayOrder");
CREATE INDEX "InterviewSession_userId_status_idx" ON "InterviewSession"("userId", "status");
CREATE INDEX "InterviewSession_userId_createdAt_idx" ON "InterviewSession"("userId", "createdAt");
CREATE UNIQUE INDEX "QuestionInstance_sessionId_displayOrder_key" ON "QuestionInstance"("sessionId", "displayOrder");
CREATE UNIQUE INDEX "QuestionInstance_id_sessionId_key" ON "QuestionInstance"("id", "sessionId");
CREATE INDEX "AnswerAttempt_sessionId_createdAt_idx" ON "AnswerAttempt"("sessionId", "createdAt");
CREATE UNIQUE INDEX "AnswerAttempt_questionInstanceId_attemptNumber_key" ON "AnswerAttempt"("questionInstanceId", "attemptNumber");
CREATE UNIQUE INDEX "AnswerAttempt_id_sessionId_key" ON "AnswerAttempt"("id", "sessionId");
CREATE UNIQUE INDEX "AnswerAttempt_id_questionInstanceId_sessionId_key" ON "AnswerAttempt"("id", "questionInstanceId", "sessionId");
CREATE INDEX "AnswerInputArtifact_answerAttemptId_idx" ON "AnswerInputArtifact"("answerAttemptId");
CREATE INDEX "Transcript_answerAttemptId_idx" ON "Transcript"("answerAttemptId");
CREATE UNIQUE INDEX "TranscriptRevision_transcriptId_revisionNumber_key" ON "TranscriptRevision"("transcriptId", "revisionNumber");
CREATE UNIQUE INDEX "TranscriptRevision_id_answerAttemptId_key" ON "TranscriptRevision"("id", "answerAttemptId");
CREATE UNIQUE INDEX "FeedbackGeneration_answerAttemptId_versionNumber_key" ON "FeedbackGeneration"("answerAttemptId", "versionNumber");
CREATE UNIQUE INDEX "FeedbackGeneration_id_answerAttemptId_key" ON "FeedbackGeneration"("id", "answerAttemptId");
CREATE UNIQUE INDEX "FeedbackGeneration_id_questionInstanceId_sessionId_key" ON "FeedbackGeneration"("id", "questionInstanceId", "sessionId");
CREATE INDEX "FeedbackItem_generationId_itemOrder_idx" ON "FeedbackItem"("generationId", "itemOrder");
CREATE UNIQUE INDEX "FeedbackItem_id_sessionId_key" ON "FeedbackItem"("id", "sessionId");
CREATE UNIQUE INDEX "SessionSummaryGeneration_sessionId_versionNumber_key" ON "SessionSummaryGeneration"("sessionId", "versionNumber");
CREATE UNIQUE INDEX "SessionSummaryGeneration_id_sessionId_key" ON "SessionSummaryGeneration"("id", "sessionId");
CREATE UNIQUE INDEX "SessionSummaryInput_summaryGenerationId_inputOrder_key" ON "SessionSummaryInput"("summaryGenerationId", "inputOrder");
CREATE UNIQUE INDEX "SessionSummaryInput_summaryGenerationId_questionInstanceId_key" ON "SessionSummaryInput"("summaryGenerationId", "questionInstanceId");
CREATE UNIQUE INDEX "CoachingConversation_sessionId_key" ON "CoachingConversation"("sessionId");
CREATE UNIQUE INDEX "CoachingConversation_id_sessionId_key" ON "CoachingConversation"("id", "sessionId");
CREATE UNIQUE INDEX "DialogueTurn_sessionId_turnNumber_key" ON "DialogueTurn"("sessionId", "turnNumber");

-- ---------------------------------------------------------------------------
-- Partial unique indexes (port interview-constraints.sql verbatim).
-- FEEDBACK_ONE_CURRENT_PER_ATTEMPT / SUMMARY_ONE_CURRENT_PER_SESSION.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "FeedbackGeneration_attempt_current_key" ON "FeedbackGeneration"("answerAttemptId") WHERE "isCurrent" = 1;
CREATE UNIQUE INDEX "SessionSummaryGeneration_session_current_key" ON "SessionSummaryGeneration"("sessionId") WHERE "isCurrent" = 1;
