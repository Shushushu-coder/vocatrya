/**
 * Product Interview application service.
 *
 * Frozen domain semantics via Host Port v0 + Phase 3B persistence.
 * No Prisma in this file. Model calls only through InterviewModelPort.
 */
import type { PrismaClient } from "@prisma/client";
import {
  COACHING_PROMPT_VERSION,
  DIALOGUE_TARGET_TYPES,
  FEEDBACK_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION,
  type CoachingMode,
  type DialogueTargetType,
} from "../persistence/interviewEnums";
import {
  DomainError,
  ErrorCodes,
  NotFoundError,
  OwnershipError,
  SummaryNotReadyError,
} from "../persistence/interviewErrors";
import {
  canonicalSummaryInputHash,
  canonicalTranscriptContentHash,
} from "../persistence/hash";
import { stringifyJson } from "../persistence/json";
import { VocatryaInterviewPersistence } from "../persistence/vocatryaInterviewPersistence";
import type {
  AnswerAttemptRecord,
  DialogueTurnRecord,
  FeedbackGenerationRecord,
  FeedbackItemRecord,
  QuestionInstanceRecord,
  SessionRecord,
  SessionSummaryGenerationRecord,
  SessionSummaryInputRecord,
  TranscriptRecord,
  TranscriptRevisionRecord,
} from "../persistence/interviewRecords";
import type {
  CommercialQuestionSpec,
  InterviewModelPort,
  JobContextPort,
  QuestionPort,
  UserOwnershipPort,
} from "../hostPorts";
import {
  VocatryaInterviewModelAdapter,
  VocatryaJobContextAdapter,
  VocatryaQuestionAdapter,
  VocatryaUserOwnershipAdapter,
} from "../vocatryaHostPorts";
import { validateFeedbackItem } from "../validation/feedback";
import { groundFeedbackItem } from "./evidence";
import { loadOwnershipView, loadWritableOwnership } from "./ownership";
import { BundledKnowledgeProvider, type KnowledgeProvider } from "./knowledge";
import { SystemClock, type Clock } from "./clock";
import { VocatryaInterviewQueries } from "./hostQueries";
import { ensureCanonicalPreset } from "../presets/install";
import { resolveInterviewAiRuntime } from "../interviewRuntimePlan";

export interface InterviewRuntimeDeps {
  db: PrismaClient;
  modelPort?: InterviewModelPort;
  questionPort?: QuestionPort;
  jobContextPort?: JobContextPort;
  ownershipPort?: UserOwnershipPort;
  knowledge?: KnowledgeProvider;
  clock?: Clock;
  persistence?: VocatryaInterviewPersistence;
  queries?: VocatryaInterviewQueries;
}

export interface FeedbackResult {
  generation: FeedbackGenerationRecord;
  items: FeedbackItemRecord[];
}

export interface SummaryResult {
  generation: SessionSummaryGenerationRecord;
  inputs: SessionSummaryInputRecord[];
}

export interface SummaryEvidence {
  inputOrder: number;
  questionInstanceId: string;
  feedbackGenerationId: string;
  inputRevisionId: string;
  inputContentHash: string | null;
}

export type InterviewSessionHistory = {
  session: SessionRecord;
  instances: QuestionInstanceRecord[];
  attempts: Array<{
    instance: QuestionInstanceRecord;
    attempt: AnswerAttemptRecord | null;
    transcriptText: string;
    feedback: FeedbackResult | null;
  }>;
  turns: DialogueTurnRecord[];
  summary: SummaryResult | null;
};

