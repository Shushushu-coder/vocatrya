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
import {
  VocatryaInterviewModelResolver,
  type InterviewSessionModelResolver,
} from "./interviewModelResolver";
import { INTERVIEW_ADAPTER_ERROR_CODES } from "./errors";
import {
  sessionAiLockFromRow,
  type InterviewSessionAiLock,
} from "./sessionAiLock";
import {
  AIBusinessError,
  isAIBackendKind,
  isSupportedAccountProviderForBackend,
} from "@/lib/ai/connections";
import { executeAIConnectionText } from "@/lib/ai/execution";

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

/**
 * Minimal readers the session-locked model path needs. The session lock
 * columns and the connection's provenance/state are the only fields
 * touched — credentials never cross this boundary.
 */
export interface InterviewSessionLockDb {
  interviewSession: {
    findUnique: (args: {
      where: { id: string };
      select: {
        userId: true;
        resolvedConnectionId: true;
        resolvedModel: true;
      };
    }) => Promise<{
      userId: string;
      resolvedConnectionId: string | null;
      resolvedModel: string | null;
    } | null>;
  };
  aIConnection: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        userId: true;
        provider: true;
        backendKind: true;
        status: true;
        archivedAt: true;
      };
    }) => Promise<{
      id: string;
      userId: string;
      provider: string;
      backendKind: string;
      status: string;
      archivedAt: Date | null;
    } | null>;
  };
}

/**
 * The ACCOUNT_LOGIN one-shot transport. Defaults to the shared
 * TEXT_ONLY execution seam; injectable so tests can observe the locked
 * connectionId/model without a desktop channel.
 */
export type InterviewAccountExec = (input: {
  userId: string;
  connectionId: string;
  model: string;
  prompt: string;
}) => Promise<{ text: string }>;

function accountUnavailable(message: string): DomainError {
  return new DomainError("ASSIGNED_CONNECTION_UNAVAILABLE", message);
}

export class VocatryaInterviewModelAdapter implements InterviewModelPort {
  constructor(
    private readonly db?: InterviewSessionLockDb,
    private readonly resolver: InterviewSessionModelResolver = new VocatryaInterviewModelResolver(),
    private readonly execText: InterviewAccountExec = executeAIConnectionText,
  ) {}

  async resolveInterviewModel(input: {
    requestingUserId: string;
    sessionId?: string;
  }): Promise<ResolvedInterviewModel> {
    const lock = await this.loadSessionLock(input);
    try {
      if (lock.kind === "account") {
        return await this.resolveAccountModel(input.requestingUserId, lock);
      }
      if (lock.kind === "legacy") {
        return await this.resolver.resolveForConfig(input.requestingUserId, {
          provider: lock.provider,
          model: lock.model,
        });
      }
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

  /**
   * Read the persisted session lock. Never re-resolves the assignment —
   * retries, reloads and later turns all honour whatever was locked at
   * creation time.
   */
  private async loadSessionLock(input: {
    requestingUserId: string;
    sessionId?: string;
  }): Promise<InterviewSessionAiLock> {
    if (!this.db || !input.sessionId) {
      return { kind: "unlocked" };
    }
    const session = await this.db.interviewSession.findUnique({
      where: { id: input.sessionId },
      select: {
        userId: true,
        resolvedConnectionId: true,
        resolvedModel: true,
      },
    });
    if (!session) {
      // Callers resolve a session that exists; a vanished row must fail
      // explicitly rather than silently falling back to live resolution.
      throw new NotFoundError();
    }
    if (session.userId !== input.requestingUserId) {
      throw new OwnershipError("Session is not owned by the current user");
    }
    return sessionAiLockFromRow(session);
  }

  /**
   * Build a ResolvedInterviewModel bound to the session's locked
   * AIConnection. The connection-state gate mirrors
   * executeAIConnectionText so a dead connection fails explicitly at
   * resolve time; generateJson still re-gates through the execution seam
   * for every call.
   */
  private async resolveAccountModel(
    requestingUserId: string,
    lock: { connectionId: string; model: string },
  ): Promise<ResolvedInterviewModel> {
    const connection = await this.db!.aIConnection.findUnique({
      where: { id: lock.connectionId },
      select: {
        id: true,
        userId: true,
        provider: true,
        backendKind: true,
        status: true,
        archivedAt: true,
      },
    });
    if (!connection || connection.userId !== requestingUserId) {
      throw accountUnavailable("The assigned AI connection is not available");
    }
    if (connection.archivedAt !== null) {
      throw accountUnavailable("The assigned AI connection is archived");
    }
    switch (connection.status) {
      case "CONNECTED":
        break;
      case "REAUTH_REQUIRED":
        throw new DomainError(
          "REAUTH_REQUIRED",
          "The assigned AI connection needs re-authentication",
        );
      case "DISCONNECTED":
        throw new DomainError(
          "CONNECTION_DISCONNECTED",
          "The assigned AI connection is disconnected",
        );
      default:
        throw new DomainError(
          "CONNECTION_ERROR",
          "The assigned AI connection is in an error state",
        );
    }
    if (!isAIBackendKind(connection.backendKind)) {
      throw new DomainError(
        "RUNTIME_NOT_AVAILABLE",
        "The assigned AI connection has no recognized runtime",
      );
    }
    if (
      !isSupportedAccountProviderForBackend(
        connection.backendKind,
        connection.provider,
      )
    ) {
      throw new DomainError(
        "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
        "Provider is not supported on this runtime",
      );
    }
    const model = typeof lock.model === "string" ? lock.model.trim() : "";
    if (!model) {
      throw new DomainError("MODEL_UNAVAILABLE", "Model is required");
    }
    const connectionId = lock.connectionId;
    const userId = requestingUserId;
    return {
      provider: connection.provider,
      model,
      // The runtime CLI accepts a single TEXT_ONLY prompt; the adapter
      // deterministically flattens system + prompt here, never per
      // backendKind. Output is strict-parsed exactly like the legacy path.
      generateJson: async ({ system, prompt }) => {
        let executed: { text: string };
        try {
          executed = await this.execText({
            userId,
            connectionId,
            model,
            prompt: `${system}\n\n${prompt}`,
          });
        } catch (error) {
          if (error instanceof AIBusinessError) {
            throw new DomainError(error.code, error.message);
          }
          throw error;
        }
        const text =
          typeof executed.text === "string" ? executed.text.trim() : "";
        if (!text) {
          throw new DomainError(
            "GENERATION_FAILED",
            "Interview model returned empty output",
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          // Never propagate the raw parse error — its message can embed a
          // snippet of model output, which must not reach diagnostics.
          throw new DomainError(
            "GENERATION_FAILED",
            "Interview model returned non-JSON output",
          );
        }
      },
    };
  }
}
