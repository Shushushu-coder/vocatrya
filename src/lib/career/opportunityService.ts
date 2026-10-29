import type { Prisma, PrismaClient } from "@prisma/client";
import {
  requireDateOnly,
  toInstantIso,
} from "@/lib/datetime";
import { CareerRuntimeError } from "./errors";
import {
  FORBIDDEN_OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS,
} from "./identities";
import { assertFullAbWritable } from "./capabilities";

const ALLOWED_STATUS = new Set<string>(Object.values(OPPORTUNITY_STATUS));
const FORBIDDEN_STATUS = new Set<string>(
  FORBIDDEN_OPPORTUNITY_STATUSES.map((value) => value.toUpperCase()),
);

export type OpportunitySafeFields = {
  companyId?: string;
  title?: string;
  normalizedTitle?: string | null;
  locationText?: string | null;
  employmentType?: string | null;
  recruitmentType?: string | null;
  workplaceType?: string | null;
  sourceSystem?: string | null;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  externalSourceKey?: string | null;
  deadline?: Date | null;
  /** Calendar-day carrier ("YYYY-MM-DD"). When defined, it is the deadline
   *  contract: a string writes deadlineOn+dateOnly and clears `deadline`;
   *  null clears the whole triple. When undefined, `deadline` is the
   *  (instant) carrier instead. Never pass both — deadlineOn wins. */
  deadlineOn?: string | null;
  recruitmentCohort?: string | null;
  recruitmentBatch?: string | null;
  salaryText?: string | null;
  status?: string;
  notes?: string | null;
  closedAt?: Date | null;
};

// A fresh bare Date is an explicitly supplied instant fact. Being exactly
// on a minute boundary says nothing about the input's declared precision.
function instantWritePrecision(
  value: Date | null | undefined,
): string | null {
  if (!value) return null;
  toInstantIso(value);
  return "fullInstant";
}

