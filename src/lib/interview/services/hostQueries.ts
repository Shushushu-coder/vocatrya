/**
 * Extra Interview queries for Phase 3C services.
 * Prisma stays here (HOST_ADAPT). Domain services never import @prisma/client.
 */
import type { PrismaClient } from "@prisma/client";
import type {
  AnswerAttemptRecord,
  FeedbackGenerationRecord,
  FeedbackItemRecord,
  SessionRecord,
  SessionSummaryGenerationRecord,
  SessionSummaryInputRecord,
} from "../persistence/interviewRecords";

export class VocatryaInterviewQueries {
  constructor(private readonly db: PrismaClient) {}

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db.interviewSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return rows as unknown as SessionRecord[];
  }

  async getActiveRevisionText(attemptId: string): Promise<string> {
    const attempt = await this.db.answerAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!attempt?.activeRevisionId) return "";
    const revision = await this.db.transcriptRevision.findUnique({
      where: { id: attempt.activeRevisionId },
    });
    return revision?.fullText ?? "";
  }

  async findLatestCompletedAttempt(
    instanceId: string,
  ): Promise<AnswerAttemptRecord | null> {
    const row = await this.db.answerAttempt.findFirst({
      where: { questionInstanceId: instanceId, status: "COMPLETED", deletedAt: null },
      orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
    });
    return (row as unknown as AnswerAttemptRecord) ?? null;
  }

  async findCurrentSucceededFeedback(
    attemptId: string,
  ): Promise<FeedbackGenerationRecord | null> {
    const row = await this.db.feedbackGeneration.findFirst({
      where: { answerAttemptId: attemptId, isCurrent: true, status: "SUCCEEDED" },
    });
    return (row as unknown as FeedbackGenerationRecord) ?? null;
  }

  async getFeedbackItem(itemId: string): Promise<FeedbackItemRecord | null> {
    const row = await this.db.feedbackItem.findUnique({ where: { id: itemId } });
    return (row as unknown as FeedbackItemRecord) ?? null;
  }

  async getFeedbackGeneration(
    generationId: string,
  ): Promise<FeedbackGenerationRecord | null> {
    const row = await this.db.feedbackGeneration.findUnique({
      where: { id: generationId },
    });
    return (row as unknown as FeedbackGenerationRecord) ?? null;
  }

  async getSummaryGeneration(
    generationId: string,
  ): Promise<SessionSummaryGenerationRecord | null> {
    const row = await this.db.sessionSummaryGeneration.findUnique({
      where: { id: generationId },
    });
    return (row as unknown as SessionSummaryGenerationRecord) ?? null;
  }

  async getCurrentSummaryGeneration(
    sessionId: string,
  ): Promise<SessionSummaryGenerationRecord | null> {
    const row = await this.db.sessionSummaryGeneration.findFirst({
      where: { sessionId, isCurrent: true, status: "SUCCEEDED" },
    });
    return (row as unknown as SessionSummaryGenerationRecord) ?? null;
  }

  async listSummaryInputs(
    summaryGenerationId: string,
  ): Promise<SessionSummaryInputRecord[]> {
    const rows = await this.db.sessionSummaryInput.findMany({
      where: { summaryGenerationId },
      orderBy: { inputOrder: "asc" },
    });
    return rows as unknown as SessionSummaryInputRecord[];
  }

  async getMaxTurnNumber(sessionId: string): Promise<number> {
    const max = await this.db.dialogueTurn.aggregate({
      where: { sessionId },
      _max: { turnNumber: true },
    });
    return max._max.turnNumber ?? 0;
  }

  async listBankQuestions(): Promise<
    Array<{
      bankId: string;
      bankKey: string;
      version: string;
      title: string;
      locale: string;
      kind: string;
      questionId: string;
      displayOrder: number;
      promptText: string;
      referenceAnswer: string | null;
      category: string | null;
    }>
  > {
    const banks = await this.db.questionBank.findMany({
      include: {
        items: {
          orderBy: { displayOrder: "asc" },
          include: { question: true },
        },
      },
      orderBy: [{ bankKey: "asc" }, { version: "asc" }],
    });
    const out: Array<{
      bankId: string;
      bankKey: string;
      version: string;
      title: string;
      locale: string;
      kind: string;
      questionId: string;
      displayOrder: number;
      promptText: string;
      referenceAnswer: string | null;
      category: string | null;
    }> = [];
    for (const bank of banks) {
      for (const item of bank.items) {
        if (item.question.deletedAt) continue;
        out.push({
          bankId: bank.id,
          bankKey: bank.bankKey,
          version: bank.version,
          title: bank.title,
          locale: bank.locale,
          kind: bank.kind,
          questionId: item.questionId,
          displayOrder: item.displayOrder,
          promptText: item.question.question,
          referenceAnswer: item.question.answer,
          category: item.question.category,
        });
      }
    }
    return out;
  }

  async listUserQuestions(userId: string): Promise<
    Array<{
      id: string;
      promptText: string;
      referenceAnswer: string | null;
      category: string | null;
      createdVia: string | null;
    }>
  > {
    const rows = await this.db.question.findMany({
      where: { createdBy: userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      promptText: row.question,
      referenceAnswer: row.answer,
      category: row.category,
      createdVia: row.createdVia,
    }));
  }

  async listUserJobs(userId: string): Promise<
    Array<{
      id: string;
      title: string;
      jdVersions: Array<{ id: string; versionNumber: number }>;
    }>
  > {
    const rows = await this.db.jobOpportunity.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      include: {
        descriptionVersions: {
          orderBy: { versionNumber: "desc" },
          select: { id: true, versionNumber: true },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      jdVersions: row.descriptionVersions,
    }));
  }
}
