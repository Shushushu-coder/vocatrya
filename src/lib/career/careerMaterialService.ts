import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  CAREER_MATERIAL_TYPE,
  type CareerMaterialType,
} from "./identities";
import { assertResumeV1Writable } from "./capabilities";

function detailCreateKey(
  type: CareerMaterialType,
): keyof Prisma.CareerMaterialItemCreateInput {
  switch (type) {
    case "EMPLOYMENT":
      return "employmentDetail";
    case "INTERNSHIP":
      return "internshipDetail";
    case "PROJECT":
      return "projectDetail";
    case "RESEARCH":
      return "researchDetail";
    case "PUBLICATION":
      return "publicationDetail";
    case "COMPETITION":
      return "competitionDetail";
    case "CAMPUS_ACTIVITY":
      return "campusActivityDetail";
    case "EDUCATION":
      return "educationDetail";
    case "AWARD":
      return "awardDetail";
    case "SKILL":
      return "skillDetail";
    case "CERTIFICATION":
      return "certificationDetail";
    case "LANGUAGE":
      return "languageDetail";
    case "CUSTOM":
      return "customDetail";
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

function assertType(type: string): CareerMaterialType {
  if (!(type in CAREER_MATERIAL_TYPE)) {
    throw new CareerRuntimeError(
      "INVALID_MATERIAL_TYPE",
      `Unsupported career material type: ${type}`,
    );
  }
  return type as CareerMaterialType;
}

export class CareerMaterialService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertResumeV1Writable(this.db, this.env);
  }

  async create(input: {
    type: string;
    title: string;
    startDate?: Date | null;
    endDate?: Date | null;
    isCurrent?: boolean;
    notes?: string | null;
    detail?: Record<string, unknown>;
  }) {
    await this.gate();
    const type = assertType(input.type);
    const nestedKey = detailCreateKey(type);
    return this.db.careerMaterialItem.create({
      data: {
        user: { connect: { id: this.userId } },
        type,
        title: input.title,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        isCurrent: input.isCurrent ?? false,
        notes: input.notes ?? null,
        origin: "USER",
        verificationStatus: "USER_AUTHORED",
        [nestedKey]: { create: input.detail ?? {} },
      } as Prisma.CareerMaterialItemCreateInput,
      include: detailInclude(type),
    });
  }

  async update(input: {
    id: string;
    title?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    isCurrent?: boolean;
    notes?: string | null;
    detail?: Record<string, unknown>;
  }) {
    await this.gate();
    return this.db.$transaction(async (tx) => {
      const item = await this.requireOwned(input.id, tx);
      const type = assertType(item.type);
      const nestedKey = detailCreateKey(type);

      // A linked SKILL row takes its display name from the live Tag; letting a
      // generic detail patch rewrite skillName at the same time would create a
      // second name source. The dedicated setSkillTag path owns that column
      // while tagId is set (unlink snapshots the last visible label itself).
      if (type === "SKILL" && input.detail && "skillName" in input.detail) {
        const skill = await tx.careerSkillDetail.findUnique({
          where: { materialItemId: item.id },
          select: { tagId: true },
        });
        if (skill?.tagId) {
          throw new CareerRuntimeError(
            "INVALID_MATERIAL_DETAIL",
            "Skill name follows the linked tag; unlink it to edit text.",
          );
        }
      }

      return tx.careerMaterialItem.update({
        where: { id: item.id },
        data: {
          title: input.title ?? item.title,
          startDate: input.startDate === undefined ? item.startDate : input.startDate,
          endDate: input.endDate === undefined ? item.endDate : input.endDate,
          isCurrent: input.isCurrent ?? item.isCurrent,
          notes: input.notes === undefined ? item.notes : input.notes,
          origin: "USER",
          ...(input.detail
            ? {
                [nestedKey]: {
                  update: input.detail,
                },
              }
            : {}),
        },
        include: detailInclude(type),
      });
    });
  }

  async list(input: { type?: string; includeArchived?: boolean } = {}) {
    const where: { userId: string; type?: string; archivedAt: null | undefined } = {
      userId: this.userId,
      archivedAt: input.includeArchived ? undefined : null,
    } as { userId: string; type?: string; archivedAt: null | undefined };
    if (input.type !== undefined) {
      where.type = assertType(input.type);
    }
    return this.db.careerMaterialItem.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      include: fullDetailInclude,
    });
  }

  async get(id: string) {
    const item = await this.db.careerMaterialItem.findFirst({
      where: { id, userId: this.userId, archivedAt: null },
      include: fullDetailInclude,
    });
    if (!item) {
      throw new CareerRuntimeError("MATERIAL_NOT_FOUND", "Career material not found");
    }
    return item;
  }

  async archive(id: string) {
    await this.gate();
    const item = await this.requireOwned(id);
    return this.db.careerMaterialItem.update({
      where: { id: item.id },
      data: { archivedAt: new Date() },
    });
  }

  async confirm(id: string) {
    await this.gate();
    const item = await this.requireOwned(id);
    return this.db.careerMaterialItem.update({
      where: { id: item.id },
      data: { verificationStatus: "USER_CONFIRMED" },
    });
  }

  /**
   * Dedicated skill↔Tag link channel (BD-LINKS contract). `tagId: null`
   * unlinks; both directions snapshot skillName so the row is still readable
   * if the reference disappears later — on link the current label, on unlink
   * the label the user last saw (falling back to the stored text snapshot).
   * item.title is never touched.
   */
  async setSkillTag(input: { id: string; tagId: string | null }) {
    if (!input || typeof input.id !== "string" || !input.id.trim()) {
      throw new CareerRuntimeError("MATERIAL_NOT_FOUND", "Career material not found");
    }
    if (input.tagId !== null && (typeof input.tagId !== "string" || !input.tagId.trim())) {
      throw new CareerRuntimeError("SKILL_TAG_NOT_FOUND", "Skill tag not found.");
    }
    await this.gate();
    return this.db.$transaction(async (tx) => {
      const item = await this.requireOwned(input.id, tx);
      if (item.type !== "SKILL") {
        throw new CareerRuntimeError(
          "INVALID_MATERIAL_TYPE",
          "Only SKILL materials can link a skill tag.",
        );
      }
      const detail = await tx.careerSkillDetail.findUnique({
        where: { materialItemId: item.id },
        include: { tag: true },
      });
      if (!detail) {
        throw new CareerRuntimeError(
          "MATERIAL_NOT_FOUND",
          "Career material not found",
        );
      }

      if (input.tagId === null) {
        return tx.careerSkillDetail.update({
          where: { id: detail.id },
          data: {
            tagId: null,
            skillName: detail.tag?.label ?? detail.skillName,
          },
          include: { tag: true },
        });
      }

      const tag = await tx.tag.findFirst({
        where: { id: input.tagId, createdBy: this.userId },
      });
      if (!tag) {
        throw new CareerRuntimeError(
          "SKILL_TAG_NOT_FOUND",
          "Skill tag not found.",
        );
      }
      return tx.careerSkillDetail.update({
        where: { id: detail.id },
        data: { tagId: tag.id, skillName: tag.label },
        include: { tag: true },
      });
    });
  }

  async addEvidence(input: {
    materialItemId: string;
    kind: string;
    content: string;
    metricValue?: number | null;
    metricUnit?: string | null;
    metricText?: string | null;
  }) {
    await this.gate();
    await this.requireOwned(input.materialItemId);
    return this.db.careerEvidence.create({
      data: {
        materialItemId: input.materialItemId,
        kind: input.kind,
        content: input.content,
        metricValue: input.metricValue ?? null,
        metricUnit: input.metricUnit ?? null,
        metricText: input.metricText ?? null,
        origin: "USER",
        verificationStatus: "USER_AUTHORED",
      },
    });
  }

  private async requireOwned(id: string, db: PrismaClient | Prisma.TransactionClient = this.db) {
    const item = await db.careerMaterialItem.findFirst({
      where: { id, userId: this.userId },
    });
    if (!item) {
      throw new CareerRuntimeError("MATERIAL_NOT_FOUND", "Career material not found");
    }
    return item;
  }
}

function detailInclude(type: CareerMaterialType): Prisma.CareerMaterialItemInclude {
  if (type === "SKILL") {
    return { skillDetail: { include: { tag: true } } };
  }
  return { [detailCreateKey(type)]: true } as Prisma.CareerMaterialItemInclude;
}

const fullDetailInclude: Prisma.CareerMaterialItemInclude = {
  internshipDetail: true,
  employmentDetail: true,
  projectDetail: true,
  researchDetail: true,
  publicationDetail: true,
  competitionDetail: true,
  campusActivityDetail: true,
  educationDetail: true,
  awardDetail: true,
  skillDetail: { include: { tag: true } },
  certificationDetail: true,
  customDetail: true,
  languageDetail: true,
  evidence: {
    where: { archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  },
};