export function normalizeOptionalText(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertOpportunityStatus(status: string): void {
  const normalized = status.trim().toUpperCase();
  if (FORBIDDEN_STATUS.has(normalized)) {
    throw new CareerRuntimeError(
      "INVALID_OPPORTUNITY_STATUS",
      `JobOpportunity status cannot express process outcomes such as ${normalized}`,
    );
  }
  if (!ALLOWED_STATUS.has(normalized)) {
    throw new CareerRuntimeError(
      "INVALID_OPPORTUNITY_STATUS",
      `Unsupported JobOpportunity status: ${status}`,
    );
  }
}

export class OpportunityService {
  constructor(
    private readonly db: PrismaClient | Prisma.TransactionClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertFullAbWritable(this.db, this.env);
  }

  async create(input: {
    companyId: string;
    title: string;
    campaignId?: string | null;
    locationText?: string | null;
    employmentType?: string | null;
    recruitmentType?: string | null;
    workplaceType?: string | null;
    sourceUrl?: string | null;
    sourceLabel?: string | null;
    deadline?: Date | null;
    deadlineOn?: string | null;
    recruitmentCohort?: string | null;
    recruitmentBatch?: string | null;
    salaryText?: string | null;
    status?: string;
    notes?: string | null;
    createdVia?: string | null;
    externalSourceKey?: string | null;
  }) {
    await this.gate();
    const status = (input.status ?? OPPORTUNITY_STATUS.UNKNOWN).toUpperCase();
    assertOpportunityStatus(status);

    const company = await this.db.company.findFirst({
      where: { id: input.companyId, createdBy: this.userId },
      select: { id: true },
    });
    if (!company) {
      throw new CareerRuntimeError("COMPANY_NOT_FOUND", "Company not found");
    }
    const deadlineOn =
      input.deadlineOn == null ? null : requireDateOnly(input.deadlineOn);

    return this.db.jobOpportunity.create({
      data: {
        userId: this.userId,
        companyId: input.companyId,
        campaignId: input.campaignId ?? null,
        title: input.title,
        locationText: input.locationText ?? null,
        employmentType: input.employmentType ?? null,
        recruitmentType: input.recruitmentType ?? null,
        workplaceType: input.workplaceType ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sourceLabel: input.sourceLabel ?? null,
        // A defined deadlineOn is the dateOnly contract and always wins over
        // the instant carrier — never store a fake UTC/local midnight.
        deadline: deadlineOn ? null : (input.deadline ?? null),
        deadlineOn,
        deadlinePrecision: deadlineOn
          ? "dateOnly"
          : instantWritePrecision(input.deadline),
        recruitmentCohort: normalizeOptionalText(input.recruitmentCohort) ?? null,
        recruitmentBatch: normalizeOptionalText(input.recruitmentBatch) ?? null,
        salaryText: input.salaryText ?? null,
        status,
        notes: input.notes ?? null,
        createdVia: input.createdVia ?? "USER",
        ...(input.externalSourceKey
          ? { externalSourceKey: input.externalSourceKey }
          : {}),
      },
    });
  }

  async get(id: string) {
    await this.gate();
    return this.db.jobOpportunity.findFirst({
      where: { id, userId: this.userId },
    });
  }

  async list(input: { includeArchived?: boolean } = {}) {
    await this.gate();
    return this.db.jobOpportunity.findMany({
      where: {
        userId: this.userId,
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Reversible archive — the ONLY writer of archivedAt. Idempotent: archiving
   * an already-archived row is a no-op success; a missing/foreign id still
   * throws NOT_FOUND so callers can't distinguish ownership from absence.
   * Reminder suppression runs in the caller's transaction.
   */
  async archive(id: string): Promise<boolean> {
    await this.gate();
    const { count } = await this.db.jobOpportunity.updateMany({
      where: { id, userId: this.userId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (count === 0) await this.assertOwned(id);
    return count > 0;
  }

  /** Reverse of archive. Idempotent the same way. */
  async unarchive(id: string): Promise<boolean> {
    await this.gate();
    const { count } = await this.db.jobOpportunity.updateMany({
      where: { id, userId: this.userId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    if (count === 0) await this.assertOwned(id);
    return count > 0;
  }

  private async assertOwned(id: string) {
    const existing = await this.db.jobOpportunity.findFirst({
      where: { id, userId: this.userId },
      select: { id: true },
    });
    if (!existing) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }
  }

  async updateSafe(id: string, fields: OpportunitySafeFields) {
    await this.gate();
    const existing = await this.db.jobOpportunity.findFirst({
      where: { id, userId: this.userId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }
    // Archived rows are read-only; unarchive() is the only way back.
    if (existing.archivedAt) {
      throw new CareerRuntimeError(
        "OPPORTUNITY_ARCHIVED",
        "This job is archived. Restore it to edit.",
      );
    }

    const data: Prisma.JobOpportunityUpdateInput = {};
    if (fields.companyId !== undefined) {
      const company = await this.db.company.findFirst({
        where: { id: fields.companyId, createdBy: this.userId },
        select: { id: true },
      });
      if (!company) {
        throw new CareerRuntimeError("COMPANY_NOT_FOUND", "Company not found");
      }
      data.company = { connect: { id: company.id } };
    }
    if (fields.title !== undefined) data.title = fields.title;
    if (fields.normalizedTitle !== undefined) {
      data.normalizedTitle = fields.normalizedTitle;
    }
    if (fields.locationText !== undefined) data.locationText = fields.locationText;
    if (fields.employmentType !== undefined) {
      data.employmentType = fields.employmentType;
    }
    if (fields.recruitmentType !== undefined) {
      data.recruitmentType = fields.recruitmentType;
    }
    if (fields.workplaceType !== undefined) {
      data.workplaceType = fields.workplaceType;
    }
    if (fields.sourceSystem !== undefined) data.sourceSystem = fields.sourceSystem;
    if (fields.sourceLabel !== undefined) data.sourceLabel = fields.sourceLabel;
    if (fields.sourceUrl !== undefined) data.sourceUrl = fields.sourceUrl;
    if (fields.externalSourceKey !== undefined) {
      data.externalSourceKey = fields.externalSourceKey;
    }
    // Single carrier: an explicit deadlineOn (incl. null = clear all three)
    // supersedes; a bare `deadline` write clears deadlineOn so a stale DateOnly
    // can't shadow the instant.
    if (fields.deadlineOn !== undefined) {
      const on =
        fields.deadlineOn === null ? null : requireDateOnly(fields.deadlineOn);
      data.deadlineOn = on;
      data.deadlinePrecision = on ? "dateOnly" : null;
      data.deadline = null;
    } else if (fields.deadline !== undefined) {
      data.deadline = fields.deadline;
      data.deadlineOn = null;
      data.deadlinePrecision = instantWritePrecision(fields.deadline);
    }
    if (fields.recruitmentCohort !== undefined) {
      data.recruitmentCohort =
        normalizeOptionalText(fields.recruitmentCohort) ?? null;
    }
    if (fields.recruitmentBatch !== undefined) {
      data.recruitmentBatch =
        normalizeOptionalText(fields.recruitmentBatch) ?? null;
    }
    if (fields.salaryText !== undefined) data.salaryText = fields.salaryText;
    if (fields.notes !== undefined) data.notes = fields.notes;
    if (fields.closedAt !== undefined) data.closedAt = fields.closedAt;
    if (fields.status !== undefined) {
      const status = fields.status.toUpperCase();
      assertOpportunityStatus(status);
      data.status = status;
    }

    return this.db.jobOpportunity.update({
      where: { id },
      data,
    });
  }
}
