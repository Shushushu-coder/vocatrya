import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  COMPATIBILITY_PROCESS_STEPS,
  isTerminalAttemptOutcome,
  PROCESS_STEP_CATEGORIES,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  RESUME_VERSION_STATUS,
} from "./identities";
import {
  type ApplicationTimelineDTO,
  attemptSortKey,
  compareProcessSteps,
  toIso,
} from "./applicationTimeline";
import {
  assertInterviewReflectionStep,
  emptyInterviewReflection,
  isEmptyInterviewReflectionSave,
  interviewReflectionSortOrder,
  normalizeReflectionText,
  normalizeSaveInterviewReflectionItems,
  toInterviewReflectionDTO,
  type InterviewReflectionDTO,
  type SaveInterviewReflectionInput,
} from "./interviewReflection";
import { ResumeVariantService } from "./resumeVariantService";
import { assertAbWritesAllowed } from "./writeGuard";

const RESERVED_COMPATIBILITY_SORT_ORDERS = new Set<number>([
  COMPATIBILITY_PROCESS_STEPS.INTERVIEW.sortOrder,
  COMPATIBILITY_PROCESS_STEPS.OFFER.sortOrder,
]);

function allocateUserSortOrder(maxSortOrder: number | null): number {
  let next = (maxSortOrder ?? 0) + 10;
  while (RESERVED_COMPATIBILITY_SORT_ORDERS.has(next)) {
    next += 10;
  }
  return next;
}

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
    submittedResumeVersionId?: string | null;
    submittedResumeArtifactId?: string | null;
    submittedAgainstJdVersionId?: string | null;
    submittedAt?: Date;
  }) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(input.attemptId);
    const requestedVersionId = input.submittedResumeVersionId ?? null;

    if (
      attempt.submittedResumeVersionId &&
      requestedVersionId &&
      attempt.submittedResumeVersionId !== requestedVersionId
    ) {
      throw new CareerRuntimeError(
        "SUBMITTED_RESUME_PROVENANCE",
        "submittedResumeVersionId is immutable after first submit",
      );
    }

    let nextVersionId = attempt.submittedResumeVersionId;
    if (requestedVersionId) {
      const version = await this.db.resumeVariantVersion.findFirst({
        where: {
          id: requestedVersionId,
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
      nextVersionId = version.id;
    }

    return this.db.applicationAttempt.update({
      where: { id: attempt.id },
      data: {
        submittedAt: input.submittedAt ?? attempt.submittedAt ?? new Date(),
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        submittedResumeVersionId: nextVersionId,
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

  async ensureAttempt(input: {
    jobOpportunityId: string;
    channelLabel?: string;
    sourceUrl?: string | null;
  }) {
    await this.gate();
    const existing = await this.db.applicationAttempt.findFirst({
      where: {
        jobOpportunityId: input.jobOpportunityId,
        userId: this.userId,
        archivedAt: null,
        outcome: {
          in: [ATTEMPT_OUTCOME.ACTIVE, ATTEMPT_OUTCOME.OFFER],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;
    return this.createAttempt({
      jobOpportunityId: input.jobOpportunityId,
      channelLabel: input.channelLabel ?? "USER",
      sourceUrl: input.sourceUrl ?? null,
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

  async createTransferredAttempt(input: {
    sourceAttemptId: string;
    targetJobOpportunityId: string;
  }) {
    await this.gate();
    return this.db.$transaction(async (tx) => {
      const source = await tx.applicationAttempt.findFirst({
        where: { id: input.sourceAttemptId, userId: this.userId },
      });
      if (!source) {
        throw new CareerRuntimeError(
          "ATTEMPT_NOT_FOUND",
          "Application attempt not found",
        );
      }

      const target = await tx.jobOpportunity.findFirst({
        where: { id: input.targetJobOpportunityId, userId: this.userId },
        select: { id: true },
      });
      if (!target) {
        throw new CareerRuntimeError(
          "OPPORTUNITY_NOT_FOUND",
          "Opportunity not found",
        );
      }

      if (source.jobOpportunityId === target.id) {
        throw new CareerRuntimeError(
          "TRANSFER_SAME_OPPORTUNITY",
          "A transferred attempt must target a different job opportunity",
        );
      }

      if (isTerminalAttemptOutcome(source.outcome)) {
        throw new CareerRuntimeError(
          "TRANSFER_SOURCE_TERMINAL",
          "A terminal application cannot be transferred",
        );
      }

      await tx.applicationAttempt.update({
        where: { id: source.id },
        data: { outcome: ATTEMPT_OUTCOME.TRANSFERRED },
      });

      return tx.applicationAttempt.create({
        data: {
          userId: this.userId,
          jobOpportunityId: target.id,
          channelLabel: source.channelLabel,
          channelCategory: source.channelCategory,
          currentStageCategory: ATTEMPT_STAGE.DRAFT,
          outcome: ATTEMPT_OUTCOME.ACTIVE,
          transferredFromAttemptId: source.id,
          createdVia: "TRANSFER",
        },
      });
    });
  }

  async getTimeline(jobOpportunityId: string): Promise<ApplicationTimelineDTO> {
    const opportunity = await this.db.jobOpportunity.findFirst({
      where: { id: jobOpportunityId, userId: this.userId },
      select: { id: true },
    });
    if (!opportunity) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }

    const attempts = await this.db.applicationAttempt.findMany({
      where: { jobOpportunityId: opportunity.id, userId: this.userId },
      include: {
        processSteps: true,
        submittedResumeVersion: {
          select: {
            id: true,
            versionNumber: true,
            resumeVariant: { select: { name: true } },
          },
        },
        transferredFromAttempt: {
          select: {
            id: true,
            jobOpportunity: {
              select: {
                id: true,
                title: true,
                company: { select: { label: true } },
              },
            },
          },
        },
      },
    });

    const orderedAttempts = [...attempts].sort((a, b) => {
      const byKey = attemptSortKey(a) - attemptSortKey(b);
      if (byKey !== 0) return byKey;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return {
      opportunityId: opportunity.id,
      attempts: orderedAttempts.map((attempt) => ({
        id: attempt.id,
        submittedAt: toIso(attempt.submittedAt),
        createdAt: attempt.createdAt.toISOString(),
        currentStageCategory: attempt.currentStageCategory,
        outcome: attempt.outcome,
        transferredFromAttemptId: attempt.transferredFromAttemptId,
        transferredFrom: attempt.transferredFromAttempt
          ? {
              attemptId: attempt.transferredFromAttempt.id,
              opportunityId: attempt.transferredFromAttempt.jobOpportunity.id,
              title: attempt.transferredFromAttempt.jobOpportunity.title,
              company: attempt.transferredFromAttempt.jobOpportunity.company.label,
            }
          : null,
        submittedResume: attempt.submittedResumeVersion
          ? {
              id: attempt.submittedResumeVersion.id,
              title: attempt.submittedResumeVersion.resumeVariant.name,
              versionNumber: attempt.submittedResumeVersion.versionNumber,
            }
          : null,
        steps: [...attempt.processSteps].sort(compareProcessSteps).map((step) => ({
          id: step.id,
          category: step.category,
          label: step.label,
          status: step.status,
          source: step.source,
          scheduledAt: toIso(step.scheduledAt),
          deadlineAt: toIso(step.deadlineAt),
          completedAt: toIso(step.completedAt),
          result: step.result,
          notes: step.notes,
        })),
      })),
    };
  }

  async getInterviewReflection(stepId: string): Promise<InterviewReflectionDTO> {
    const step = await this.db.applicationProcessStep.findFirst({
      where: {
        id: stepId,
        applicationAttempt: { userId: this.userId },
      },
      include: {
        interviewDetail: {
          include: {
            reflectionItems: { orderBy: { sortOrder: "asc" } },
          },
        },
      },
    });
    if (!step) {
      throw new CareerRuntimeError("PROCESS_STEP_NOT_FOUND", "Process step not found");
    }
    assertInterviewReflectionStep(step.category);
    if (!step.interviewDetail) {
      return emptyInterviewReflection(step.id);
    }
    return toInterviewReflectionDTO(
      step.id,
      step.interviewDetail.reflectionText,
      step.interviewDetail.reflectionItems,
    );
  }

  async saveInterviewReflection(
    input: SaveInterviewReflectionInput,
  ): Promise<InterviewReflectionDTO> {
    await this.gate();
    const step = await this.requireOwnedStep(input.applicationProcessStepId);
    assertInterviewReflectionStep(step.category);
    const reflectionText = normalizeReflectionText(input.reflectionText);
    const items = normalizeSaveInterviewReflectionItems(input.items ?? []);
    const emptySave = isEmptyInterviewReflectionSave(reflectionText, items);

    return this.db.$transaction(async (tx) => {
      const existingDetail = await tx.applicationInterviewDetail.findUnique({
        where: { applicationProcessStepId: step.id },
        include: { reflectionItems: true },
      });

      if (!existingDetail && emptySave) {
        return emptyInterviewReflection(step.id);
      }

      const detail =
        existingDetail ??
        (await tx.applicationInterviewDetail.create({
          data: { applicationProcessStepId: step.id },
          include: { reflectionItems: true },
        }));

      const existingById = new Map(
        detail.reflectionItems.map((item) => [item.id, item]),
      );
      const suppliedExistingIds = new Set<string>();
      for (const item of items) {
        if (!item.id) continue;
        if (!existingById.has(item.id)) {
          throw new CareerRuntimeError(
            "INTERVIEW_REFLECTION_ITEM_NOT_OWNED",
            "Interview reflection item does not belong to this interview step",
          );
        }
        suppliedExistingIds.add(item.id);
      }

      const savedItems: Array<{
        id: string;
        questionText: string;
        answerNotes: string | null;
        sortOrder: number;
      }> = [];

      for (const [index, item] of items.entries()) {
        const sortOrder = interviewReflectionSortOrder(index);
        if (item.id) {
          const updated = await tx.applicationInterviewReflectionItem.update({
            where: { id: item.id },
            data: {
              questionText: item.questionText,
              answerNotes: item.answerNotes,
              sortOrder,
            },
          });
          savedItems.push(updated);
        } else {
          const created = await tx.applicationInterviewReflectionItem.create({
            data: {
              applicationInterviewDetailId: detail.id,
              questionText: item.questionText,
              answerNotes: item.answerNotes,
              sortOrder,
            },
          });
          savedItems.push(created);
        }
      }

      const omittedIds = detail.reflectionItems
        .filter((item) => !suppliedExistingIds.has(item.id))
        .map((item) => item.id);
      if (omittedIds.length > 0) {
        await tx.applicationInterviewReflectionItem.deleteMany({
          where: {
            id: { in: omittedIds },
            applicationInterviewDetailId: detail.id,
          },
        });
      }

      const updatedDetail = await tx.applicationInterviewDetail.update({
        where: { id: detail.id },
        data: { reflectionText },
      });

      return toInterviewReflectionDTO(
        step.id,
        updatedDetail.reflectionText,
        savedItems,
      );
    });
  }

  async createUserProcessStep(input: {
    jobOpportunityId: string;
    category: string;
    label: string;
    scheduledAt?: Date | null;
    deadlineAt?: Date | null;
    notes?: string | null;
  }) {
    await this.gate();
    this.assertUserStepCategory(input.category);
    const label = input.label.trim();
    if (!label) {
      throw new CareerRuntimeError("PROCESS_STEP_LABEL_REQUIRED", "Process step label is required");
    }
    await this.requireOwnedOpportunity(input.jobOpportunityId);
    const attempt = await this.requireCurrentAttempt(input.jobOpportunityId);
    const max = await this.db.applicationProcessStep.aggregate({
      where: { applicationAttemptId: attempt.id },
      _max: { sortOrder: true },
    });
    return this.db.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: input.category,
        label,
        sortOrder: allocateUserSortOrder(max._max.sortOrder),
        status: PROCESS_STEP_STATUS.PENDING,
        scheduledAt: input.scheduledAt ?? null,
        deadlineAt: input.deadlineAt ?? null,
        notes: input.notes ?? null,
        source: PROCESS_STEP_SOURCE.USER,
      },
    });
  }

  async updateUserProcessStep(input: {
    stepId: string;
    category?: string;
    label?: string;
    scheduledAt?: Date | null;
    deadlineAt?: Date | null;
    notes?: string | null;
    result?: string | null;
  }) {
    await this.gate();
    const existing = await this.requireOwnedStep(input.stepId);
    if (input.category !== undefined) {
      this.assertUserStepCategory(input.category);
    }
    if (input.label !== undefined && !input.label.trim()) {
      throw new CareerRuntimeError("PROCESS_STEP_LABEL_REQUIRED", "Process step label is required");
    }

    if (
      this.isCompletedStep(existing) ||
      existing.source !== PROCESS_STEP_SOURCE.USER
    ) {
      return this.db.applicationProcessStep.update({
        where: { id: existing.id },
        data: {
          notes: input.notes === undefined ? existing.notes : input.notes,
          result: input.result === undefined ? existing.result : input.result,
        },
      });
    }

    return this.db.applicationProcessStep.update({
      where: { id: existing.id },
      data: {
        category: input.category ?? existing.category,
        label: input.label === undefined ? existing.label : input.label.trim(),
        scheduledAt:
          input.scheduledAt === undefined ? existing.scheduledAt : input.scheduledAt,
        deadlineAt:
          input.deadlineAt === undefined ? existing.deadlineAt : input.deadlineAt,
        notes: input.notes === undefined ? existing.notes : input.notes,
        result: input.result === undefined ? existing.result : input.result,
      },
    });
  }

  async completeProcessStep(stepId: string) {
    await this.gate();
    const existing = await this.requireOwnedStep(stepId);
    if (this.isCompletedStep(existing)) {
      return existing;
    }
    return this.db.applicationProcessStep.update({
      where: { id: existing.id },
      data: {
        status: PROCESS_STEP_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });
  }

  async deleteUserProcessStep(stepId: string) {
    await this.gate();
    const existing = await this.requireOwnedStep(stepId);
    if (existing.source !== PROCESS_STEP_SOURCE.USER) {
      throw new CareerRuntimeError(
        "PROCESS_STEP_DELETE_NOT_ALLOWED",
        "Only user-created process steps can be deleted",
      );
    }
    return this.db.applicationProcessStep.delete({
      where: { id: existing.id },
    });
  }

  async ensureCompatibilityProcessStep(input: {
    attemptId: string;
    category: string;
    label: string;
    sortOrder: number;
    status: string;
  }) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(input.attemptId);
    const existing = await this.findCompatibilityStep(
      attempt.id,
      input.category,
    );

    if (existing) {
      if (this.isCompletedStep(existing)) {
        return existing;
      }
      const completing = input.status === PROCESS_STEP_STATUS.COMPLETED;
      return this.db.applicationProcessStep.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          source: PROCESS_STEP_SOURCE.SYSTEM,
          completedAt: completing ? existing.completedAt ?? new Date() : existing.completedAt,
        },
      });
    }

    const completing = input.status === PROCESS_STEP_STATUS.COMPLETED;
    return this.db.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: input.category,
        label: input.label,
        sortOrder: input.sortOrder,
        status: input.status,
        source: PROCESS_STEP_SOURCE.SYSTEM,
        completedAt: completing ? new Date() : null,
      },
    });
  }

  async upsertProcessStep(input: {
    attemptId: string;
    category: string;
    label: string;
    sortOrder: number;
    status?: string;
    scheduledAt?: Date | null;
    deadlineAt?: Date | null;
    completedAt?: Date | null;
    result?: string | null;
    notes?: string | null;
    stepId?: string;
    source?: string;
  }) {
    await this.gate();
    const attempt = await this.requireOwnedAttempt(input.attemptId);
    const status = input.status ?? PROCESS_STEP_STATUS.PENDING;
    const data: Prisma.ApplicationProcessStepUncheckedCreateInput = {
      applicationAttemptId: attempt.id,
      category: input.category,
      label: input.label,
      sortOrder: input.sortOrder,
      status,
      scheduledAt: input.scheduledAt ?? null,
      deadlineAt: input.deadlineAt ?? null,
      completedAt:
        input.completedAt ??
        (status === PROCESS_STEP_STATUS.COMPLETED ? new Date() : null),
      result: input.result ?? null,
      notes: input.notes ?? null,
      source: input.source ?? PROCESS_STEP_SOURCE.USER,
    };

    if (input.stepId) {
      const existing = await this.db.applicationProcessStep.findFirst({
        where: { id: input.stepId, applicationAttemptId: attempt.id },
      });
      if (!existing) {
        throw new CareerRuntimeError("PROCESS_STEP_NOT_FOUND", "Process step not found");
      }
      if (this.isCompletedStep(existing)) {
        return this.db.applicationProcessStep.update({
          where: { id: existing.id },
          data: {
            notes: input.notes === undefined ? existing.notes : input.notes,
            result: input.result === undefined ? existing.result : input.result,
          },
        });
      }
      return this.db.applicationProcessStep.update({
        where: { id: input.stepId },
        data: {
          category: data.category,
          label: data.label,
          sortOrder: data.sortOrder,
          status: data.status,
          scheduledAt: data.scheduledAt,
          deadlineAt: data.deadlineAt,
          completedAt: data.completedAt,
          result: data.result,
          notes: data.notes,
        },
      });
    }

    return this.db.applicationProcessStep.create({ data });
  }

  private isCompletedStep(step: { completedAt: Date | null; status: string }): boolean {
    return step.completedAt != null || step.status === PROCESS_STEP_STATUS.COMPLETED;
  }

  private assertUserStepCategory(category: string): void {
    if (!PROCESS_STEP_CATEGORIES.has(category)) {
      throw new CareerRuntimeError(
        "PROCESS_STEP_CATEGORY_INVALID",
        "Process step category is not supported",
      );
    }
  }

  private async requireOwnedOpportunity(jobOpportunityId: string) {
    const opportunity = await this.db.jobOpportunity.findFirst({
      where: { id: jobOpportunityId, userId: this.userId },
      select: { id: true },
    });
    if (!opportunity) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }
    return opportunity;
  }

  private async requireCurrentAttempt(jobOpportunityId: string) {
    const existing = await this.db.applicationAttempt.findFirst({
      where: {
        jobOpportunityId,
        userId: this.userId,
        archivedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;
    return this.createAttempt({
      jobOpportunityId,
      channelLabel: "USER",
    });
  }

  private async findCompatibilityStep(attemptId: string, category: string) {
    return this.db.applicationProcessStep.findFirst({
      where: {
        applicationAttemptId: attemptId,
        category,
        source: PROCESS_STEP_SOURCE.SYSTEM,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  private async requireOwnedStep(stepId: string) {
    const existing = await this.db.applicationProcessStep.findFirst({
      where: {
        id: stepId,
        applicationAttempt: { userId: this.userId },
      },
    });
    if (!existing) {
      throw new CareerRuntimeError("PROCESS_STEP_NOT_FOUND", "Process step not found");
    }
    return existing;
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
