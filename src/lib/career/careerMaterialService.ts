import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  CAREER_MATERIAL_TYPE,
  type CareerMaterialType,
} from "./identities";
import { assertAbWritesAllowed } from "./writeGuard";

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
    await assertAbWritesAllowed(this.db, this.env);
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
    const item = await this.requireOwned(input.id);
    const type = assertType(item.type);
    const nestedKey = detailCreateKey(type);

    return this.db.careerMaterialItem.update({
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
  }

  async confirm(id: string) {
    await this.gate();
    const item = await this.requireOwned(id);
    return this.db.careerMaterialItem.update({
      where: { id: item.id },
      data: { verificationStatus: "USER_CONFIRMED" },
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

  private async requireOwned(id: string) {
    const item = await this.db.careerMaterialItem.findFirst({
      where: { id, userId: this.userId },
    });
    if (!item) {
      throw new CareerRuntimeError("MATERIAL_NOT_FOUND", "Career material not found");
    }
    return item;
  }
}

function detailInclude(type: CareerMaterialType): Prisma.CareerMaterialItemInclude {
  return { [detailCreateKey(type)]: true } as Prisma.CareerMaterialItemInclude;
}
