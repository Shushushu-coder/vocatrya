/**
 * Phase 3B — Vocatrya Interview persistence adapter (HOST_IMPLEMENT).
 *
 * Binds frozen Interview domain contracts to the Vocatrya Prisma
 * persistence graph (Phase 3A schema, 14 models). This is the ONLY place
 * that may import `@prisma/client`, call `$transaction`, or know the
 * Vocatrya storage shape. Future Phase 3C services depend only on the
 * typed port methods below plus Host Port v0.
 *
 * Repository scope (frozen):
 * - persistence + ownership-safe lookup + transaction-safe mutation
 * - frozen contract mapping (snapshot verbatim, nullable source, provenance)
 * Explicitly NOT here: AI prompt selection, feedback/summary/dialogue
 * generation, knowledge retrieval, preset workflows, ASR/transcript rewrite.
 *
 * Ownership closure: every public method takes `actorUserId` where a user
 * boundary exists, loads the parent `InterviewSession`, and rejects
 * cross-user access with SESSION_FORBIDDEN (job cross-user uses
 * CROSS_USER_RELATION per frozen JobContext port). Child writes never trust
 * a bare id; they validate the full parent chain (`attempt.sessionId`,
 * `instance.sessionId`, `revision.answerAttemptId`, …).
 *
 * Transaction boundaries (frozen behaviours, mechanism adapter-internal):
 * - AtomicSessionCreation via `$transaction`
 * - AttemptNumbering via `$transaction` (max+1 + promotion)
 * - ImmutableTranscriptHistory via `$transaction` (revision + pointer)
 * - AtomicFeedbackPromotion via `$transaction`
 * - GuardedSummaryPromotion via `$transaction` + newer-current check
 *
 * Provenance: PORT_SOURCE_COMMIT a7c8d9012896ba013e3bb632de1d5ff636b08233,
 * SPEC_TAG interview-vocatrya-spec-v1, SPEC_COMMIT
 * a7a8e2ed75e3797c207851f62e3a13732d405f6d.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ANSWER_INPUT_TYPES,
  COACHING_MODES,
  DIALOGUE_TARGET_TYPES,
  FEEDBACK_RELEASE_POLICIES,
  DEFAULT_FEEDBACK_RELEASE_POLICY,
  QUESTION_SOURCE_KINDS,
  REVISION_KINDS,
  ALIGNMENT_STATUSES,
} from "./interviewEnums";
import type {
  AnswerAttemptRecord,
  AnswerInputArtifactRecord,
  CoachingConversationRecord,
  DialogueTurnRecord,
  FeedbackGenerationRecord,
  FeedbackItemRecord,
  QuestionInstanceRecord,
  SessionRecord,
  SessionSummaryGenerationRecord,
  SessionSummaryInputRecord,
  TranscriptRecord,
  TranscriptRevisionRecord,
} from "./interviewRecords";
import {
  ArchivedSessionError,
  DomainError,
  NotFoundError,
  OwnershipError,
} from "./interviewErrors";
import { stringifyJson } from "./json";

const FORBIDDEN_SNAPSHOT_KEYS = [
  "transcript",
  "fullText",
  "full_text",
  "prompt",
  "providerPayload",
  "provider_payload",
  "rawContent",
] as const;

function assertProvenanceSnapshot(snapshot: Record<string, unknown>): void {
  for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
    if (key in snapshot) {
      throw new DomainError(
        "CONTEXT_SNAPSHOT_FORBIDDEN_PAYLOAD",
        `contextSnapshot must not contain ${key}`,
      );
    }
  }
}

function normaliseId(id: string | null | undefined): string | null {
  if (id == null) return null;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed === "" ? null : trimmed;
}

function assertActor(actorUserId: string): void {
  if (!actorUserId || typeof actorUserId !== "string" || !actorUserId.trim()) {
    throw new OwnershipError("Session is not owned by the current user");
  }
}

function isArchivedRow(row: { status: string; archivedAt: Date | null }): boolean {
  return row.status === "ARCHIVED" || row.archivedAt != null;
}

function toDomainError(error: unknown, fallbackCode: string): DomainError {
  if (error instanceof DomainError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && code) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = new DomainError(code, message);
    (mapped as { cause?: unknown }).cause = error;
    return mapped;
  }
  const message = error instanceof Error ? error.message : String(error);
  const mapped = new DomainError(fallbackCode, message);
  (mapped as { cause?: unknown }).cause = error;
  return mapped;
}

function isPrismaNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2025";
}

export interface SessionQuestionInput {
  displayedText: string;
  sourceKind?: string | null;
  category?: string | null;
  sourceQuestionId?: string | null;
  referenceAnswerSnapshot?: string | null;
  sourceMetadata?: Record<string, unknown> | string | null;
}

export interface CreateSessionInput {
  actorUserId: string;
  coachingMode: string;
  feedbackReleasePolicy?: string | null;
  knowledgeBaseVersion: string;
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
  createdVia?: string | null;
  // AI lock captured at creation (see sessionAiLock.ts). Written inside
  // the same $transaction as the session row so the lock and the session
  // share one atomic boundary.
  resolvedConnectionId?: string | null;
  resolvedModel?: string | null;
  questions: SessionQuestionInput[];
}

export interface FeedbackItemInput {
  problemLabel: string;
  evidence: string | Record<string, unknown>;
  explanation: string | Record<string, unknown>;
  suggestion: string;
}

export interface SummaryEvidenceInput {
  questionInstanceId: string;
  feedbackGenerationId: string;
  inputOrder: number;
}

/** Minimal Prisma surface used by this adapter (structural, no ORM leak). */
export type InterviewPrismaDb = PrismaClient;

export class VocatryaInterviewPersistence {
  constructor(private readonly db: InterviewPrismaDb) {}

  // -- Session -------------------------------------------------------------

  async ensureUserExists(actorUserId: string): Promise<void> {
    assertActor(actorUserId);
    const user = await this.db.user.findUnique({ where: { id: actorUserId } });
    if (!user) throw new NotFoundError("User not found", "USER_NOT_FOUND");
  }

