/**
 * Phase 3B — Vocatrya Host Port adapters (HOST_IMPLEMENT).
 *
 * Reuses Phase 2 contracts instead of reimplementing host ownership:
 * - User ownership: direct InterviewSession ownership view (Phase 2 has no
 *   session loader; authority stays `InterviewSession.userId`).
 * - Question snapshot: delegates to Phase 2 `loadQuestionSnapshot`, plus the
 *   frozen bank-membership share exception (standalone parity). Phase 2
 *   strict rejection is preserved for non-bank questions.
 * - Job/JD: delegates to Phase 2 `resolveJobJdContext`, mapping the Phase 2
 *   cross-user code (SESSION_FORBIDDEN) to the frozen port code
 *   (CROSS_USER_RELATION). All other codes pass through verbatim.
 * - Interview model: delegates to Phase 2 `VocatryaInterviewModelResolver`
 *   (which delegates to `getInterviewModel`). No credential material crosses.
 *
 * These adapters own the Vocatrya storage shape (Prisma delegates) and
 * digest it into frozen domain terminology. No Prisma types leak to callers.
 */
import {
  DomainError,
  NotFoundError,
  OwnershipError,
} from "./persistence/interviewErrors";
import type {
  InterviewModelPort,
  JobContextPort,
  QuestionPort,
  ResolvedInterviewModel,
  ResolvedJobContext,
  InterviewQuestionSnapshot,
  SessionOwnershipView,
  UserOwnershipPort,
} from "./hostPorts";
import { loadQuestionSnapshot } from "./questionAdapter";
import { resolveJobJdContext } from "./jobJdResolver";
import { VocatryaInterviewModelResolver } from "./interviewModelResolver";
import { INTERVIEW_ADAPTER_ERROR_CODES } from "./errors";

export interface SessionOwnershipReader {
  interviewSession: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      userId: string;
      status: string;
      archivedAt: Date | null;
    } | null>;
  };
}

export class VocatryaUserOwnershipAdapter implements UserOwnershipPort {
  constructor(private readonly db: SessionOwnershipReader) {}

  async loadSessionOwnership(sessionId: string): Promise<SessionOwnershipView | null> {
    const session = await this.db.interviewSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return null;
    return {
      sessionId: session.id,
      ownerUserId: session.userId,
      isArchived: session.status === "ARCHIVED" || session.archivedAt != null,
    };
  }
}

export interface VocatryaQuestionReader {
  question: {
    findUnique: (args: {
      where: { id: string };
      include?: { tags?: boolean };
    }) => Promise<{
      id: string;
      question: string;
      answer?: string | null;
      createdBy: string;
      createdVia?: string | null;
      tags?: unknown;
      deletedAt?: Date | null;
    } | null>;
  };
  questionBankItem: {
    findFirst: (args: { where: { questionId: string } }) => Promise<{ id: string } | null>;
  };
}

export class VocatryaQuestionAdapter implements QuestionPort {
  constructor(private readonly db: VocatryaQuestionReader) {}

  async resolveSnapshot(input: {
    sourceQuestionId: string;
    requestingUserId: string;
  }): Promise<InterviewQuestionSnapshot> {
    if (!input.sourceQuestionId || !input.sourceQuestionId.trim()) {
      throw new DomainError("QUESTION_NOT_FOUND", "Question not found");
    }
    if (!input.requestingUserId) {
      throw new OwnershipError("Session is not owned by the current user");
    }
    try {
      const snapshot = await loadQuestionSnapshot(
        // Phase 2 reader shape (question.findUnique with tags) is a subset.
        this.db as never,
        input.requestingUserId,
        input.sourceQuestionId,
      );
      return {
        sourceQuestionId: snapshot.sourceQuestionId,
        referenceAnswerSnapshot: snapshot.referenceAnswerSnapshot,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Frozen parity: a living question shared via any bank membership is
      // readable cross-user. Phase 2 strict rejection is kept for non-bank
      // questions, so Phase 2 regression (32/32) stays green.
      if (code === INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN) {
        const raw = await this.db.question.findUnique({
          where: { id: input.sourceQuestionId },
        });
        if (!raw) {
          throw new NotFoundError("Question not found", "QUESTION_NOT_FOUND");
        }
        if (raw.deletedAt) {
          throw new NotFoundError("Question not found", "QUESTION_NOT_FOUND");
        }
        const shared = await this.db.questionBankItem.findFirst({
          where: { questionId: raw.id },
        });
        if (shared) {
          return {
            sourceQuestionId: raw.id,
            referenceAnswerSnapshot: (raw.answer ?? null) as string | null,
          };
        }
        throw new OwnershipError("Question is not owned by the current user");
      }
      if (code === INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_NOT_FOUND) {
        throw new NotFoundError("Question not found", "QUESTION_NOT_FOUND");
      }
      if (code === INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_INVALID) {
        throw new DomainError("INVALID_QUESTIONS", (error as Error).message);
      }
      throw error;
    }
  }
}

export interface VocatryaJobReader {
  jobOpportunity: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      userId: string;
      title: string;
    } | null>;
  };
  jobDescriptionVersion: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      jobOpportunityId: string;
      versionNumber: number;
      contentHash: string;
    } | null>;
  };
}

function toFrozenJobError(code: string, message: string): DomainError {
  // Phase 2 uses SESSION_FORBIDDEN for cross-user job binds; the frozen
  // JobContext port requires CROSS_USER_RELATION. Map exactly that case.
  if (code === INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN) {
    return new DomainError("CROSS_USER_RELATION", message);
  }
  return new DomainError(code, message);
}

export class VocatryaJobContextAdapter implements JobContextPort {
  constructor(private readonly db: VocatryaJobReader) {}

  async resolveJobContext(input: {
    requestingUserId: string;
    jobOpportunityId?: string | null;
    jobDescriptionVersionId?: string | null;
  }): Promise<ResolvedJobContext> {
    try {
      const out = await resolveJobJdContext(this.db as never, {
        userId: input.requestingUserId,
        jobOpportunityId: input.jobOpportunityId,
        jobDescriptionVersionId: input.jobDescriptionVersionId,
      });
      return {
        jobOpportunityId: out.jobOpportunityId,
        jobDescriptionVersionId: out.jobDescriptionVersionId,
      };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "JOB_JD_MISMATCH";
      const message = error instanceof Error ? error.message : String(error);
      if (code === "JOB_NOT_FOUND" || code === "JD_NOT_FOUND") {
        throw new NotFoundError(message, code);
      }
      throw toFrozenJobError(code, message);
    }
  }
}

export class VocatryaInterviewModelAdapter implements InterviewModelPort {
  constructor(
    private readonly resolver = new VocatryaInterviewModelResolver(),
  ) {}

  async resolveInterviewModel(input: {
    requestingUserId: string;
  }): Promise<ResolvedInterviewModel> {
    try {
      const resolved = await this.resolver.resolve(input.requestingUserId);
      return {
        provider: resolved.provider,
        model: resolved.model,
        generateJson: resolved.generateJson,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === INTERVIEW_ADAPTER_ERROR_CODES.INTERVIEW_MODEL_NOT_CONFIGURED) {
        throw new DomainError(
          "INTERVIEW_MODEL_NOT_CONFIGURED",
          error instanceof Error ? error.message : "Interview model is not configured",
        );
      }
      throw error;
    }
  }
}
