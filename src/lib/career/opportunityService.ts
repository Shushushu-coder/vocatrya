import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  FORBIDDEN_OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS,
} from "./identities";
import { assertAbWritesAllowed } from "./writeGuard";

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
  salaryText?: string | null;
  status?: string;
  notes?: string | null;
  closedAt?: Date | null;
  archivedAt?: Date | null;
};

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
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertAbWritesAllowed(this.db, this.env);
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
    salaryText?: string | null;
    status?: string;
    notes?: string | null;
    createdVia?: string | null;
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
        deadline: input.deadline ?? null,
        salaryText: input.salaryText ?? null,
        status,
        notes: input.notes ?? null,
        createdVia: input.createdVia ?? "USER",
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

  async updateSafe(id: string, fields: OpportunitySafeFields) {
    await this.gate();
    const existing = await this.db.jobOpportunity.findFirst({
      where: { id, userId: this.userId },
      select: { id: true },
    });
    if (!existing) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
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
    if (fields.deadline !== undefined) data.deadline = fields.deadline;
    if (fields.salaryText !== undefined) data.salaryText = fields.salaryText;
    if (fields.notes !== undefined) data.notes = fields.notes;
    if (fields.closedAt !== undefined) data.closedAt = fields.closedAt;
    if (fields.archivedAt !== undefined) data.archivedAt = fields.archivedAt;
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
