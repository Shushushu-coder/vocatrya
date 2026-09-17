import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { ATTEMPT_OUTCOME, ATTEMPT_STAGE, RESUME_VERSION_STATUS } from "./identities";
import { ResumeVariantService } from "./resumeVariantService";
import { assertAbWritesAllowed } from "./writeGuard";

export class ApplicationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertAbWritesAllowed(this.db, this.env);
  }

  async createAttempt(input: {
    jobOpportunityId: string;
    channelLabel: string;
    channelCategory?: string | null;
    sourceUrl?: string | null;
    notes?: string | null;
    createdVia?: string | null;
  }) {
    await this.gate();
    const opportunity = await this.db.jobOpportunity.findFirst({
      where: { id: input.jobOpportunityId, userId: this.userId },
      select: { id: true },
    });
    if (!opportunity) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }

    return this.db.applicationAttempt.create({
      data: {
        userId: this.userId,
        jobOpportunityId: input.jobOpportunityId,
        channelLabel: input.channelLabel,
        channelCategory: input.channelCategory ?? null,
        sourceUrl: input.sourceUrl ?? null,
        notes: input.notes ?? null,
        currentStageCategory: ATTEMPT_STAGE.DRAFT,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
        createdVia: input.createdVia ?? "USER",
      },
    });
  }

  async markSubmitted(input: {
    attemptId: string;
    submittedResumeVersionId: string;
    submittedResumeArtifactId?: string | null;
    submittedAgainstJdVersionId?: string | null;
    submittedAt?: Date;
  }) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(input.attemptId);

    if (
      attempt.submittedResumeVersionId &&
      attempt.submittedResumeVersionId !== input.submittedResumeVersionId
    ) {
      throw new CareerRuntimeError(
        "SUBMITTED_RESUME_PROVENANCE",
        "submittedResumeVersionId is immutable after first submit",
      );
    }

    const version = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: input.submittedResumeVersionId,
        resumeVariant: { userId: this.userId },
      },
      select: { id: true, status: true },
    });
    if (!version) {
      throw new CareerRuntimeError(
        "VERSION_NOT_FOUND",
        "submittedResumeVersionId does not reference an owned resume version",
      );
    }

    const variants = new ResumeVariantService(this.db, this.userId, this.env);
    if (version.status !== RESUME_VERSION_STATUS.SUBMITTED) {
      await variants.markSubmitted(version.id);
    }

    return this.db.applicationAttempt.update({
      where: { id: attempt.id },
      data: {
        submittedAt: input.submittedAt ?? attempt.submittedAt ?? new Date(),
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        submittedResumeVersionId: input.submittedResumeVersionId,
        submittedResumeArtifactId:
          input.submittedResumeArtifactId === undefined
            ? attempt.submittedResumeArtifactId
            : input.submittedResumeArtifactId,
        submittedAgainstJdVersionId:
          input.submittedAgainstJdVersionId === undefined
            ? attempt.submittedAgainstJdVersionId
            : input.submittedAgainstJdVersionId,
      },
    });
  }

  async updateStage(attemptId: string, currentStageCategory: string) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(attemptId);
    return this.db.applicationAttempt.update({
      where: { id: attempt.id },
      data: { currentStageCategory },
    });
  }

  async recordOutcome(attemptId: string, outcome: string) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(attemptId);
    return this.db.applicationAttempt.update({
      where: { id: attempt.id },
      data: { outcome },
    });
  }

  async upsertProcessStep(input: {
    attemptId: string;
    category: string;
    label: string;
    sortOrder: number;
    status?: string;
    scheduledAt?: Date | null;
    completedAt?: Date | null;
    result?: string | null;
    notes?: string | null;
    stepId?: string;
  }) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(input.attemptId);
    const data: Prisma.ApplicationProcessStepUncheckedCreateInput = {
      applicationAttemptId: attempt.id,
      category: input.category,
      label: input.label,
      sortOrder: input.sortOrder,
      status: input.status ?? "PENDING",
      scheduledAt: input.scheduledAt ?? null,
      completedAt: input.completedAt ?? null,
      result: input.result ?? null,
      notes: input.notes ?? null,
      source: "USER",
    };

    if (input.stepId) {
      const existing = await this.db.applicationProcessStep.findFirst({
        where: { id: input.stepId, applicationAttemptId: attempt.id },
      });
      if (!existing) {
        throw new CareerRuntimeError("PROCESS_STEP_NOT_FOUND", "Process step not found");
      }
      return this.db.applicationProcessStep.update({
        where: { id: input.stepId },
        data: {
          category: data.category,
          label: data.label,
          sortOrder: data.sortOrder,
          status: data.status,
          scheduledAt: data.scheduledAt,
          completedAt: data.completedAt,
          result: data.result,
          notes: data.notes,
        },
      });
    }

    return this.db.applicationProcessStep.create({ data });
  }

  private async requireOwnedAttempt(attemptId: string) {
    const attempt = await this.db.applicationAttempt.findFirst({
      where: { id: attemptId, userId: this.userId },
    });
    if (!attempt) {
      throw new CareerRuntimeError("ATTEMPT_NOT_FOUND", "Application attempt not found");
    }
    return attempt;
  }
}
