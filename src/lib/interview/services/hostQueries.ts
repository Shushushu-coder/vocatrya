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
      where: { userId, archivedAt: null },
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

  /**
   * Bounded job/JD payload for interview question planning and session
   * context. Only the owning user's rows are reachable here — callers have
   * already resolved the pair through the frozen job-context port.
   */
  async getJobPlanningContext(input: {
    jobOpportunityId: string;
    jobDescriptionVersionId: string;
  }): Promise<{
    jobTitle: string;
    companyName: string | null;
    jdVersionNumber: number;
    jdRawContent: string;
  } | null> {
    const jd = await this.db.jobDescriptionVersion.findUnique({
      where: { id: input.jobDescriptionVersionId },
      select: {
        id: true,
        jobOpportunityId: true,
        versionNumber: true,
        rawContent: true,
      },
    });
    if (!jd || jd.jobOpportunityId !== input.jobOpportunityId) return null;
    const job = await this.db.jobOpportunity.findUnique({
      where: { id: input.jobOpportunityId },
      select: { id: true, title: true, company: { select: { label: true } } },
    });
    if (!job) return null;
    return {
      jobTitle: job.title,
      companyName: job.company?.label ?? null,
      jdVersionNumber: jd.versionNumber,
      jdRawContent: jd.rawContent,
    };
  }

  /**
   * Career Material facts for question planning. Facts only: item
   * provenance (type/title/dates) plus owned evidence rows. No internal
   * ids, no credentials — output feeds an LLM prompt.
   */
  async listCareerMaterialFacts(userId: string): Promise<
    Array<{
      type: string;
      title: string;
      startDate: Date | null;
      endDate: Date | null;
      isCurrent: boolean;
      notes: string | null;
      orgOrVenue: string | null;
      evidence: Array<{
        kind: string;
        content: string;
        metricText: string | null;
      }>;
    }>
  > {
    const rows = await this.db.careerMaterialItem.findMany({
      where: { userId, archivedAt: null },
      orderBy: [{ isCurrent: "desc" }, { updatedAt: "desc" }],
      take: 24,
      select: {
        type: true,
        title: true,
        startDate: true,
        endDate: true,
        isCurrent: true,
        notes: true,
        evidence: {
          where: { archivedAt: null },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          take: 6,
          select: { kind: true, content: true, metricText: true },
        },
        internshipDetail: {
          select: { organizationName: true, roleTitle: true },
        },
        employmentDetail: {
          select: { organizationName: true, roleTitle: true },
        },
        projectDetail: {
          select: { organizationName: true, roleTitle: true },
        },
        researchDetail: {
          select: { institution: true, roleTitle: true, field: true },
        },
        campusActivityDetail: {
          select: { organizationName: true, roleTitle: true },
        },
        educationDetail: {
          select: { institution: true, degree: true, fieldOfStudy: true },
        },
        awardDetail: { select: { issuer: true } },
        skillDetail: { select: { skillName: true, proficiency: true } },
        certificationDetail: { select: { organization: true } },
        competitionDetail: {
          select: { organizer: true, awardLevel: true },
        },
        publicationDetail: { select: { venue: true } },
      },
    });
    return rows.map((row) => {
      const orgOrVenue =
        row.internshipDetail?.organizationName ??
        row.employmentDetail?.organizationName ??
        row.projectDetail?.organizationName ??
        row.researchDetail?.institution ??
        row.campusActivityDetail?.organizationName ??
        row.educationDetail?.institution ??
        row.awardDetail?.issuer ??
        row.certificationDetail?.organization ??
        row.competitionDetail?.organizer ??
        row.publicationDetail?.venue ??
        null;
      const roleTitle =
        row.internshipDetail?.roleTitle ??
        row.employmentDetail?.roleTitle ??
        row.projectDetail?.roleTitle ??
        row.researchDetail?.roleTitle ??
        row.campusActivityDetail?.roleTitle ??
        null;
      let detailExtra: string | null = row.researchDetail?.field ?? null;
      if (!detailExtra && row.educationDetail) {
        detailExtra =
          [row.educationDetail.degree, row.educationDetail.fieldOfStudy]
            .filter(Boolean)
            .join(" ") || null;
      }
      if (!detailExtra && row.skillDetail) {
        detailExtra =
          [row.skillDetail.skillName, row.skillDetail.proficiency]
            .filter(Boolean)
            .join(" ") || null;
      }
      if (!detailExtra) {
        detailExtra = row.competitionDetail?.awardLevel ?? null;
      }
      const orgPlus = [orgOrVenue, roleTitle, detailExtra]
        .filter(Boolean)
        .join(" · ");
      return {
        type: row.type,
        title: row.title,
        startDate: row.startDate,
        endDate: row.endDate,
        isCurrent: row.isCurrent,
        notes: row.notes,
        orgOrVenue: orgPlus || null,
        evidence: row.evidence.map((item) => ({
          kind: item.kind,
          content: item.content,
          metricText: item.metricText,
        })),
      };
    });
  }

  async listFeedbackItemsForGeneration(
    generationId: string,
  ): Promise<FeedbackItemRecord[]> {
    const rows = await this.db.feedbackItem.findMany({
      where: { generationId },
      orderBy: { itemOrder: "asc" },
    });
    return rows as unknown as FeedbackItemRecord[];
  }

  /**
   * Product-facing session cards for the interview landing history.
   * Derives readable metadata (job/company, progress) — internal enums and
   * AI lock columns stay server-side.
   */
  async listSessionCards(userId: string): Promise<
    Array<{
      session: SessionRecord;
      jobTitle: string | null;
      companyName: string | null;
      jdVersionNumber: number | null;
      totalQuestions: number;
      answeredQuestions: number;
    }>
  > {
    const sessions = await this.db.interviewSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        jobOpportunity: {
          select: { title: true, company: { select: { label: true } } },
        },
        jobDescriptionVersion: { select: { versionNumber: true } },
        questionInstances: { select: { status: true } },
      },
    });
    return sessions.map((row) => ({
      session: row as unknown as SessionRecord,
      jobTitle: row.jobOpportunity?.title ?? null,
      companyName: row.jobOpportunity?.company?.label ?? null,
      jdVersionNumber: row.jobDescriptionVersion?.versionNumber ?? null,
      totalQuestions: row.questionInstances.length,
      answeredQuestions: row.questionInstances.filter(
        (instance) => instance.status === "ANSWERED",
      ).length,
    }));
  }
}