  private async resolveJobPair(
    db: InterviewPrismaDb,
    actorUserId: string,
    jobOpportunityId: string | null | undefined,
    jobDescriptionVersionId: string | null | undefined,
  ): Promise<{ jobOpportunityId: string | null; jobDescriptionVersionId: string | null }> {
    const jobId = normaliseId(jobOpportunityId);
    const jdId = normaliseId(jobDescriptionVersionId);
    if (!jobId && !jdId) return { jobOpportunityId: null, jobDescriptionVersionId: null };
    if (Boolean(jobId) !== Boolean(jdId)) {
      throw new DomainError(
        "JOB_PAIR_REQUIRED",
        "jobOpportunityId and jobDescriptionVersionId must both be set or both be null",
      );
    }
    const job = await (db as PrismaClient).jobOpportunity.findUnique({
      where: { id: jobId as string },
    });
    if (!job) throw new NotFoundError("Job opportunity not found", "JOB_NOT_FOUND");
    if (job.userId !== actorUserId) {
      throw new DomainError("CROSS_USER_RELATION", "Cross-user relation rejected");
    }
    const jd = await (db as PrismaClient).jobDescriptionVersion.findUnique({
      where: { id: jdId as string },
    });
    if (!jd) throw new NotFoundError("Job description version not found", "JD_NOT_FOUND");
    if (jd.jobOpportunityId !== job.id) {
      throw new DomainError("JOB_JD_MISMATCH", "JD does not belong to the given job");
    }
    return { jobOpportunityId: job.id, jobDescriptionVersionId: jd.id };
  }

  private async resolveQuestionReference(
    db: InterviewPrismaDb,
    actorUserId: string,
    sourceQuestionId: string | null | undefined,
    overrideAnswer: string | null | undefined,
  ): Promise<{ sourceQuestionId: string | null; referenceAnswerSnapshot: string | null }> {
    const rawId = normaliseId(sourceQuestionId);
    if (!rawId) {
      return { sourceQuestionId: null, referenceAnswerSnapshot: overrideAnswer ?? null };
    }
    const row = await (db as PrismaClient).question.findUnique({
      where: { id: rawId },
    });
    if (!row || (row as { deletedAt?: Date | null }).deletedAt != null) {
      throw new NotFoundError("Question not found", "QUESTION_NOT_FOUND");
    }
    if ((row as { createdBy: string }).createdBy !== actorUserId) {
      const shared = await (db as PrismaClient).questionBankItem.findFirst({
        where: { questionId: row.id },
      });
      if (!shared) {
        throw new OwnershipError("Question is not owned by the current user");
      }
    }
    const fallback = ((row as { answer?: string | null }).answer ?? null) as string | null;
    return {
      sourceQuestionId: row.id,
      referenceAnswerSnapshot: overrideAnswer ?? fallback,
    };
  }