export function createInterviewRuntime(deps: InterviewRuntimeDeps) {
  const persistence = deps.persistence ?? new VocatryaInterviewPersistence(deps.db);
  const queries = deps.queries ?? new VocatryaInterviewQueries(deps.db);
  const ownershipPort =
    deps.ownershipPort ?? new VocatryaUserOwnershipAdapter(deps.db);
  const questionPort = deps.questionPort ?? new VocatryaQuestionAdapter(deps.db);
  const jobContextPort = deps.jobContextPort ?? new VocatryaJobContextAdapter(deps.db);
  const modelPort =
    deps.modelPort ?? new VocatryaInterviewModelAdapter(deps.db);
  const knowledge = deps.knowledge ?? new BundledKnowledgeProvider();
  const clock = deps.clock ?? new SystemClock();

  async function ensurePreset(userId: string) {
    return ensureCanonicalPreset(deps.db, userId);
  }

  async function createInterviewSession(input: {
    userId: string;
    coachingMode: CoachingMode;
    questions: CommercialQuestionSpec[];
    feedbackReleasePolicy?: string | null;
    jobOpportunityId?: string | null;
    jobDescriptionVersionId?: string | null;
  }) {
    const jobContext = await jobContextPort.resolveJobContext({
      requestingUserId: input.userId,
      jobOpportunityId: input.jobOpportunityId ?? null,
      jobDescriptionVersionId: input.jobDescriptionVersionId ?? null,
    });
    const prepared: CommercialQuestionSpec[] = [];
    for (const spec of input.questions) {
      let referenceAnswer = spec.referenceAnswerSnapshot ?? null;
      let sourceQuestionId = spec.sourceQuestionId ?? null;
      if (spec.sourceQuestionId) {
        const snapshot = await questionPort.resolveSnapshot({
          sourceQuestionId: spec.sourceQuestionId,
          requestingUserId: input.userId,
        });
        sourceQuestionId = snapshot.sourceQuestionId;
        if (referenceAnswer == null) referenceAnswer = snapshot.referenceAnswerSnapshot;
      }
      prepared.push({
        ...spec,
        sourceQuestionId,
        referenceAnswerSnapshot: referenceAnswer,
      });
    }
    // Resolve the INTERVIEW AI config exactly once. The lock travels into
    // createSession's transaction so the session and its bound config are
    // one atomic write; a broken explicit assignment fails here and never
    // falls back to legacy/global.
    const { plan, lock } = await resolveInterviewAiRuntime(
      input.userId,
      deps.db,
    );
    if (plan.kind === "invalid") {
      throw new DomainError(
        plan.code,
        "The assigned interview AI connection is not usable",
      );
    }
    return persistence.createSession({
      actorUserId: input.userId,
      coachingMode: input.coachingMode,
      feedbackReleasePolicy: input.feedbackReleasePolicy,
      knowledgeBaseVersion: knowledge.version,
      jobOpportunityId: jobContext.jobOpportunityId,
      jobDescriptionVersionId: jobContext.jobDescriptionVersionId,
      createdVia: "USER",
      resolvedConnectionId: lock.resolvedConnectionId ?? null,
      resolvedModel: lock.resolvedModel ?? null,
      questions: prepared,
    });
  }

  async function listInterviewSessions(userId: string) {
    await persistence.ensureUserExists(userId);
    return queries.listSessions(userId);
  }

  async function getInterviewSession(userId: string, sessionId: string) {
    const session = await persistence.getSessionForUser(sessionId, userId);
    const instances = await persistence.listInstancesForUser(sessionId, userId);
    return { session, instances };
  }

  async function completeSession(userId: string, sessionId: string) {
    await loadWritableOwnership(ownershipPort, userId, sessionId);
    const session = await persistence.getSessionForUser(sessionId, userId);
    const now = clock.now();
    return persistence.updateSessionForUser(sessionId, userId, {
      status: session.coachingMode === "MOCK" ? "COACHING" : "COMPLETED",
      completedAt: now,
      feedbackReleasedAt: session.feedbackReleasedAt ?? now,
    });
  }

  async function advanceQuestion(
    userId: string,
    sessionId: string,
    questionInstanceId: string,
  ) {
    return persistence.updateSessionForUser(sessionId, userId, {
      currentQuestionInstanceId: questionInstanceId,
    });
  }

  async function submitInterviewAnswer(input: {
    userId: string;
    questionInstanceId: string;
    textContent: string;
    durationMs?: number | null;
  }): Promise<{
    attempt: AnswerAttemptRecord;
    transcript: TranscriptRecord;
    revision: TranscriptRevisionRecord;
  }> {
    if (!input.textContent?.trim()) {
      throw new DomainError(ErrorCodes.INVALID_TEXT, "TEXT answers require text_content");
    }
    const now = clock.now();
    const attempt = await persistence.createAttemptForUser({
      actorUserId: input.userId,
      questionInstanceId: input.questionInstanceId,
      inputType: "TEXT",
      startedAt: now,
    });
    const artifact = await persistence.createArtifactForUser({
      actorUserId: input.userId,
      answerAttemptId: attempt.id,
      inputType: "TEXT",
      role: "SOURCE",
      textContent: input.textContent,
    });
    const transcript = await persistence.createTranscriptForUser({
      actorUserId: input.userId,
      answerAttemptId: attempt.id,
      fullText: input.textContent,
      segments: "[]",
      sourceArtifactId: artifact.id,
      asrStatus: "not_applicable",
    });
    const revision = await persistence.createOriginalRevisionForUser({
      actorUserId: input.userId,
      transcriptId: transcript.id,
      answerAttemptId: attempt.id,
      revisionKind: "ORIGINAL_TEXT",
      alignmentStatus: "NOT_APPLICABLE",
      contentHash: canonicalTranscriptContentHash(input.textContent, []),
      createdVia: "TEXT_SUBMIT",
    });
    await persistence.updateInstanceForUser(input.questionInstanceId, input.userId, {
      status: "ANSWERED",
    });
    const finished = await persistence.completeAttemptForUser({
      actorUserId: input.userId,
      answerAttemptId: attempt.id,
      submittedAt: now,
      completedAt: now,
      durationMs: input.durationMs ?? null,
    });
    return { attempt: finished, transcript, revision };
  }

  async function saveTranscriptRevision(input: {
    userId: string;
    answerAttemptId: string;
    fullText: string;
  }) {
    return persistence.createCorrectedRevisionForUser({
      actorUserId: input.userId,
      answerAttemptId: input.answerAttemptId,
      fullText: input.fullText,
      contentHash: canonicalTranscriptContentHash(input.fullText, []),
    });
  }

  async function activateRevision(input: {
    userId: string;
    answerAttemptId: string;
    revisionId: string;
  }) {
    return persistence.setActiveRevisionForUser({
      actorUserId: input.userId,
      answerAttemptId: input.answerAttemptId,
      revisionId: input.revisionId,
    });
  }

  async function generateInterviewFeedback(input: {
    userId: string;
    answerAttemptId: string;
    inputRevisionId?: string | null;
  }): Promise<FeedbackResult> {
    const attempt = await persistence.getAttemptForUser(
      input.answerAttemptId,
      input.userId,
    );
    await loadWritableOwnership(ownershipPort, input.userId, attempt.sessionId);
    const session = await persistence.getSessionForUser(attempt.sessionId, input.userId);
    const instance = await persistence.getInstanceForUser(
      attempt.questionInstanceId,
      input.userId,
    );
    const model = await modelPort.resolveInterviewModel({
      requestingUserId: input.userId,
      sessionId: attempt.sessionId,
    });
    const revisionId = input.inputRevisionId ?? attempt.activeRevisionId;
    if (!revisionId) {
      throw new DomainError(
        ErrorCodes.NO_ACTIVE_REVISION,
        "Answer attempt has no active transcript revision",
      );
    }
    const generation = await persistence.createPendingFeedbackForUser({
      actorUserId: input.userId,
      answerAttemptId: attempt.id,
      inputRevisionId: revisionId,
      model: model.model,
      provider: model.provider,
      promptVersion: FEEDBACK_PROMPT_VERSION,
      knowledgeBaseVersion: session.knowledgeBaseVersion,
    });
    try {
      const revisionRow = await persistence.getRevisionForUser(revisionId, input.userId);
      if (revisionRow.answerAttemptId !== attempt.id) {
        throw new DomainError(
          ErrorCodes.INVALID_INPUT_REVISION,
          "Transcript revision does not belong to this answer attempt",
        );
      }
      const built = {
        system: `You are an interview coach. Return JSON {feedbackItems:[...]}. Prompt ${FEEDBACK_PROMPT_VERSION}. KB ${knowledge.version}. ${knowledge.promptExcerpt()}`,
        prompt: [
          "FEEDBACK_GENERATION",
          `question: ${instance.displayedText}`,
          `transcript_revision: ${revisionRow.fullText}`,
          `knowledge_base_version: ${session.knowledgeBaseVersion}`,
          `knowledge_content_hash: ${knowledge.contentHash}`,
        ].join("\n"),
      };
      const raw = await model.generateJson(built);
      const payload = raw as { feedbackItems?: unknown[] };
      const sourceItems = payload.feedbackItems ?? [];
      const validated = sourceItems.map((item) =>
        groundFeedbackItem(revisionRow.fullText, validateFeedbackItem(item)),
      );
      if (!validated.length) {
        const failed = await persistence.failFeedbackForUser({
          actorUserId: input.userId,
          generationId: generation.id,
          code: ErrorCodes.EMPTY_ITEMS,
          message: "Commercial feedback generation produced no items",
        });
        return { generation: failed, items: [] };
      }
      return persistence.publishFeedbackForUser({
        actorUserId: input.userId,
        generationId: generation.id,
        transcriptId: revisionRow.transcriptId,
        items: validated.map((item) => ({
          problemLabel: item.problemLabel,
          evidence: item.evidence,
          explanation: item.explanation,
          suggestion: item.suggestion,
        })),
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCodes.SESSION_ARCHIVED) {
        throw error;
      }
      const code = error instanceof DomainError ? error.code : ErrorCodes.GENERATION_FAILED;
      const message = error instanceof Error ? error.message : String(error);
      const failed = await persistence.failFeedbackForUser({
        actorUserId: input.userId,
        generationId: generation.id,
        code,
        message,
      });
      return { generation: failed, items: [] };
    }
  }

  async function getInterviewFeedback(userId: string, answerAttemptId: string) {
    return persistence.getCurrentFeedbackWithItemsForUser(answerAttemptId, userId);
  }

  async function resolveSummaryEvidence(
    userId: string,
    sessionId: string,
    coachingMode: string,
  ): Promise<SummaryEvidence[]> {
    if (coachingMode !== "PRACTICE" && coachingMode !== "MOCK") {
      throw new DomainError(
        "SESSION_MODE_MAPPING_UNRESOLVED",
        "Session coaching_mode must be PRACTICE or MOCK",
      );
    }
    const instances = await persistence.listInstancesForUser(sessionId, userId);
    const required = instances.filter((row) => row.status !== "SKIPPED");
    const evidence: SummaryEvidence[] = [];
    let inputOrder = 1;
    for (const instance of required) {
      const attempt = await queries.findLatestCompletedAttempt(instance.id);
      if (!attempt) {
        if (coachingMode === "PRACTICE") continue;
        throw new SummaryNotReadyError(
          "Mock summary requires a completed attempt for every required question",
        );
      }
      const generation = await queries.findCurrentSucceededFeedback(attempt.id);
      if (!generation) {
        throw new SummaryNotReadyError(
          "Latest completed attempt does not have current succeeded feedback",
        );
      }
      evidence.push({
        inputOrder,
        questionInstanceId: instance.id,
        feedbackGenerationId: generation.id,
        inputRevisionId: generation.inputRevisionId,
        inputContentHash: generation.inputContentHash,
      });
      inputOrder += 1;
    }
    if (!evidence.length) {
      throw new SummaryNotReadyError("No eligible question evidence is ready for summary");
    }
    return evidence;
  }

  async function generateInterviewSummary(input: {
    userId: string;
    sessionId: string;
  }): Promise<SummaryResult> {
    await loadWritableOwnership(ownershipPort, input.userId, input.sessionId);
    const session = await persistence.getSessionForUser(input.sessionId, input.userId);
    const evidence = await resolveSummaryEvidence(
      input.userId,
      session.id,
      session.coachingMode,
    );
    const model = await modelPort.resolveInterviewModel({
      requestingUserId: input.userId,
      sessionId: session.id,
    });
    const inputHash = canonicalSummaryInputHash(session.id, evidence);
    const generation = await persistence.createPendingSummaryForUser({
      actorUserId: input.userId,
      sessionId: session.id,
      inputHash,
      model: model.model,
      provider: model.provider,
      promptVersion: SUMMARY_PROMPT_VERSION,
      knowledgeBaseVersion: session.knowledgeBaseVersion,
    });
    try {
      const raw = await model.generateJson({
        system: `Return JSON {bodyText, structuredPayload:{keyPatterns,strengths,developmentAreas}}. Prompt ${SUMMARY_PROMPT_VERSION}. KB ${knowledge.version}.`,
        prompt: `SESSION_SUMMARY\nsession:${session.id}\ninputs:${evidence.length}\nhash:${inputHash}\nknowledge:${knowledge.contentHash}`,
      });
      const payload = raw as {
        bodyText?: string;
        structuredPayload?: unknown;
      };
      const bodyText = String(payload.bodyText ?? "").trim();
      if (!bodyText) {
        throw new DomainError(ErrorCodes.INVALID_SUMMARY_OUTPUT, "body_text is required");
      }
      return persistence.publishSummaryForUser({
        actorUserId: input.userId,
        generationId: generation.id,
        evidence,
        bodyText,
        structuredPayload: payload.structuredPayload ?? null,
      });
    } catch (error) {
      if (error instanceof SummaryNotReadyError) {
        await persistence.deletePendingSummaryForUser(generation.id, input.userId);
        throw error;
      }
      const code = error instanceof DomainError ? error.code : ErrorCodes.GENERATION_FAILED;
      const message = error instanceof Error ? error.message : String(error);
      const failed = await persistence.failSummaryForUser({
        actorUserId: input.userId,
        generationId: generation.id,
        code,
        message,
      });
      return { generation: failed, inputs: [] };
    }
  }

  async function getInterviewSummary(userId: string, sessionId: string) {
    await loadOwnershipView(ownershipPort, userId, sessionId);
    return persistence.getCurrentSummaryWithInputsForUser(sessionId, userId);
  }

  async function sendInterviewFollowUp(input: {
    userId: string;
    sessionId: string;
    userText: string;
    targetType?: string;
    questionInstanceId?: string | null;
    answerAttemptId?: string | null;
    commercialFeedbackItemId?: string | null;
    summaryGenerationId?: string | null;
  }): Promise<DialogueTurnRecord> {
    if (!input.userText?.trim()) {
      throw new DomainError(ErrorCodes.INVALID_DIALOGUE_TEXT, "user_text is required");
    }
    await loadWritableOwnership(ownershipPort, input.userId, input.sessionId);
    const targetType = (input.targetType ?? "SESSION") as DialogueTargetType;
    if (!DIALOGUE_TARGET_TYPES.includes(targetType)) {
      throw new DomainError(ErrorCodes.INVALID_TARGET_TYPE, "Unsupported dialogue target_type");
    }
    const target = await resolveDialogueTarget({
      userId: input.userId,
      sessionId: input.sessionId,
      targetType,
      questionInstanceId: input.questionInstanceId,
      answerAttemptId: input.answerAttemptId,
      commercialFeedbackItemId: input.commercialFeedbackItemId,
      summaryGenerationId: input.summaryGenerationId,
    });
    const model = await modelPort.resolveInterviewModel({
      requestingUserId: input.userId,
      sessionId: input.sessionId,
    });
    const raw = await model.generateJson({
      system: `Return JSON {reply}. Prompt ${COACHING_PROMPT_VERSION}. Use only provenance identifiers. Never mention credentials, API keys, or internal UUIDs as secrets.`,
      prompt: [
        "COACHING_TURN",
        `user_text: ${input.userText}`,
        `target: ${stringifyJson(target.contextSnapshot)}`,
      ].join("\n"),
    });
    const reply = String((raw as { reply?: string }).reply ?? "").trim();
    if (!reply) {
      throw new DomainError(ErrorCodes.GENERATION_FAILED, "Coaching reply was empty");
    }
    return persistence.createTurnForUser({
      actorUserId: input.userId,
      sessionId: input.sessionId,
      userText: input.userText,
      targetType: target.targetType,
      questionInstanceId: target.questionInstanceId,
      answerAttemptId: target.answerAttemptId,
      commercialFeedbackItemId: target.commercialFeedbackItemId,
      summaryGenerationId: target.summaryGenerationId,
      assistantReply: reply,
      replyModel: model.model,
      replyPromptVersion: COACHING_PROMPT_VERSION,
      contextSnapshot: target.contextSnapshot,
    });
  }

  async function resolveDialogueTarget(input: {
    userId: string;
    sessionId: string;
    targetType: DialogueTargetType;
    questionInstanceId?: string | null;
    answerAttemptId?: string | null;
    commercialFeedbackItemId?: string | null;
    summaryGenerationId?: string | null;
  }) {
    await loadOwnershipView(ownershipPort, input.userId, input.sessionId);
    if (input.targetType === "SESSION") {
      const currentSummary = await queries.getCurrentSummaryGeneration(input.sessionId);
      return {
        targetType: "SESSION" as const,
        questionInstanceId: null,
        answerAttemptId: null,
        commercialFeedbackItemId: null,
        summaryGenerationId: null,
        contextSnapshot: {
          target_type: "SESSION",
          summary_generation_id: currentSummary?.id ?? null,
        },
      };
    }
    if (input.targetType === "FEEDBACK_ITEM") {
      if (!input.commercialFeedbackItemId) {
        throw new DomainError(
          ErrorCodes.INVALID_DIALOGUE_TARGET,
          "commercial_feedback_item_id is required",
        );
      }
      const item = await queries.getFeedbackItem(input.commercialFeedbackItemId);
      if (!item) throw new NotFoundError("Feedback item not found", "FEEDBACK_ITEM_NOT_FOUND");
      if (item.sessionId !== input.sessionId) {
        throw new OwnershipError("Feedback item does not belong to this session");
      }
      return {
        targetType: "FEEDBACK_ITEM" as const,
        questionInstanceId: null,
        answerAttemptId: null,
        commercialFeedbackItemId: item.id,
        summaryGenerationId: null,
        contextSnapshot: {
          target_type: "FEEDBACK_ITEM",
          feedback_item_id: item.id,
          generation_id: item.generationId,
        },
      };
    }
    if (input.targetType === "QUESTION_INSTANCE") {
      if (!input.questionInstanceId) {
        throw new DomainError(
          ErrorCodes.INVALID_DIALOGUE_TARGET,
          "question_instance_id is required",
        );
      }
      const instance = await persistence.getInstanceForUser(
        input.questionInstanceId,
        input.userId,
      );
      if (instance.sessionId !== input.sessionId) {
        throw new OwnershipError("Question instance does not belong to this session");
      }
      return {
        targetType: "QUESTION_INSTANCE" as const,
        questionInstanceId: instance.id,
        answerAttemptId: null,
        commercialFeedbackItemId: null,
        summaryGenerationId: null,
        contextSnapshot: {
          target_type: "QUESTION_INSTANCE",
          question_instance_id: instance.id,
        },
      };
    }
    if (input.targetType === "ANSWER_ATTEMPT") {
      if (!input.answerAttemptId) {
        throw new DomainError(
          ErrorCodes.INVALID_DIALOGUE_TARGET,
          "answer_attempt_id is required",
        );
      }
      const attempt = await persistence.getAttemptForUser(
        input.answerAttemptId,
        input.userId,
      );
      if (attempt.sessionId !== input.sessionId) {
        throw new OwnershipError("Answer attempt does not belong to this session");
      }
      return {
        targetType: "ANSWER_ATTEMPT" as const,
        questionInstanceId: null,
        answerAttemptId: attempt.id,
        commercialFeedbackItemId: null,
        summaryGenerationId: null,
        contextSnapshot: {
          target_type: "ANSWER_ATTEMPT",
          answer_attempt_id: attempt.id,
        },
      };
    }
    if (!input.summaryGenerationId) {
      throw new DomainError(
        ErrorCodes.INVALID_DIALOGUE_TARGET,
        "summary_generation_id is required",
      );
    }
    const generation = await queries.getSummaryGeneration(input.summaryGenerationId);
    if (!generation) {
      throw new NotFoundError("Session summary generation not found", "SUMMARY_NOT_FOUND");
    }
    if (generation.sessionId !== input.sessionId) {
      throw new OwnershipError("Session summary does not belong to this session");
    }
    return {
      targetType: "SESSION_SUMMARY" as const,
      questionInstanceId: null,
      answerAttemptId: null,
      commercialFeedbackItemId: null,
      summaryGenerationId: generation.id,
      contextSnapshot: {
        target_type: "SESSION_SUMMARY",
        summary_generation_id: generation.id,
      },
    };
  }

  async function listDialogue(userId: string, sessionId: string) {
    return persistence.listTurnsForUser(sessionId, userId);
  }

  async function listPresets() {
    return queries.listBankQuestions();
  }

  async function listUserQuestions(userId: string) {
    return queries.listUserQuestions(userId);
  }

  async function listUserJobs(userId: string) {
    return queries.listUserJobs(userId);
  }

  async function loadSessionHistory(
    userId: string,
    sessionId: string,
  ): Promise<InterviewSessionHistory> {
    const { session, instances } = await getInterviewSession(userId, sessionId);
    const turns = await listDialogue(userId, sessionId);
    const summary = await getInterviewSummary(userId, sessionId);
    const attempts: Array<{
      instance: QuestionInstanceRecord;
      attempt: AnswerAttemptRecord | null;
      transcriptText: string;
      feedback: FeedbackResult | null;
    }> = [];
    for (const instance of instances) {
      const attempt = await queries.findLatestCompletedAttempt(instance.id);
      const feedback = attempt
        ? await persistence.getCurrentFeedbackWithItemsForUser(attempt.id, userId)
        : null;
      const transcriptText = attempt
        ? await queries.getActiveRevisionText(attempt.id)
        : "";
      attempts.push({ instance, attempt, transcriptText, feedback });
    }
    return { session, instances, attempts, turns, summary };
  }

  return {
    ensurePreset,
    createInterviewSession,
    listInterviewSessions,
    getInterviewSession,
    completeSession,
    advanceQuestion,
    submitInterviewAnswer,
    saveTranscriptRevision,
    activateRevision,
    generateInterviewFeedback,
    getInterviewFeedback,
    generateInterviewSummary,
    getInterviewSummary,
    sendInterviewFollowUp,
    listDialogue,
    listPresets,
    listUserQuestions,
    listUserJobs,
    loadSessionHistory,
    knowledge,
  };
}

export type InterviewRuntime = ReturnType<typeof createInterviewRuntime>;
