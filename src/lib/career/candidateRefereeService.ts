import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { assertResumeV1Writable } from "./capabilities";
import { normalizeOptionalText } from "./opportunityService";
import { assertEmail, assertPhone } from "./candidateProfileService";

export type CandidateRefereeInput = {
  name?: string | null;
  organization?: string | null;
  position?: string | null;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
};

const REFEREE_ORDER = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

function assertRefereeName(value: string | null | undefined): string {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new CareerRuntimeError("INVALID_REFEREE_NAME", "Referee name is required.");
  }
  return text;
}

export class CandidateRefereeService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertResumeV1Writable(this.db, this.env);
  }

  private async sensitiveInfoId(): Promise<string> {
    const row = await this.db.candidateSensitiveInfo.upsert({
      where: { userId: this.userId },
      update: {},
      create: { userId: this.userId },
      select: { id: true },
    });
    return row.id;
  }

  async list(input: { includeArchived?: boolean } = {}) {
    return this.db.candidateReferee.findMany({
      where: {
        sensitiveInfo: { userId: this.userId },
        archivedAt: input.includeArchived ? undefined : null,
      },
      orderBy: REFEREE_ORDER,
    });
  }

  async create(input: CandidateRefereeInput) {
    await this.gate();
    const sensitiveInfoId = await this.sensitiveInfoId();
    const last = await this.db.candidateReferee.findFirst({
      where: { sensitiveInfoId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return this.db.candidateReferee.create({
      data: {
        sensitiveInfoId,
        name: assertRefereeName(input.name),
        organization: normalizeOptionalText(input.organization) ?? null,
        position: normalizeOptionalText(input.position) ?? null,
        relationship: normalizeOptionalText(input.relationship) ?? null,
        phone: assertPhone(input.phone) ?? null,
        email: assertEmail(input.email) ?? null,
        note: normalizeOptionalText(input.note) ?? null,
        sortOrder: (last?.sortOrder ?? 0) + 10,
      },
    });
  }

  async update(id: string, input: CandidateRefereeInput) {
    await this.gate();
    const existing = await this.requireOwned(id);
    const name =
      input.name === undefined
        ? undefined
        : assertRefereeName(input.name);
    return this.db.candidateReferee.update({
      where: { id: existing.id },
      data: {
        name,
        organization: normalizeOptionalText(input.organization),
        position: normalizeOptionalText(input.position),
        relationship: normalizeOptionalText(input.relationship),
        phone: input.phone === undefined ? undefined : (assertPhone(input.phone) ?? null),
        email: input.email === undefined ? undefined : (assertEmail(input.email) ?? null),
        note: normalizeOptionalText(input.note),
      },
    });
  }

  // Archive, never physical delete — same semantics as career materials.
  async archive(id: string) {
    await this.gate();
    const existing = await this.requireOwned(id);
    return this.db.candidateReferee.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  }

  private async requireOwned(id: string) {
    const row = await this.db.candidateReferee.findFirst({
      where: { id, sensitiveInfo: { userId: this.userId }, archivedAt: null },
    });
    if (!row) {
      throw new CareerRuntimeError("REFEREE_NOT_FOUND", "Referee not found.");
    }
    return row;
  }
}
