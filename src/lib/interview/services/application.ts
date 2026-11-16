/**
 * Product Interview application service.
 *
 * Frozen domain semantics via Host Port v0 + Phase 3B persistence.
 * No Prisma in this file. Model calls only through InterviewModelPort.
 */
import { createHash, randomUUID } from "node:crypto";
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
import { parseJson } from "../persistence/json";
import {
  boundJdExcerpt,
  buildCoachingPrompt,
  selectDialogueHistory,
} from "./dialogueContext";
import {
  buildSummaryPrompt,
  type SummaryQuestionInput,
} from "./summaryPrompt";
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
import { guardFeedbackItem } from "../validation/feedbackGuards";
import { buildFeedbackPrompt, FEEDBACK_MAX_ITEMS } from "./feedbackPrompt";
import { groundFeedbackItem } from "./evidence";
import { loadOwnershipView, loadWritableOwnership } from "./ownership";
import { BundledKnowledgeProvider, type KnowledgeProvider } from "./knowledge";
import { SystemClock, type Clock } from "./clock";
import { VocatryaInterviewQueries } from "./hostQueries";
import { ensureCanonicalPreset } from "../presets/install";
import {
  interviewCreationPlanRef,
  resolveInterviewAiRuntime,
} from "../interviewRuntimePlan";
import {
  assembleInterviewPlanningContext,
  generateInterviewQuestionPlan,
  QUESTION_PLANNING_PROMPT_VERSION,
  truncateUtf8,
} from "./questionPlanning";

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
    /**
     * When absent/empty the session's questions are produced by AI
     * question planning against the bounded job/JD + career-material
     * context. Explicit questions remain supported for preset/historical
     * call sites.
     */
    questions?: CommercialQuestionSpec[];
    feedbackReleasePolicy?: string | null;
    jobOpportunityId?: string | null;
    jobDescriptionVersionId?: string | null;
    /**
     * Prep-goal binding for goal-driven creation. Validated upstream by
     * the prep service; the session row is born bound inside the same
     * creation transaction, and the unique index dedupes retransmits.
     */
    interviewPrepGoalId?: string | null;
    /**
     * The goal revision observed by the upstream validation. Re-checked
     * inside the creation transaction so a pause/end/new-round between
     * validation and commit aborts the bind instead of stranding it.
     */
    expectedInterviewPrepGoalRevision?: number | null;
  }) {
    const jobContext = await jobContextPort.resolveJobContext({
      requestingUserId: input.userId,
      jobOpportunityId: input.jobOpportunityId ?? null,
      jobDescriptionVersionId: input.jobDescriptionVersionId ?? null,
    });
    // Resolve the INTERVIEW AI config exactly once. The lock travels into
    // createSession's transaction so the session and its bound config are
    // one atomic write; a broken explicit assignment fails here and never
    // falls back to legacy/global. Question planning runs on this same
    // resolved runtime — no second resolve, no mid-create failover. The
    // session id is allocated up-front because a Managed resolution
    // first-binds `interview-session:<id>` before the row exists.
    const sessionId = randomUUID();
    const { plan, lock } = await resolveInterviewAiRuntime(
      input.userId,
      deps.db,
      { resourceKey: `interview-session:${sessionId}` },
    );
    if (plan.kind === "invalid") {
      throw new DomainError(
        plan.code,
        "The assigned interview AI connection is not usable",
      );
    }
    let specs: CommercialQuestionSpec[];
    if (input.questions && input.questions.length > 0) {
      specs = input.questions;
    } else {
      const planningModel = modelPort.resolveInterviewModelForPlan
        ? await modelPort.resolveInterviewModelForPlan({
            requestingUserId: input.userId,
            plan: interviewCreationPlanRef({ plan, lock }),
          })
        : await modelPort.resolveInterviewModel({
            requestingUserId: input.userId,
          });
      const context = await assembleInterviewPlanningContext(queries, {
        userId: input.userId,
        jobOpportunityId: jobContext.jobOpportunityId,
        jobDescriptionVersionId: jobContext.jobDescriptionVersionId,
      });
      const questionPlan = await generateInterviewQuestionPlan({
        model: planningModel,
        context,
        operation: {
          operationId: `interview:${sessionId}:question-plan`,
          attemptIndex: 0,
        },
      });
      specs = questionPlan.questions.map((question) => ({
        displayedText: question.text,
        sourceKind: "AI_GENERATED" as const,
        category: question.category,
        sourceMetadata: {
          rationale: question.rationale,
          promptVersion: QUESTION_PLANNING_PROMPT_VERSION,
        },
      }));
    }
    const prepared: CommercialQuestionSpec[] = [];
    for (const spec of specs) {
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
    return persistence.createSession({
      actorUserId: input.userId,
      id: sessionId,
      coachingMode: input.coachingMode,
      feedbackReleasePolicy: input.feedbackReleasePolicy,
      knowledgeBaseVersion: knowledge.version,
      jobOpportunityId: jobContext.jobOpportunityId,
      jobDescriptionVersionId: jobContext.jobDescriptionVersionId,
      interviewPrepGoalId: input.interviewPrepGoalId ?? null,
      expectedInterviewPrepGoalRevision:
        input.expectedInterviewPrepGoalRevision ?? null,
      createdVia: "USER",
      resolvedConnectionId: lock.resolvedConnectionId ?? null,
      resolvedModel: lock.resolvedModel ?? null,
      managedAiProvenance: lock.managedAiProvenance ?? null,
      questions: prepared,
    });
  }

  async function listInterviewSessions(userId: string) {
    await persistence.ensureUserExists(userId);
    return queries.listSessions(userId);
  }

  /** Product-facing history rows: session + derived readable metadata. */
  async function listInterviewSessionCards(userId: string) {
    await persistence.ensureUserExists(userId);
    return queries.listSessionCards(userId);
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

  /**
   * Server-side advance for the one-question-at-a-time flow. Clients
   * never write currentQuestionInstanceId directly — this validates that
   * the current question was answered and has a succeeded feedback before
   * moving to the next instance by displayOrder.
   */
  async function advanceToNextQuestion(input: {
    userId: string;
    sessionId: string;
  }): Promise<
    | { advanced: true; session: SessionRecord; nextInstanceId: string }
    | { advanced: false; session: SessionRecord; reason: "last_question" }
  > {
    await loadWritableOwnership(ownershipPort, input.userId, input.sessionId);
    const session = await persistence.getSessionForUser(
      input.sessionId,
      input.userId,
    );
    const instances = await persistence.listInstancesForUser(
      input.sessionId,
      input.userId,
    );
    if (!instances.length) {
      throw new DomainError("INVALID_QUESTIONS", "Session has no questions");
    }
    const current =
      instances.find((row) => row.id === session.currentQuestionInstanceId) ??
      instances[0];
    const attempt = await queries.findLatestCompletedAttempt(current.id);
    if (!attempt) {
      throw new DomainError(
        "QUESTION_NOT_READY",
        "Current question has no completed answer",
      );
    }
    const feedback = await queries.findCurrentSucceededFeedback(attempt.id);
    if (!feedback) {
      throw new DomainError(
        "QUESTION_NOT_READY",
        "Current question has no succeeded feedback",
      );
    }
    const next = instances.find(
      (row) => row.displayOrder > current.displayOrder && row.status !== "SKIPPED",
    );
    if (!next) {
      return { advanced: false, session, reason: "last_question" };
    }
    await persistence.updateInstanceForUser(next.id, input.userId, {
      status: "IN_PROGRESS",
    });
    const updated = await persistence.updateSessionForUser(
      input.sessionId,
      input.userId,
      {
        currentQuestionInstanceId: next.id,
        status: session.status === "DRAFT" ? "IN_PROGRESS" : session.status,
        startedAt: session.startedAt ?? clock.now(),
      },
    );
    return { advanced: true, session: updated, nextInstanceId: next.id };
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
    // First submitted answer flips a DRAFT session into IN_PROGRESS.
    const session = await persistence.getSessionForUser(
      attempt.sessionId,
      input.userId,
    );
    if (session.status === "DRAFT") {
      await persistence.updateSessionForUser(attempt.sessionId, input.userId, {
        status: "IN_PROGRESS",
        startedAt: session.startedAt ?? now,
      });
    }
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
      // Optional bounded JD context: when the session targets a role the
      // prompt may reference it, but transcript evidence stays the
      // authority for every excerpt.
      let jdContext: string | null = null;
      if (session.jobOpportunityId && session.jobDescriptionVersionId) {
        const job = await queries.getJobPlanningContext({
          jobOpportunityId: session.jobOpportunityId,
          jobDescriptionVersionId: session.jobDescriptionVersionId,
        });
        if (job) {
          jdContext = truncateUtf8(
            `role: ${job.jobTitle}${job.companyName ? ` @ ${job.companyName}` : ""}\n${job.jdRawContent}`,
            2_000,
          );
        }
      }
      const built = buildFeedbackPrompt({
        questionText: instance.displayedText,
        transcriptText: revisionRow.fullText,
        taxonomyLabels: knowledge.taxonomyLabels?.() ?? [],
        jdContext,
      });

      // One full-regeneration repair: any contract/guard/grounding
      // failure discards the whole candidate output and regenerates once.
      // Rejected payloads are never persisted.
      const MAX_REGENERATIONS = 1;
      let lastError: unknown = null;
      let validated: ReturnType<typeof validateAndGround> | null = null;

      function validateAndGround(raw: unknown) {
        const payload = raw as { feedbackItems?: unknown[] };
        const sourceItems = Array.isArray(payload.feedbackItems)
          ? payload.feedbackItems
          : [];
        const items = sourceItems.slice(0, FEEDBACK_MAX_ITEMS).map((item) => {
          const structural = validateFeedbackItem(item);
          guardFeedbackItem(structural);
          return groundFeedbackItem(revisionRow.fullText, structural);
        });
        return items;
      }

      for (let cycle = 0; cycle <= MAX_REGENERATIONS; cycle += 1) {
        try {
          const raw = await model.generateJson(built, {
            operationId: `interview:${attempt.sessionId}:feedback:${generation.id}`,
            attemptIndex: cycle,
          });
          const items = validateAndGround(raw);
          if (!items.length) {
            throw new DomainError(
              ErrorCodes.EMPTY_ITEMS,
              "Commercial feedback generation produced no items",
            );
          }
          validated = items;
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (validated == null) {
        throw lastError instanceof Error
          ? lastError
          : new DomainError(ErrorCodes.GENERATION_FAILED, "Feedback generation failed");
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
      // Assemble the real per-question content — question text, the
      // transcript revision that feedback ran on, and the published
      // feedback items — instead of ids/hashes.
      const questions: SummaryQuestionInput[] = [];
      for (const entry of evidence) {
        const instance = await persistence.getInstanceForUser(
          entry.questionInstanceId,
          input.userId,
        );
        const revision = await persistence.getRevisionForUser(
          entry.inputRevisionId,
          input.userId,
        );
        const items = await queries.listFeedbackItemsForGeneration(
          entry.feedbackGenerationId,
        );
        questions.push({
          questionText: instance.displayedText,
          transcriptText: revision.fullText,
          feedbackItems: items.map((item) => {
            const itemEvidence = parseJson<{
              transcriptExcerpt?: string;
              problemStatement?: string;
            }>(item.evidence, {});
            const itemExplanation = parseJson<{ underlyingCause?: string }>(
              item.explanation,
              {},
            );
            return {
              problemLabel: item.problemLabel,
              problemStatement: itemEvidence.problemStatement ?? null,
              evidenceExcerpt: itemEvidence.transcriptExcerpt ?? null,
              underlyingCause: itemExplanation.underlyingCause ?? null,
              suggestion: item.suggestion,
            };
          }),
        });
      }
      let jobContext: {
        jobTitle: string;
        companyName: string | null;
        jdExcerpt: string;
      } | null = null;
      if (session.jobOpportunityId && session.jobDescriptionVersionId) {
        const job = await queries.getJobPlanningContext({
          jobOpportunityId: session.jobOpportunityId,
          jobDescriptionVersionId: session.jobDescriptionVersionId,
        });
        if (job) {
          jobContext = {
            jobTitle: job.jobTitle,
            companyName: job.companyName,
            jdExcerpt: job.jdRawContent,
          };
        }
      }
      const raw = await model.generateJson(
        buildSummaryPrompt({ job: jobContext, questions }),
        {
          operationId: `interview:${session.id}:summary:${generation.id}`,
          attemptIndex: 0,
        },
      );
      const payload = raw as {
        bodyText?: string;
        structuredPayload?: unknown;
      };
      const bodyText = String(payload.bodyText ?? "").trim();
      if (!bodyText) {
        throw new DomainError(ErrorCodes.INVALID_SUMMARY_OUTPUT, "body_text is required");
      }
      // Publish + session completion in one short transaction: a failed
      // or rejected generation can never leave a COMPLETED session
      // without a summary, and the model call stays outside the tx.
      const now = clock.now();
      return persistence.publishSummaryForUser({
        actorUserId: input.userId,
        generationId: generation.id,
        evidence,
        bodyText,
        structuredPayload: payload.structuredPayload ?? null,
        sessionCompletion: {
          status: session.coachingMode === "MOCK" ? "COACHING" : "COMPLETED",
          completedAt: now,
          feedbackReleasedAt: session.feedbackReleasedAt ?? now,
        },
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
    // Real interview content + bounded history — never ids alone. The
    // persisted contextSnapshot keeps provenance identifiers only; the
    // untrusted content lives in the prompt, not in the DB snapshot.
    const context = await assembleDialogueContext(input.userId, input.sessionId, target);
    const turns = await persistence.listTurnsForUser(input.sessionId, input.userId);
    const history = selectDialogueHistory(turns);
    const built = buildCoachingPrompt({
      targetType: target.targetType,
      job: context.job,
      questionText: context.questionText,
      answerTranscript: context.answerTranscript,
      feedbackItem: context.feedbackItem,
      relatedFeedback: context.relatedFeedback,
      summaryText: context.summaryText,
      history,
      userText: input.userText,
    });
    // Each user message is a new business operation — the ordinal plus a
    // content hash make the identity unique per turn and stable across a
    // retried submission of the same message.
    const turnHash = createHash("sha256")
      .update(`${target.targetType}:${input.userText}`)
      .digest("hex")
      .slice(0, 16);
    const raw = await model.generateJson(built, {
      operationId: `interview:${input.sessionId}:dialogue:${turns.length}:${turnHash}`,
      attemptIndex: 0,
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

  /**
   * Resolve a validated dialogue target into real interview content for
   * the coaching prompt. Only provenance ids persist on the turn; the
   * transcript/question/feedback text goes to the model only.
   */
  async function assembleDialogueContext(
    userId: string,
    sessionId: string,
    target: {
      targetType: DialogueTargetType;
      questionInstanceId: string | null;
      answerAttemptId: string | null;
      commercialFeedbackItemId: string | null;
      summaryGenerationId: string | null;
    },
  ): Promise<{
    job: { jobTitle: string; companyName: string | null; jdExcerpt: string } | null;
    questionText: string | null;
    answerTranscript: string | null;
    feedbackItem: {
      problemLabel: string;
      problemStatement: string | null;
      evidenceExcerpt: string | null;
      underlyingCause: string | null;
      performanceImpact: string | null;
      suggestion: string;
    } | null;
    relatedFeedback: Array<{ problemLabel: string; suggestion: string }> | null;
    summaryText: string | null;
  }> {
    const session = await persistence.getSessionForUser(sessionId, userId);
    const context = {
      job: null as {
        jobTitle: string;
        companyName: string | null;
        jdExcerpt: string;
      } | null,
      questionText: null as string | null,
      answerTranscript: null as string | null,
      feedbackItem: null as {
        problemLabel: string;
        problemStatement: string | null;
        evidenceExcerpt: string | null;
        underlyingCause: string | null;
        performanceImpact: string | null;
        suggestion: string;
      } | null,
      relatedFeedback: null as Array<{
        problemLabel: string;
        suggestion: string;
      }> | null,
      summaryText: null as string | null,
    };

    if (session.jobOpportunityId && session.jobDescriptionVersionId) {
      const job = await queries.getJobPlanningContext({
        jobOpportunityId: session.jobOpportunityId,
        jobDescriptionVersionId: session.jobDescriptionVersionId,
      });
      if (job) {
        context.job = {
          jobTitle: job.jobTitle,
          companyName: job.companyName,
          jdExcerpt: boundJdExcerpt(job.jdRawContent),
        };
      }
    }

    const loadAnswerBundle = async (instanceId: string) => {
      const instance = await persistence.getInstanceForUser(instanceId, userId);
      const attempt = await queries.findLatestCompletedAttempt(instance.id);
      const transcript = attempt
        ? await queries.getActiveRevisionText(attempt.id)
        : null;
      const generation = attempt
        ? await queries.findCurrentSucceededFeedback(attempt.id)
        : null;
      const items = generation
        ? await queries.listFeedbackItemsForGeneration(generation.id)
        : [];
      return { instance, attempt, transcript, generation, items };
    };

    if (target.targetType === "FEEDBACK_ITEM" && target.commercialFeedbackItemId) {
      const item = await queries.getFeedbackItem(target.commercialFeedbackItemId);
      if (!item) return context;
      const generation = await queries.getFeedbackGeneration(item.generationId);
      if (!generation) return context;
      const bundle = await loadAnswerBundle(generation.questionInstanceId);
      context.questionText = bundle.instance.displayedText;
      context.answerTranscript = bundle.transcript;
      const evidence = parseJson<{
        transcriptExcerpt?: string;
        problemStatement?: string;
      }>(item.evidence, {});
      const explanation = parseJson<{
        underlyingCause?: string;
        performanceImpact?: string;
      }>(item.explanation, {});
      context.feedbackItem = {
        problemLabel: item.problemLabel,
        problemStatement: evidence.problemStatement ?? null,
        evidenceExcerpt: evidence.transcriptExcerpt ?? null,
        underlyingCause: explanation.underlyingCause ?? null,
        performanceImpact: explanation.performanceImpact ?? null,
        suggestion: item.suggestion,
      };
      const related = bundle.items
        .filter((row) => row.id !== item.id)
        .map((row) => ({ problemLabel: row.problemLabel, suggestion: row.suggestion }));
      context.relatedFeedback = related.length ? related : null;
      return context;
    }

    if (target.targetType === "QUESTION_INSTANCE" && target.questionInstanceId) {
      const bundle = await loadAnswerBundle(target.questionInstanceId);
      context.questionText = bundle.instance.displayedText;
      context.answerTranscript = bundle.transcript;
      const related = bundle.items.map((row) => ({
        problemLabel: row.problemLabel,
        suggestion: row.suggestion,
      }));
      context.relatedFeedback = related.length ? related : null;
      return context;
    }

    if (target.targetType === "ANSWER_ATTEMPT" && target.answerAttemptId) {
      const attempt = await persistence.getAttemptForUser(
        target.answerAttemptId,
        userId,
      );
      const bundle = await loadAnswerBundle(attempt.questionInstanceId);
      context.questionText = bundle.instance.displayedText;
      context.answerTranscript = bundle.transcript;
      const related = bundle.items.map((row) => ({
        problemLabel: row.problemLabel,
        suggestion: row.suggestion,
      }));
      context.relatedFeedback = related.length ? related : null;
      return context;
    }

    if (target.targetType === "SESSION_SUMMARY" && target.summaryGenerationId) {
      const generation = await queries.getSummaryGeneration(
        target.summaryGenerationId,
      );
      context.summaryText = generation?.bodyText ?? null;
      return context;
    }

    // SESSION: current question context + bounded job/JD + current summary.
    if (session.currentQuestionInstanceId) {
      try {
        const bundle = await loadAnswerBundle(session.currentQuestionInstanceId);
        context.questionText = bundle.instance.displayedText;
        context.answerTranscript = bundle.transcript;
        const related = bundle.items.map((row) => ({
          problemLabel: row.problemLabel,
          suggestion: row.suggestion,
        }));
        context.relatedFeedback = related.length ? related : null;
      } catch {
        // Current question may be absent on historical sessions — the
        // session-level context alone is still a valid dialogue target.
      }
    }
    const summary = await queries.getCurrentSummaryGeneration(sessionId);
    context.summaryText = summary?.bodyText ?? null;
    return context;
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
    listInterviewSessionCards,
    getInterviewSession,
    completeSession,
    advanceToNextQuestion,
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