  async createSession(
    input: CreateSessionInput,
  ): Promise<{ session: SessionRecord; instances: QuestionInstanceRecord[] }> {
    assertActor(input.actorUserId);
    if (!COACHING_MODES.includes(input.coachingMode as (typeof COACHING_MODES)[number])) {
      throw new DomainError("INVALID_COACHING_MODE", "coaching_mode must be PRACTICE or MOCK");
    }
    if (!Array.isArray(input.questions) || input.questions.length === 0) {
      throw new DomainError("INVALID_QUESTIONS", "A session requires at least one question");
    }
    const policy =
      input.feedbackReleasePolicy ??
      DEFAULT_FEEDBACK_RELEASE_POLICY[input.coachingMode as keyof typeof DEFAULT_FEEDBACK_RELEASE_POLICY];
    if (
      !FEEDBACK_RELEASE_POLICIES.includes(
        policy as (typeof FEEDBACK_RELEASE_POLICIES)[number],
      )
    ) {
      throw new DomainError(
        "INVALID_FEEDBACK_RELEASE_POLICY",
        "feedback_release_policy must be IMMEDIATE or ON_SESSION_COMPLETE",
      );
    }
    if (!input.knowledgeBaseVersion || !input.knowledgeBaseVersion.trim()) {
      throw new DomainError("INVALID_QUESTIONS", "knowledgeBaseVersion is required");
    }
    await this.ensureUserExists(input.actorUserId);
    const jobPair = await this.resolveJobPair(
      this.db,
      input.actorUserId,
      input.jobOpportunityId,
      input.jobDescriptionVersionId,
    );

    const prepared: Array<{
      instanceId: string;
      sourceQuestionId: string | null;
      displayOrder: number;
      displayedText: string;
      sourceKind: string;
      category: string | null;
      sourceMetadataJson: string | null;
      referenceAnswerSnapshot: string | null;
    }> = [];
    for (const [index, spec] of input.questions.entries()) {
      const displayedText =
        typeof spec.displayedText === "string" ? spec.displayedText.trim() : "";
      if (!displayedText) {
        throw new DomainError("INVALID_QUESTIONS", "displayed_text is required");
      }
      const kind = (spec.sourceKind ?? "USER_PROVIDED") as string;
      if (!QUESTION_SOURCE_KINDS.includes(kind as (typeof QUESTION_SOURCE_KINDS)[number])) {
        throw new DomainError("INVALID_SOURCE_KIND", "Unsupported question source_kind");
      }
      const resolved = await this.resolveQuestionReference(
        this.db,
        input.actorUserId,
        spec.sourceQuestionId,
        spec.referenceAnswerSnapshot,
      );
      let sourceMetadataJson: string | null = null;
      if (spec.sourceMetadata != null) {
        sourceMetadataJson =
          typeof spec.sourceMetadata === "string"
            ? spec.sourceMetadata
            : stringifyJson(spec.sourceMetadata);
      }
      prepared.push({
        instanceId: randomUUID(),
        sourceQuestionId: resolved.sourceQuestionId,
        displayOrder: index,
        displayedText,
        sourceKind: kind,
        category: spec.category ?? null,
        sourceMetadataJson,
        referenceAnswerSnapshot: resolved.referenceAnswerSnapshot,
      });
    }

    const sessionId = randomUUID();
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const session = await delegated.interviewSession.create({
          data: {
            id: sessionId,
            userId: input.actorUserId,
            status: "DRAFT",
            coachingMode: input.coachingMode,
            feedbackReleasePolicy: policy,
            knowledgeBaseVersion: input.knowledgeBaseVersion,
            jobOpportunityId: jobPair.jobOpportunityId,
            jobDescriptionVersionId: jobPair.jobDescriptionVersionId,
            createdVia: input.createdVia ?? "USER",
            resolvedConnectionId: input.resolvedConnectionId ?? null,
            resolvedModel: input.resolvedModel ?? null,
          },
        });
        const instances: QuestionInstanceRecord[] = [];
        for (const spec of prepared) {
          const instance = await delegated.questionInstance.create({
            data: {
              id: spec.instanceId,
              sessionId: session.id,
              sourceQuestionId: spec.sourceQuestionId,
              displayOrder: spec.displayOrder,
              displayedText: spec.displayedText,
              sourceKind: spec.sourceKind,
              category: spec.category,
              sourceMetadata: spec.sourceMetadataJson,
              referenceAnswerSnapshot: spec.referenceAnswerSnapshot,
              status: "PENDING",
            },
          });
          instances.push(instance as unknown as QuestionInstanceRecord);
        }
        const updated = await delegated.interviewSession.update({
          where: { id: session.id },
          data: { currentQuestionInstanceId: instances[0].id },
        });
        return {
          session: updated as unknown as SessionRecord,
          instances,
        };
      });
    } catch (error) {
      throw toDomainError(error, "INVALID_QUESTIONS");
    }
  }

  private async loadOwnedSession(
    db: InterviewPrismaDb,
    sessionId: string,
    actorUserId: string,
  ): Promise<SessionRecord> {
    assertActor(actorUserId);
    const session = await (db as PrismaClient).interviewSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundError();
    if (session.userId !== actorUserId) {
      throw new OwnershipError("Session is not owned by the current user");
    }
    return session as unknown as SessionRecord;
  }

  async getSessionForUser(sessionId: string, actorUserId: string): Promise<SessionRecord> {
    return this.loadOwnedSession(this.db, sessionId, actorUserId);
  }

  async updateSessionForUser(
    sessionId: string,
    actorUserId: string,
    patch: Partial<
      Pick<
        SessionRecord,
        | "status"
        | "currentQuestionInstanceId"
        | "startedAt"
        | "completedAt"
        | "archivedAt"
        | "statusBeforeArchive"
        | "feedbackReleasedAt"
      >
    >,
    opts: { allowArchivedWrite?: boolean } = {},
  ): Promise<SessionRecord> {
    const session = await this.loadOwnedSession(this.db, sessionId, actorUserId);
    if (!opts.allowArchivedWrite && isArchivedRow(session)) {
      throw new ArchivedSessionError();
    }
    if (patch.currentQuestionInstanceId != null) {
      const instance = await this.db.questionInstance.findUnique({
        where: { id: patch.currentQuestionInstanceId },
      });
      if (!instance || instance.sessionId !== session.id) {
        throw new OwnershipError("Question instance does not belong to this session");
      }
    }
    try {
      const row = await this.db.interviewSession.update({
        where: { id: session.id },
        data: patch as never,
      });
      return row as unknown as SessionRecord;
    } catch (error) {
      if (isPrismaNotFound(error)) throw new NotFoundError();
      throw toDomainError(error, "SESSION_NOT_FOUND");
    }
  }

  async listInstancesForUser(
    sessionId: string,
    actorUserId: string,
  ): Promise<QuestionInstanceRecord[]> {
    await this.loadOwnedSession(this.db, sessionId, actorUserId);
    const rows = await this.db.questionInstance.findMany({
      where: { sessionId },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    return rows as unknown as QuestionInstanceRecord[];
  }

  async getInstanceForUser(
    instanceId: string,
    actorUserId: string,
  ): Promise<QuestionInstanceRecord> {
    assertActor(actorUserId);
    const instance = await this.db.questionInstance.findUnique({
      where: { id: instanceId },
    });
    if (!instance) throw new NotFoundError("Question instance not found", "QUESTION_NOT_FOUND");
    await this.loadOwnedSession(this.db, instance.sessionId, actorUserId);
    return instance as unknown as QuestionInstanceRecord;
  }

  async updateInstanceForUser(
    instanceId: string,
    actorUserId: string,
    patch: Partial<Pick<QuestionInstanceRecord, "status">>,
  ): Promise<QuestionInstanceRecord> {
    const instance = await this.getInstanceForUser(instanceId, actorUserId);
    const session = await this.loadOwnedSession(this.db, instance.sessionId, actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    try {
      const row = await this.db.questionInstance.update({
        where: { id: instance.id },
        data: patch as never,
      });
      return row as unknown as QuestionInstanceRecord;
    } catch (error) {
      if (isPrismaNotFound(error)) {
        throw new NotFoundError("Question instance not found", "QUESTION_NOT_FOUND");
      }
      throw toDomainError(error, "INVALID_QUESTIONS");
    }
  }

  // -- Attempt / artifact / transcript ---------------------------------------

  private async loadOwnedAttempt(
    db: InterviewPrismaDb,
    attemptId: string,
    actorUserId: string,
  ): Promise<AnswerAttemptRecord> {
    assertActor(actorUserId);
    const attempt = await (db as PrismaClient).answerAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!attempt || attempt.deletedAt) {
      throw new NotFoundError("Answer attempt not found", "ATTEMPT_NOT_FOUND");
    }
    await this.loadOwnedSession(db, attempt.sessionId, actorUserId);
    return attempt as unknown as AnswerAttemptRecord;
  }

  async createAttemptForUser(input: {
    actorUserId: string;
    questionInstanceId: string;
    inputType: string;
    startedAt?: Date;
  }): Promise<AnswerAttemptRecord> {
    if (!ANSWER_INPUT_TYPES.includes(input.inputType as (typeof ANSWER_INPUT_TYPES)[number])) {
      throw new DomainError("INVALID_INPUT_TYPE", "input_type must be TEXT or AUDIO");
    }
    const instance = await this.getInstanceForUser(input.questionInstanceId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, instance.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const now = input.startedAt ?? new Date();
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const max = await delegated.answerAttempt.aggregate({
          where: { questionInstanceId: instance.id },
          _max: { attemptNumber: true },
        });
        const attempt = await delegated.answerAttempt.create({
          data: {
            id: randomUUID(),
            questionInstanceId: instance.id,
            sessionId: instance.sessionId,
            attemptNumber: (max._max.attemptNumber ?? 0) + 1,
            inputType: input.inputType,
            status: "STARTED",
            startedAt: now,
          },
        });
        if (instance.status === "PENDING") {
          await delegated.questionInstance.update({
            where: { id: instance.id },
            data: { status: "IN_PROGRESS" },
          });
        }
        const live = await delegated.interviewSession.findUnique({
          where: { id: instance.sessionId },
        });
        if (live && live.status === "DRAFT") {
          await delegated.interviewSession.update({
            where: { id: live.id },
            data: { status: "IN_PROGRESS", startedAt: live.startedAt ?? now },
          });
        }
        return attempt as unknown as AnswerAttemptRecord;
      });
    } catch (error) {
      throw toDomainError(error, "ATTEMPT_CONFLICT");
    }
  }

  async getAttemptForUser(attemptId: string, actorUserId: string): Promise<AnswerAttemptRecord> {
    return this.loadOwnedAttempt(this.db, attemptId, actorUserId);
  }

  async createArtifactForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    inputType: string;
    role: string;
    textContent?: string | null;
    filePath?: string | null;
    fileFormat?: string | null;
    durationSeconds?: number | null;
    fileSizeBytes?: number | null;
  }): Promise<AnswerInputArtifactRecord> {
    const attempt = await this.loadOwnedAttempt(this.db, input.answerAttemptId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    try {
      const row = await this.db.answerInputArtifact.create({
        data: {
          id: randomUUID(),
          answerAttemptId: attempt.id,
          sessionId: attempt.sessionId,
          inputType: input.inputType,
          role: input.role,
          textContent: input.textContent ?? null,
          filePath: input.filePath ?? null,
          fileFormat: input.fileFormat ?? null,
          durationSeconds: input.durationSeconds ?? null,
          fileSizeBytes: input.fileSizeBytes ?? null,
        },
      });
      return row as unknown as AnswerInputArtifactRecord;
    } catch (error) {
      throw toDomainError(error, "INVALID_TEXT");
    }
  }

  async createTranscriptForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    fullText: string;
    segments?: string | null;
    sourceArtifactId?: string | null;
    asrModel?: string | null;
    asrStatus?: string | null;
  }): Promise<TranscriptRecord> {
    const attempt = await this.loadOwnedAttempt(this.db, input.answerAttemptId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const existing = await this.db.transcript.findFirst({
      where: { answerAttemptId: attempt.id },
    });
    if (existing) {
      throw new DomainError("TRANSCRIPT_EXISTS", "Transcript already exists for this attempt");
    }
    try {
      const row = await this.db.transcript.create({
        data: {
          id: randomUUID(),
          sessionId: attempt.sessionId,
          answerAttemptId: attempt.id,
          sourceArtifactId: input.sourceArtifactId ?? null,
          fullText: input.fullText,
          segments: input.segments ?? "[]",
          asrModel: input.asrModel ?? null,
          asrStatus: input.asrStatus ?? null,
        },
      });
      return row as unknown as TranscriptRecord;
    } catch (error) {
      throw toDomainError(error, "TRANSCRIPT_EXISTS");
    }
  }

  async getTranscriptForUser(
    transcriptId: string,
    actorUserId: string,
  ): Promise<TranscriptRecord> {
    assertActor(actorUserId);
    const transcript = await this.db.transcript.findUnique({
      where: { id: transcriptId },
    });
    if (!transcript) throw new NotFoundError("Transcript not found", "TRANSCRIPT_NOT_FOUND");
    await this.loadOwnedSession(this.db, transcript.sessionId, actorUserId);
    return transcript as unknown as TranscriptRecord;
  }

  async createOriginalRevisionForUser(input: {
    actorUserId: string;
    transcriptId: string;
    answerAttemptId: string;
    revisionKind: string;
    alignmentStatus: string;
    contentHash: string;
    createdVia?: string | null;
  }): Promise<TranscriptRevisionRecord> {
    if (!REVISION_KINDS.includes(input.revisionKind as (typeof REVISION_KINDS)[number])) {
      throw new DomainError("INVALID_REVISION_KIND", "Unsupported revision_kind");
    }
    if (
      !ALIGNMENT_STATUSES.includes(input.alignmentStatus as (typeof ALIGNMENT_STATUSES)[number])
    ) {
      throw new DomainError("INVALID_ALIGNMENT_STATUS", "Unsupported alignment_status");
    }
    if (!input.contentHash) {
      throw new DomainError("INVALID_TEXT", "contentHash is required");
    }
    const transcript = await this.getTranscriptForUser(input.transcriptId, input.actorUserId);
    if (transcript.answerAttemptId !== input.answerAttemptId) {
      throw new DomainError(
        "TRANSCRIPT_ATTEMPT_MISMATCH",
        "Transcript is not bound to this answer attempt",
      );
    }
    const attempt = await this.loadOwnedAttempt(this.db, input.answerAttemptId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const existing = await this.db.transcriptRevision.findFirst({
      where: { transcriptId: transcript.id },
    });
    if (existing) {
      throw new DomainError(
        "ORIGINAL_REVISION_EXISTS",
        "Original transcript revision already exists",
      );
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const revision = await delegated.transcriptRevision.create({
          data: {
            id: randomUUID(),
            transcriptId: transcript.id,
            answerAttemptId: attempt.id,
            revisionNumber: 1,
            revisionKind: input.revisionKind,
            fullText: transcript.fullText,
            segments: transcript.segments,
            alignmentStatus: input.alignmentStatus,
            contentHash: input.contentHash,
            createdByUserId: input.actorUserId,
            createdVia: input.createdVia ?? null,
          },
        });
        await delegated.answerAttempt.update({
          where: { id: attempt.id },
          data: { activeRevisionId: revision.id },
        });
        return revision as unknown as TranscriptRevisionRecord;
      });
    } catch (error) {
      throw toDomainError(error, "ORIGINAL_REVISION_EXISTS");
    }
  }

  async createCorrectedRevisionForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    fullText: string;
    contentHash: string;
  }): Promise<TranscriptRevisionRecord> {
    if (!input.fullText?.trim()) {
      throw new DomainError("INVALID_TEXT", "Corrected transcript text is required");
    }
    if (!input.contentHash) {
      throw new DomainError("INVALID_TEXT", "contentHash is required");
    }
    const attempt = await this.loadOwnedAttempt(this.db, input.answerAttemptId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const original = await this.db.transcriptRevision.findFirst({
      where: { answerAttemptId: attempt.id, revisionNumber: 1 },
    });
    if (!original) {
      throw new DomainError(
        "ORIGINAL_REVISION_MISSING",
        "Original transcript revision is missing",
      );
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const max = await delegated.transcriptRevision.aggregate({
          where: { transcriptId: original.transcriptId },
          _max: { revisionNumber: true },
        });
        const revision = await delegated.transcriptRevision.create({
          data: {
            id: randomUUID(),
            transcriptId: original.transcriptId,
            answerAttemptId: attempt.id,
            revisionNumber: (max._max.revisionNumber ?? 1) + 1,
            revisionKind: "USER_CORRECTED",
            fullText: input.fullText,
            segments: "[]",
            alignmentStatus: "DROPPED",
            contentHash: input.contentHash,
            createdByUserId: input.actorUserId,
            createdVia: "USER_CORRECTED",
          },
        });
        await delegated.answerAttempt.update({
          where: { id: attempt.id },
          data: { activeRevisionId: revision.id },
        });
        return revision as unknown as TranscriptRevisionRecord;
      });
    } catch (error) {
      throw toDomainError(error, "INVALID_TEXT");
    }
  }

  async completeAttemptForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    submittedAt: Date;
    completedAt: Date;
    durationMs?: number | null;
  }): Promise<AnswerAttemptRecord> {
    const attempt = await this.loadOwnedAttempt(
      this.db,
      input.answerAttemptId,
      input.actorUserId,
    );
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const row = await this.db.answerAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "COMPLETED",
        submittedAt: input.submittedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs ?? null,
      },
    });
    return row as unknown as AnswerAttemptRecord;
  }

  async getRevisionForUser(
    revisionId: string,
    actorUserId: string,
  ): Promise<TranscriptRevisionRecord> {
    assertActor(actorUserId);
    const revision = await this.db.transcriptRevision.findUnique({
      where: { id: revisionId },
    });
    if (!revision) {
      throw new NotFoundError("Transcript revision not found", "INVALID_INPUT_REVISION");
    }
    await this.loadOwnedAttempt(this.db, revision.answerAttemptId, actorUserId);
    return revision as unknown as TranscriptRevisionRecord;
  }

  async deletePendingSummaryForUser(
    generationId: string,
    actorUserId: string,
  ): Promise<void> {
    const generation = await this.db.sessionSummaryGeneration.findUnique({
      where: { id: generationId },
    });
    if (!generation) return;
    await this.loadOwnedSession(this.db, generation.sessionId, actorUserId);
    if (generation.status !== "PENDING") return;
    await this.db.sessionSummaryGeneration.delete({ where: { id: generation.id } });
  }

  async setActiveRevisionForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    revisionId: string;
  }): Promise<AnswerAttemptRecord> {
    const attempt = await this.loadOwnedAttempt(
      this.db,
      input.answerAttemptId,
      input.actorUserId,
    );
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const revision = await this.db.transcriptRevision.findUnique({
      where: { id: input.revisionId },
    });
    if (!revision || revision.answerAttemptId !== attempt.id) {
      throw new DomainError(
        "INVALID_INPUT_REVISION",
        "Transcript revision does not belong to this answer attempt",
      );
    }
    const row = await this.db.answerAttempt.update({
      where: { id: attempt.id },
      data: { activeRevisionId: revision.id },
    });
    return row as unknown as AnswerAttemptRecord;
  }

  // -- Feedback (persistence only, no model calls) ---------------------------

  async createPendingFeedbackForUser(input: {
    actorUserId: string;
    answerAttemptId: string;
    inputRevisionId?: string | null;
    model: string;
    provider: string;
    promptVersion?: string | null;
    knowledgeBaseVersion?: string | null;
  }): Promise<FeedbackGenerationRecord> {
    if (!input.model?.trim() || !input.provider?.trim()) {
      throw new DomainError(
        "INTERVIEW_MODEL_NOT_CONFIGURED",
        "Interview model is not configured",
      );
    }
    const attempt = await this.loadOwnedAttempt(
      this.db,
      input.answerAttemptId,
      input.actorUserId,
    );
    const session = await this.loadOwnedSession(this.db, attempt.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const instance = await this.db.questionInstance.findUnique({
      where: { id: attempt.questionInstanceId },
    });
    if (!instance || instance.sessionId !== attempt.sessionId) {
      throw new OwnershipError("Question instance does not belong to this session");
    }
    const revisionId = input.inputRevisionId ?? attempt.activeRevisionId;
    if (!revisionId) {
      throw new DomainError(
        "NO_ACTIVE_REVISION",
        "Answer attempt has no active transcript revision",
      );
    }
    const revision = await this.db.transcriptRevision.findUnique({
      where: { id: revisionId },
    });
    if (!revision || revision.answerAttemptId !== attempt.id) {
      throw new DomainError(
        "INVALID_INPUT_REVISION",
        "Transcript revision does not belong to this answer attempt",
      );
    }
    const max = await this.db.feedbackGeneration.aggregate({
      where: { answerAttemptId: attempt.id },
      _max: { versionNumber: true },
    });
    const row = await this.db.feedbackGeneration.create({
      data: {
        id: randomUUID(),
        answerAttemptId: attempt.id,
        questionInstanceId: attempt.questionInstanceId,
        sessionId: attempt.sessionId,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        isCurrent: false,
        status: "PENDING",
        inputRevisionId: revision.id,
        inputContentHash: revision.contentHash,
        model: input.model,
        provider: input.provider,
        promptVersion: input.promptVersion ?? "commercial_feedback_v1",
        knowledgeBaseVersion: input.knowledgeBaseVersion ?? null,
      },
    });
    return row as unknown as FeedbackGenerationRecord;
  }

  async publishFeedbackForUser(input: {
    actorUserId: string;
    generationId: string;
    transcriptId: string;
    items: FeedbackItemInput[];
  }): Promise<{ generation: FeedbackGenerationRecord; items: FeedbackItemRecord[] }> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new DomainError("EMPTY_ITEMS", "Feedback items are required");
    }
    for (const item of input.items) {
      if (!item.problemLabel?.trim() || !item.suggestion?.trim()) {
        throw new DomainError("INVALID_FEEDBACK_ITEM", "Feedback item is invalid");
      }
    }
    const generation = await this.db.feedbackGeneration.findUnique({
      where: { id: input.generationId },
    });
    if (!generation) throw new NotFoundError("Feedback generation not found", "GENERATION_NOT_FOUND");
    await this.loadOwnedSession(this.db, generation.sessionId, input.actorUserId);
    const session = await this.loadOwnedSession(this.db, generation.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const transcript = await this.db.transcript.findUnique({
      where: { id: input.transcriptId },
    });
    if (!transcript) throw new NotFoundError("Transcript not found", "TRANSCRIPT_NOT_FOUND");
    if (
      transcript.sessionId !== generation.sessionId ||
      transcript.answerAttemptId !== generation.answerAttemptId
    ) {
      throw new OwnershipError("Transcript does not belong to this feedback generation");
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        await delegated.feedbackGeneration.updateMany({
          where: { answerAttemptId: generation.answerAttemptId, isCurrent: true },
          data: { isCurrent: false },
        });
        const persisted: FeedbackItemRecord[] = [];
        for (const [index, item] of input.items.entries()) {
          const created = await delegated.feedbackItem.create({
            data: {
              id: randomUUID(),
              sessionId: generation.sessionId,
              transcriptId: transcript.id,
              generationId: generation.id,
              itemOrder: index + 1,
              problemLabel: item.problemLabel,
              evidence:
                typeof item.evidence === "string" ? item.evidence : stringifyJson(item.evidence),
              explanation:
                typeof item.explanation === "string"
                  ? item.explanation
                  : stringifyJson(item.explanation),
              suggestion: item.suggestion,
            },
          });
          persisted.push(created as unknown as FeedbackItemRecord);
        }
        const updated = await delegated.feedbackGeneration.update({
          where: { id: generation.id },
          data: {
            status: "SUCCEEDED",
            isCurrent: true,
            completedAt: new Date(),
            failureCode: null,
            failureMessage: null,
          },
        });
        return {
          generation: updated as unknown as FeedbackGenerationRecord,
          items: persisted,
        };
      });
    } catch (error) {
      throw toDomainError(error, "GENERATION_FAILED");
    }
  }

  async failFeedbackForUser(input: {
    actorUserId: string;
    generationId: string;
    code: string;
    message: string;
  }): Promise<FeedbackGenerationRecord> {
    const generation = await this.db.feedbackGeneration.findUnique({
      where: { id: input.generationId },
    });
    if (!generation) throw new NotFoundError("Feedback generation not found", "GENERATION_NOT_FOUND");
    await this.loadOwnedSession(this.db, generation.sessionId, input.actorUserId);
    const row = await this.db.feedbackGeneration.update({
      where: { id: generation.id },
      data: {
        status: "FAILED",
        isCurrent: false,
        completedAt: new Date(),
        failureCode: input.code.slice(0, 64),
        failureMessage: input.message.slice(0, 500),
      },
    });
    return row as unknown as FeedbackGenerationRecord;
  }

  async getCurrentFeedbackWithItemsForUser(
    attemptId: string,
    actorUserId: string,
  ): Promise<{ generation: FeedbackGenerationRecord; items: FeedbackItemRecord[] } | null> {
    const attempt = await this.loadOwnedAttempt(this.db, attemptId, actorUserId);
    const row = await this.db.feedbackGeneration.findFirst({
      where: { answerAttemptId: attempt.id, isCurrent: true },
      include: { items: { orderBy: { itemOrder: "asc" } } },
    });
    if (!row) return null;
    const { items, ...generation } = row as unknown as FeedbackGenerationRecord & {
      items: FeedbackItemRecord[];
    };
    return { generation, items };
  }

  // -- Summary (persistence only) --------------------------------------------

  async createPendingSummaryForUser(input: {
    actorUserId: string;
    sessionId: string;
    inputHash: string;
    model: string;
    provider: string;
    promptVersion?: string | null;
    knowledgeBaseVersion?: string | null;
  }): Promise<SessionSummaryGenerationRecord> {
    if (!input.inputHash) {
      throw new DomainError("SUMMARY_NOT_READY", "Summary input hash is required");
    }
    if (!input.model?.trim() || !input.provider?.trim()) {
      throw new DomainError(
        "INTERVIEW_MODEL_NOT_CONFIGURED",
        "Interview model is not configured",
      );
    }
    const session = await this.loadOwnedSession(this.db, input.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const max = await this.db.sessionSummaryGeneration.aggregate({
      where: { sessionId: session.id },
      _max: { versionNumber: true },
    });
    const row = await this.db.sessionSummaryGeneration.create({
      data: {
        id: randomUUID(),
        sessionId: session.id,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        status: "PENDING",
        isCurrent: false,
        inputHash: input.inputHash,
        model: input.model,
        provider: input.provider,
        promptVersion: input.promptVersion ?? "commercial_summary_v1",
        knowledgeBaseVersion: input.knowledgeBaseVersion ?? null,
      },
    });
    return row as unknown as SessionSummaryGenerationRecord;
  }

  async publishSummaryForUser(input: {
    actorUserId: string;
    generationId: string;
    evidence: SummaryEvidenceInput[];
    bodyText: string;
    structuredPayload?: unknown;
  }): Promise<{
    generation: SessionSummaryGenerationRecord;
    inputs: SessionSummaryInputRecord[];
  }> {
    if (!input.bodyText?.trim()) {
      throw new DomainError("INVALID_SUMMARY_OUTPUT", "Summary body text is required");
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new DomainError("SUMMARY_NOT_READY", "Summary evidence is required");
    }
    const generation = await this.db.sessionSummaryGeneration.findUnique({
      where: { id: input.generationId },
    });
    if (!generation) {
      throw new NotFoundError("Session summary generation not found", "SUMMARY_NOT_FOUND");
    }
    const session = await this.loadOwnedSession(
      this.db,
      generation.sessionId,
      input.actorUserId,
    );
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    for (const item of input.evidence) {
      const instance = await this.db.questionInstance.findUnique({
        where: { id: item.questionInstanceId },
      });
      if (!instance || instance.sessionId !== generation.sessionId) {
        throw new OwnershipError("Question instance does not belong to this session");
      }
      const feedback = await this.db.feedbackGeneration.findUnique({
        where: { id: item.feedbackGenerationId },
      });
      if (
        !feedback ||
        feedback.sessionId !== generation.sessionId ||
        feedback.questionInstanceId !== instance.id
      ) {
        throw new OwnershipError("Feedback generation does not belong to this session graph");
      }
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const persisted: SessionSummaryInputRecord[] = [];
        for (const item of input.evidence) {
          const created = await delegated.sessionSummaryInput.create({
            data: {
              id: randomUUID(),
              summaryGenerationId: generation.id,
              sessionId: generation.sessionId,
              questionInstanceId: item.questionInstanceId,
              feedbackGenerationId: item.feedbackGenerationId,
              inputOrder: item.inputOrder,
            },
          });
          persisted.push(created as unknown as SessionSummaryInputRecord);
        }
        const newerCurrent = await delegated.sessionSummaryGeneration.findFirst({
          where: {
            sessionId: generation.sessionId,
            status: "SUCCEEDED",
            versionNumber: { gt: generation.versionNumber },
          },
          orderBy: { versionNumber: "desc" },
        });
        if (!newerCurrent) {
          await delegated.sessionSummaryGeneration.updateMany({
            where: {
              sessionId: generation.sessionId,
              isCurrent: true,
              id: { not: generation.id },
            },
            data: { isCurrent: false },
          });
        }
        const updated = await delegated.sessionSummaryGeneration.update({
          where: { id: generation.id },
          data: {
            bodyText: input.bodyText,
            structuredPayload:
              input.structuredPayload == null ? null : stringifyJson(input.structuredPayload),
            status: "SUCCEEDED",
            isCurrent: newerCurrent == null,
            completedAt: new Date(),
            failureCode: null,
            failureMessage: null,
          },
        });
        return {
          generation: updated as unknown as SessionSummaryGenerationRecord,
          inputs: persisted,
        };
      });
    } catch (error) {
      throw toDomainError(error, "GENERATION_FAILED");
    }
  }

  async failSummaryForUser(input: {
    actorUserId: string;
    generationId: string;
    code: string;
    message: string;
  }): Promise<SessionSummaryGenerationRecord> {
    const generation = await this.db.sessionSummaryGeneration.findUnique({
      where: { id: input.generationId },
    });
    if (!generation) {
      throw new NotFoundError("Session summary generation not found", "SUMMARY_NOT_FOUND");
    }
    await this.loadOwnedSession(this.db, generation.sessionId, input.actorUserId);
    const row = await this.db.sessionSummaryGeneration.update({
      where: { id: generation.id },
      data: {
        status: "FAILED",
        isCurrent: false,
        completedAt: new Date(),
        failureCode: input.code.slice(0, 64),
        failureMessage: input.message.slice(0, 500),
      },
    });
    return row as unknown as SessionSummaryGenerationRecord;
  }

  async getCurrentSummaryWithInputsForUser(
    sessionId: string,
    actorUserId: string,
  ): Promise<{
    generation: SessionSummaryGenerationRecord;
    inputs: SessionSummaryInputRecord[];
  } | null> {
    await this.loadOwnedSession(this.db, sessionId, actorUserId);
    const row = await this.db.sessionSummaryGeneration.findFirst({
      where: { sessionId, isCurrent: true, status: "SUCCEEDED" },
      include: { inputs: { orderBy: { inputOrder: "asc" } } },
    });
    if (!row) return null;
    const { inputs, ...generation } = row as unknown as SessionSummaryGenerationRecord & {
      inputs: SessionSummaryInputRecord[];
    };
    return { generation, inputs };
  }

  // -- Coaching (persistence only) -------------------------------------------

  async getOrCreateConversationForUser(
    sessionId: string,
    actorUserId: string,
  ): Promise<CoachingConversationRecord> {
    const session = await this.loadOwnedSession(this.db, sessionId, actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    const existing = await this.db.coachingConversation.findUnique({
      where: { sessionId },
    });
    if (existing) return existing as unknown as CoachingConversationRecord;
    try {
      const created = await this.db.coachingConversation.create({
        data: { id: randomUUID(), sessionId, status: "OPEN" },
      });
      return created as unknown as CoachingConversationRecord;
    } catch (error) {
      const retry = await this.db.coachingConversation.findUnique({
        where: { sessionId },
      });
      if (retry) return retry as unknown as CoachingConversationRecord;
      throw toDomainError(error, "GENERATION_FAILED");
    }
  }

  async createTurnForUser(input: {
    actorUserId: string;
    sessionId: string;
    userText: string;
    targetType: string;
    questionInstanceId?: string | null;
    answerAttemptId?: string | null;
    commercialFeedbackItemId?: string | null;
    summaryGenerationId?: string | null;
    assistantReply: string;
    replyModel?: string | null;
    replyPromptVersion?: string | null;
    contextSnapshot?: Record<string, unknown> | string | null;
  }): Promise<DialogueTurnRecord> {
    if (!input.userText?.trim()) {
      throw new DomainError("INVALID_DIALOGUE_TEXT", "user_text is required");
    }
    if (!DIALOGUE_TARGET_TYPES.includes(input.targetType as (typeof DIALOGUE_TARGET_TYPES)[number])) {
      throw new DomainError("INVALID_TARGET_TYPE", "Unsupported dialogue target_type");
    }
    const qid = input.questionInstanceId ?? null;
    const aid = input.answerAttemptId ?? null;
    const fid = input.commercialFeedbackItemId ?? null;
    const sid = input.summaryGenerationId ?? null;
    const xorValid =
      (input.targetType === "SESSION" && !qid && !aid && !fid && !sid) ||
      (input.targetType === "QUESTION_INSTANCE" && !!qid && !aid && !fid && !sid) ||
      (input.targetType === "ANSWER_ATTEMPT" && !qid && !!aid && !fid && !sid) ||
      (input.targetType === "FEEDBACK_ITEM" && !qid && !aid && !!fid && !sid) ||
      (input.targetType === "SESSION_SUMMARY" && !qid && !aid && !fid && !!sid);
    if (!xorValid) {
      throw new DomainError("INVALID_DIALOGUE_TARGET", "Dialogue target ids do not match target_type");
    }
    const session = await this.loadOwnedSession(this.db, input.sessionId, input.actorUserId);
    if (isArchivedRow(session)) throw new ArchivedSessionError();
    if (qid) {
      const instance = await this.db.questionInstance.findUnique({ where: { id: qid } });
      if (!instance) throw new NotFoundError("Question instance not found", "QUESTION_NOT_FOUND");
      if (instance.sessionId !== session.id) {
        throw new OwnershipError("Question instance does not belong to this session");
      }
    }
    if (aid) {
      const attempt = await this.db.answerAttempt.findUnique({ where: { id: aid } });
      if (!attempt) throw new NotFoundError("Answer attempt not found", "ATTEMPT_NOT_FOUND");
      if (attempt.sessionId !== session.id) {
        throw new OwnershipError("Answer attempt does not belong to this session");
      }
    }
    if (fid) {
      const item = await this.db.feedbackItem.findUnique({ where: { id: fid } });
      if (!item) throw new NotFoundError("Feedback item not found", "FEEDBACK_ITEM_NOT_FOUND");
      if (item.sessionId !== session.id) {
        throw new OwnershipError("Feedback item does not belong to this session");
      }
    }
    if (sid) {
      const summary = await this.db.sessionSummaryGeneration.findUnique({
        where: { id: sid },
      });
      if (!summary) {
        throw new NotFoundError("Session summary generation not found", "SUMMARY_NOT_FOUND");
      }
      if (summary.sessionId !== session.id) {
        throw new OwnershipError("Session summary does not belong to this session");
      }
    }
    let contextJson: string | null = null;
    if (input.contextSnapshot != null) {
      if (typeof input.contextSnapshot === "string") {
        contextJson = input.contextSnapshot;
        try {
          assertProvenanceSnapshot(JSON.parse(input.contextSnapshot) as Record<string, unknown>);
        } catch (error) {
          if (error instanceof DomainError) throw error;
        }
      } else {
        assertProvenanceSnapshot(input.contextSnapshot);
        contextJson = stringifyJson(input.contextSnapshot);
      }
    }
    const conversation = await this.getOrCreateConversationForUser(
      session.id,
      input.actorUserId,
    );
    if (conversation.sessionId !== session.id) {
      throw new OwnershipError("Conversation does not belong to this session");
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const delegated = tx as unknown as PrismaClient;
        const max = await delegated.dialogueTurn.aggregate({
          where: { sessionId: session.id },
          _max: { turnNumber: true },
        });
        const row = await delegated.dialogueTurn.create({
          data: {
            id: randomUUID(),
            sessionId: session.id,
            conversationId: conversation.id,
            turnNumber: (max._max.turnNumber ?? 0) + 1,
            userText: input.userText,
            entryMode: "free_text",
            assistantReply: input.assistantReply,
            replyModel: input.replyModel ?? null,
            replyPromptVersion: input.replyPromptVersion ?? null,
            contextSnapshot: contextJson,
            targetType: input.targetType,
            questionInstanceId: qid,
            answerAttemptId: aid,
            commercialFeedbackItemId: fid,
            summaryGenerationId: sid,
          },
        });
        return row as unknown as DialogueTurnRecord;
      });
    } catch (error) {
      throw toDomainError(error, "INVALID_DIALOGUE_TARGET");
    }
  }

  async listTurnsForUser(
    sessionId: string,
    actorUserId: string,
  ): Promise<DialogueTurnRecord[]> {
    await this.loadOwnedSession(this.db, sessionId, actorUserId);
    const rows = await this.db.dialogueTurn.findMany({
      where: { sessionId },
      orderBy: { turnNumber: "asc" },
    });
    return rows as unknown as DialogueTurnRecord[];
  }

  // -- QuestionBank (read-only; SYSTEM-MANAGED GLOBAL REFERENCE DATA) --------

  async listBankItems(bankId: string): Promise<{ id: string; questionId: string }[]> {
    const rows = await this.db.questionBankItem.findMany({
      where: { bankId },
      orderBy: { displayOrder: "asc" },
    });
    return rows.map((row) => ({ id: row.id, questionId: row.questionId }));
  }

  // -- Recovery ---------------------------------------------------------------

  async markStaleGenerationsFailed(input: {
    olderThanMs?: number;
    now?: Date;
  }): Promise<{ feedback: number; summary: number }> {
    const olderThanMs = input.olderThanMs ?? 15 * 60 * 1000;
    if (olderThanMs <= 0) {
      throw new DomainError(
        "INVALID_STALE_THRESHOLD",
        "stale recovery requires a positive age threshold",
      );
    }
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanMs);
    const feedback = await this.db.feedbackGeneration.updateMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      data: {
        status: "FAILED",
        isCurrent: false,
        completedAt: now,
        failureCode: "STALE_PENDING",
        failureMessage: "Pending feedback generation exceeded the recovery threshold",
      },
    });
    const summary = await this.db.sessionSummaryGeneration.updateMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      data: {
        status: "FAILED",
        isCurrent: false,
        completedAt: now,
        failureCode: "STALE_PENDING",
        failureMessage: "Pending summary generation exceeded the recovery threshold",
      },
    });
    return { feedback: feedback.count, summary: summary.count };
  }
}
