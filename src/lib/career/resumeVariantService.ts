import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { EVIDENCE_STATUS, RESUME_VERSION_STATUS } from "./identities";
import {
  RESUME_EXPRESSION_KIND,
  RESUME_EXPRESSION_KINDS,
  RESUME_SECTION_ITEM_KIND,
  RESUME_SECTION_ITEM_KINDS,
  RESUME_SECTION_SYSTEM_KINDS,
  VERSION_NUMBER_UNIQUE_RETRY,
} from "./resumeVariantConstants";
import { sanitizeResumeHeaderSnapshot } from "./resumeHeaderSnapshot";
import { assertResumeV1Writable } from "./capabilities";

const IMMUTABLE = new Set<string>([
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
  RESUME_VERSION_STATUS.ARCHIVED,
]);

const SUBMITTABLE_STATUSES = new Set<string>([
  RESUME_VERSION_STATUS.DRAFT,
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
]);

type HeaderFields = {
  locale?: string | null;
  headerSnapshot?: string | null;
  layoutConfig?: string | null;
};

/** Prisma `@@unique([resumeVariantId, versionNumber])` on ResumeVariantVersion. */
const VERSION_NUMBER_UNIQUE_FIELDS = ["resumeVariantId", "versionNumber"] as const;
const VERSION_NUMBER_UNIQUE_INDEX =
  "ResumeVariantVersion_resumeVariantId_versionNumber_key";

function isVersionNumberUniqueTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return target === VERSION_NUMBER_UNIQUE_INDEX;
  }
  if (!Array.isArray(target) || target.length === 0) {
    return false;
  }
  if (target.some((part) => typeof part !== "string")) {
    return false;
  }
  if (target.length === 1) {
    return target[0] === VERSION_NUMBER_UNIQUE_INDEX;
  }
  if (target.length !== VERSION_NUMBER_UNIQUE_FIELDS.length) {
    return false;
  }
  const fields = new Set(target);
  if (fields.size !== VERSION_NUMBER_UNIQUE_FIELDS.length) {
    return false;
  }
  return VERSION_NUMBER_UNIQUE_FIELDS.every((field) => fields.has(field));
}

export function isResumeVersionNumberConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (!("code" in error) || (error as { code?: unknown }).code !== "P2002") {
    return false;
  }
  const meta = "meta" in error ? (error as { meta?: unknown }).meta : undefined;
  if (!meta || typeof meta !== "object") return false;
  return isVersionNumberUniqueTarget((meta as { target?: unknown }).target);
}

function optionalTrimmed(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export class ResumeVariantService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertResumeV1Writable(this.db, this.env);
  }

  async createVariant(input: {
    name: string;
    targetJobOpportunityId?: string | null;
    headerSnapshot?: string | null;
  }) {
    await this.gate();
    const name = input.name.trim();
    if (!name) {
      throw new CareerRuntimeError(
        "VARIANT_NAME_REQUIRED",
        "Resume variant name is required",
      );
    }
    const targetJobOpportunityId = await this.requireOwnedTargetJob(
      input.targetJobOpportunityId,
    );
    const headerSnapshot = sanitizeResumeHeaderSnapshot(input.headerSnapshot);

    return this.db.$transaction(async (tx) => {
      const variant = await tx.resumeVariant.create({
        data: {
          userId: this.userId,
          name,
          targetJobOpportunityId,
        },
      });
      const version = await tx.resumeVariantVersion.create({
        data: {
          resumeVariantId: variant.id,
          versionNumber: 1,
          status: RESUME_VERSION_STATUS.DRAFT,
          createdVia: "USER",
          headerSnapshot,
        },
      });
      return tx.resumeVariant.update({
        where: { id: variant.id },
        data: { currentVersionId: version.id },
        include: { currentVersion: true, versions: true },
      });
    });
  }

  async listVariants() {
    await this.gate();
    const rows = await this.db.resumeVariant.findMany({
      where: { userId: this.userId, archivedAt: null },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        targetJobOpportunityId: true,
        archivedAt: true,
        updatedAt: true,
        targetJobOpportunity: { select: { id: true, title: true } },
        currentVersion: {
          select: {
            id: true,
            versionNumber: true,
            status: true,
            frozenAt: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      targetJobOpportunityId: row.targetJobOpportunityId,
      targetJobTitle: row.targetJobOpportunity?.title ?? null,
      archivedAt: row.archivedAt,
      updatedAt: row.updatedAt,
      currentVersion: row.currentVersion,
    }));
  }

  async getVariant(variantId: string) {
    await this.gate();
    const variant = await this.db.resumeVariant.findFirst({
      where: { id: variantId, userId: this.userId },
      select: {
        id: true,
        name: true,
        targetJobOpportunityId: true,
        archivedAt: true,
        updatedAt: true,
        currentVersionId: true,
        targetJobOpportunity: { select: { id: true, title: true } },
        currentVersion: {
          select: {
            id: true,
            versionNumber: true,
            status: true,
            frozenAt: true,
          },
        },
      },
    });
    if (!variant) {
      throw new CareerRuntimeError("VARIANT_NOT_FOUND", "Resume variant not found");
    }
    return {
      id: variant.id,
      name: variant.name,
      targetJobOpportunityId: variant.targetJobOpportunityId,
      targetJobTitle: variant.targetJobOpportunity?.title ?? null,
      archivedAt: variant.archivedAt,
      updatedAt: variant.updatedAt,
      currentVersionId: variant.currentVersionId,
      currentVersion: variant.currentVersion,
    };
  }

  async renameVariant(variantId: string, name: string) {
    await this.gate();
    const variant = await this.requireOwnedVariant(variantId);
    this.assertNotArchived(variant.archivedAt);
    const trimmed = name.trim();
    if (!trimmed) {
      throw new CareerRuntimeError(
        "VARIANT_NAME_REQUIRED",
        "Resume variant name is required",
      );
    }
    return this.db.resumeVariant.update({
      where: { id: variant.id },
      data: { name: trimmed },
    });
  }

  async archiveVariant(variantId: string) {
    await this.gate();
    const variant = await this.requireOwnedVariant(variantId);
    if (variant.archivedAt) {
      return variant;
    }
    return this.db.resumeVariant.update({
      where: { id: variant.id },
      data: { archivedAt: new Date() },
    });
  }

  async listVariantVersions(variantId: string) {
    await this.gate();
    const variant = await this.requireOwnedVariant(variantId);
    const versions = await this.db.resumeVariantVersion.findMany({
      where: { resumeVariantId: variant.id },
      orderBy: [{ versionNumber: "asc" }, { id: "asc" }],
      select: {
        id: true,
        versionNumber: true,
        status: true,
        frozenAt: true,
        createdAt: true,
        parentVersionId: true,
      },
    });
    return versions.map((version) => ({
      ...version,
      currentVersion: version.id === variant.currentVersionId,
    }));
  }

  async listSubmittableVersions() {
    await this.gate();
    const variants = await this.db.resumeVariant.findMany({
      where: { userId: this.userId, archivedAt: null },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        versions: {
          where: {
            status: {
              in: [
                RESUME_VERSION_STATUS.DRAFT,
                RESUME_VERSION_STATUS.FROZEN,
                RESUME_VERSION_STATUS.SUBMITTED,
              ],
            },
          },
          orderBy: [{ versionNumber: "desc" }, { id: "asc" }],
          select: {
            id: true,
            versionNumber: true,
            status: true,
            frozenAt: true,
          },
        },
      },
    });
    return variants.filter((variant) => variant.versions.length > 0);
  }

  async getVersion(versionId: string) {
    await this.gate();
    const version = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: versionId,
        resumeVariant: { userId: this.userId },
      },
      include: {
        resumeVariant: {
          select: {
            id: true,
            name: true,
            archivedAt: true,
            currentVersionId: true,
          },
        },
        submittedAttempts: { select: { id: true }, take: 1 },
        sections: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              orderBy: { sortOrder: "asc" },
              include: {
                careerMaterialItem: {
                  select: {
                    id: true,
                    title: true,
                    type: true,
                    archivedAt: true,
                  },
                },
                expressions: {
                  orderBy: { sortOrder: "asc" },
                  include: {
                    evidenceLinks: { orderBy: { createdAt: "asc" } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!version) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    return version;
  }

  async resolveWorkspaceVersion(variantId: string, versionId: string) {
    await this.gate();
    const variant = await this.requireOwnedVariant(variantId);
    const version = await this.requireOwnedVersion(versionId);
    if (version.resumeVariant.id !== variant.id) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    return { variantId: variant.id, versionId: version.id };
  }

  async updateDraft(versionId: string, fields: HeaderFields) {
    await this.gate();
    await this.requireOwnedEditableVersion(versionId);
    return this.db.resumeVariantVersion.update({
      where: { id: versionId },
      data: this.sanitizeDraftFields(fields),
    });
  }

  async updateHeaderSnapshot(
    versionId: string,
    header: {
      fullName?: string | null;
      headline?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
      links?: unknown;
    },
  ) {
    await this.gate();
    await this.requireOwnedEditableVersion(versionId);
    const headerSnapshot = sanitizeResumeHeaderSnapshot(
      JSON.stringify({
        fullName: header.fullName ?? null,
        headline: header.headline ?? null,
        email: header.email ?? null,
        phone: header.phone ?? null,
        address: header.address ?? null,
        links: header.links ?? [],
      }),
    );
    return this.db.resumeVariantVersion.update({
      where: { id: versionId },
      data: { headerSnapshot },
    });
  }

  async freeze(versionId: string) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    this.assertNotArchived(version.resumeVariant.archivedAt);
    this.assertDraft(version.status);
    await this.assertNotSubmittedReference(versionId);
    return this.db.resumeVariantVersion.update({
      where: { id: versionId },
      data: {
        status: RESUME_VERSION_STATUS.FROZEN,
        frozenAt: new Date(),
      },
    });
  }

  async markSubmitted(versionId: string) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    this.assertNotArchived(version.resumeVariant.archivedAt);
    if (version.status === RESUME_VERSION_STATUS.SUBMITTED) {
      return version;
    }
    if (IMMUTABLE.has(version.status) && version.status !== RESUME_VERSION_STATUS.FROZEN) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Cannot mark ${version.status} version submitted`,
      );
    }
    return this.db.resumeVariantVersion.update({
      where: { id: versionId },
      data: {
        status: RESUME_VERSION_STATUS.SUBMITTED,
        frozenAt: version.frozenAt ?? new Date(),
      },
    });
  }

  /**
   * DRAFT updates in place. FROZEN/SUBMITTED create a new DRAFT version.
   * Versions referenced by ApplicationAttempt.submittedResumeVersionId are
   * never overwritten.
   */
  async editVersion(versionId: string, fields: HeaderFields) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    this.assertNotArchived(version.resumeVariant.archivedAt);
    const referenced = await this.isSubmittedReference(versionId);
    const sanitized = this.sanitizeDraftFields(fields);
    if (version.status === RESUME_VERSION_STATUS.DRAFT && !referenced) {
      return this.db.resumeVariantVersion.update({
        where: { id: versionId },
        data: sanitized,
      });
    }
    if (!IMMUTABLE.has(version.status) && !referenced) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Cannot edit version in status ${version.status}`,
      );
    }
    return this.cloneAsDraft(version.id, sanitized);
  }

  async createBlankDraft(variantId: string) {
    await this.gate();
    for (let attempt = 0; attempt <= VERSION_NUMBER_UNIQUE_RETRY; attempt += 1) {
      const variant = await this.requireOwnedVariant(variantId);
      this.assertNotArchived(variant.archivedAt);
      const current = variant.currentVersionId
        ? await this.db.resumeVariantVersion.findFirst({
            where: { id: variant.currentVersionId, resumeVariantId: variant.id },
            select: { id: true, status: true },
          })
        : null;
      if (current && (await this.isEditableDraft(current.id, current.status))) {
        throw new CareerRuntimeError(
          "DRAFT_ALREADY_EXISTS",
          "An editable draft already exists for this variant",
        );
      }

      const latest = await this.db.resumeVariantVersion.findFirst({
        where: { resumeVariantId: variant.id },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;

      try {
        return await this.db.$transaction(async (tx) => {
          const version = await tx.resumeVariantVersion.create({
            data: {
              resumeVariantId: variant.id,
              versionNumber,
              parentVersionId: null,
              status: RESUME_VERSION_STATUS.DRAFT,
              createdVia: "USER",
            },
          });
          await tx.resumeVariant.update({
            where: { id: variant.id },
            data: { currentVersionId: version.id },
          });
          return version;
        });
      } catch (error) {
        if (
          attempt < VERSION_NUMBER_UNIQUE_RETRY &&
          isResumeVersionNumberConflict(error)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new CareerRuntimeError(
      "VERSION_NUMBER_CONFLICT",
      "Could not allocate a resume version number",
    );
  }

  async cloneAsDraft(sourceVersionId: string, fields: HeaderFields = {}) {
    await this.gate();
    const sourceOwned = await this.requireOwnedVersion(sourceVersionId);
    this.assertNotArchived(sourceOwned.resumeVariant.archivedAt);
    const sanitized = this.sanitizeDraftFields(fields);

    for (let attempt = 0; attempt <= VERSION_NUMBER_UNIQUE_RETRY; attempt += 1) {
      try {
        return await this.copyVersionGraph(sourceVersionId, sanitized);
      } catch (error) {
        if (
          attempt < VERSION_NUMBER_UNIQUE_RETRY &&
          isResumeVersionNumberConflict(error)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new CareerRuntimeError(
      "VERSION_NUMBER_CONFLICT",
      "Could not allocate a resume version number",
    );
  }

  async createSection(input: {
    versionId: string;
    title: string;
    systemKind?: string | null;
    sortOrder?: number;
  }) {
    await this.gate();
    const version = await this.requireOwnedEditableVersion(input.versionId);
    const title = input.title.trim();
    if (!title) {
      throw new CareerRuntimeError(
        "SECTION_TITLE_REQUIRED",
        "Section title is required",
      );
    }
    const systemKind = this.assertSystemKind(input.systemKind);
    const sortOrder =
      input.sortOrder ??
      (await this.nextSortOrder("resumeVariantSection", {
        resumeVariantVersionId: version.id,
      }));
    return this.db.resumeVariantSection.create({
      data: {
        resumeVariantVersionId: version.id,
        title,
        systemKind,
        sortOrder,
      },
    });
  }

  async updateSection(input: {
    sectionId: string;
    title?: string;
    systemKind?: string | null;
  }) {
    await this.gate();
    const section = await this.requireOwnedEditableSection(input.sectionId);
    const data: Prisma.ResumeVariantSectionUpdateInput = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) {
        throw new CareerRuntimeError(
          "SECTION_TITLE_REQUIRED",
          "Section title is required",
        );
      }
      data.title = title;
    }
    if (input.systemKind !== undefined) {
      data.systemKind = this.assertSystemKind(input.systemKind);
    }
    return this.db.resumeVariantSection.update({
      where: { id: section.id },
      data,
    });
  }

  async deleteSection(sectionId: string) {
    await this.gate();
    const section = await this.requireOwnedEditableSection(sectionId);
    return this.db.resumeVariantSection.delete({
      where: { id: section.id },
    });
  }

  async reorderSections(versionId: string, orderedIds: string[]) {
    await this.gate();
    const version = await this.requireOwnedEditableVersion(versionId);
    const sections = await this.db.resumeVariantSection.findMany({
      where: { resumeVariantVersionId: version.id },
      select: { id: true },
    });
    this.assertCompleteReorder(sections.map((row) => row.id), orderedIds);
    await this.db.$transaction(
      orderedIds.map((id, index) =>
        this.db.resumeVariantSection.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.db.resumeVariantSection.findMany({
      where: { resumeVariantVersionId: version.id },
      orderBy: { sortOrder: "asc" },
    });
  }

  async createSectionItem(input: {
    sectionId: string;
    careerMaterialItemId?: string | null;
    itemKind?: string | null;
  }) {
    await this.gate();
    const section = await this.requireOwnedEditableSection(input.sectionId);
    const careerMaterialItemId = optionalTrimmed(input.careerMaterialItemId ?? null);
    let itemKind = input.itemKind?.trim() || null;
    if (careerMaterialItemId) {
      const material = await this.requireOwnedActiveMaterial(careerMaterialItemId);
      const duplicate = await this.db.resumeVariantSectionItem.findFirst({
        where: {
          resumeVariantSectionId: section.id,
          careerMaterialItemId: material.id,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new CareerRuntimeError(
          "MATERIAL_ALREADY_IN_SECTION",
          "This career material is already in the section",
        );
      }
      if (!itemKind) {
        itemKind = RESUME_SECTION_ITEM_KINDS.has(material.type)
          ? material.type
          : RESUME_SECTION_ITEM_KIND.CUSTOM;
      }
    } else if (!itemKind) {
      itemKind = RESUME_SECTION_ITEM_KIND.MANUAL;
    }
    const kind = this.assertItemKind(itemKind);
    const sortOrder = await this.nextSortOrder("resumeVariantSectionItem", {
      resumeVariantSectionId: section.id,
    });
    return this.db.resumeVariantSectionItem.create({
      data: {
        resumeVariantSectionId: section.id,
        careerMaterialItemId,
        itemKind: kind,
        sortOrder,
      },
    });
  }

  async updateSectionItem(input: {
    itemId: string;
    itemKind?: string;
  }) {
    await this.gate();
    const item = await this.requireOwnedEditableItem(input.itemId);
    const data: Prisma.ResumeVariantSectionItemUpdateInput = {};
    if (input.itemKind !== undefined) {
      data.itemKind = this.assertItemKind(input.itemKind);
    }
    return this.db.resumeVariantSectionItem.update({
      where: { id: item.id },
      data,
    });
  }

  async deleteSectionItem(itemId: string) {
    await this.gate();
    const item = await this.requireOwnedEditableItem(itemId);
    return this.db.resumeVariantSectionItem.delete({
      where: { id: item.id },
    });
  }

  async reorderSectionItems(sectionId: string, orderedIds: string[]) {
    await this.gate();
    const section = await this.requireOwnedEditableSection(sectionId);
    const items = await this.db.resumeVariantSectionItem.findMany({
      where: { resumeVariantSectionId: section.id },
      select: { id: true },
    });
    this.assertCompleteReorder(items.map((row) => row.id), orderedIds);
    await this.db.$transaction(
      orderedIds.map((id, index) =>
        this.db.resumeVariantSectionItem.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.db.resumeVariantSectionItem.findMany({
      where: { resumeVariantSectionId: section.id },
      orderBy: { sortOrder: "asc" },
    });
  }

  async createExpression(input: {
    itemId: string;
    content: string;
    kind?: string | null;
  }) {
    await this.gate();
    const item = await this.requireOwnedEditableItem(input.itemId);
    const content = input.content.trim();
    if (!content) {
      throw new CareerRuntimeError(
        "EXPRESSION_CONTENT_REQUIRED",
        "Expression content is required",
      );
    }
    const kind = this.assertExpressionKind(
      input.kind?.trim() || RESUME_EXPRESSION_KIND.BODY,
    );
    const sortOrder = await this.nextSortOrder("resumeExpression", {
      resumeVariantSectionItemId: item.id,
    });
    return this.db.resumeExpression.create({
      data: {
        resumeVariantSectionItemId: item.id,
        content,
        kind,
        sortOrder,
        evidenceStatus: EVIDENCE_STATUS.UNLINKED,
      },
    });
  }

  async updateExpression(input: {
    expressionId: string;
    content?: string;
    kind?: string;
  }) {
    await this.gate();
    const expression = await this.requireOwnedEditableExpression(input.expressionId);
    const data: Prisma.ResumeExpressionUpdateInput = {};
    if (input.content !== undefined) {
      const content = input.content.trim();
      if (!content) {
        throw new CareerRuntimeError(
          "EXPRESSION_CONTENT_REQUIRED",
          "Expression content is required",
        );
      }
      data.content = content;
    }
    if (input.kind !== undefined) {
      data.kind = this.assertExpressionKind(input.kind);
    }
    return this.db.resumeExpression.update({
      where: { id: expression.id },
      data,
    });
  }

  async deleteExpression(expressionId: string) {
    await this.gate();
    const expression = await this.requireOwnedEditableExpression(expressionId);
    return this.db.resumeExpression.delete({
      where: { id: expression.id },
    });
  }

  async reorderExpressions(itemId: string, orderedIds: string[]) {
    await this.gate();
    const item = await this.requireOwnedEditableItem(itemId);
    const expressions = await this.db.resumeExpression.findMany({
      where: { resumeVariantSectionItemId: item.id },
      select: { id: true },
    });
    this.assertCompleteReorder(expressions.map((row) => row.id), orderedIds);
    await this.db.$transaction(
      orderedIds.map((id, index) =>
        this.db.resumeExpression.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.db.resumeExpression.findMany({
      where: { resumeVariantSectionItemId: item.id },
      orderBy: { sortOrder: "asc" },
    });
  }

  private sanitizeDraftFields(fields: HeaderFields): HeaderFields {
    const data: HeaderFields = {};
    if (fields.locale !== undefined) {
      data.locale = optionalTrimmed(fields.locale);
    }
    if (fields.layoutConfig !== undefined) {
      data.layoutConfig = optionalTrimmed(fields.layoutConfig);
    }
    if (fields.headerSnapshot !== undefined) {
      data.headerSnapshot = fields.headerSnapshot;
    }
    return data;
  }

  private assertDraft(status: string): void {
    if (status !== RESUME_VERSION_STATUS.DRAFT) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Version status ${status} is immutable`,
      );
    }
  }

  private assertNotArchived(archivedAt: Date | null | undefined): void {
    if (archivedAt) {
      throw new CareerRuntimeError(
        "VARIANT_ARCHIVED",
        "Archived resume variants cannot be edited",
      );
    }
  }

  private async isSubmittedReference(versionId: string): Promise<boolean> {
    const attempt = await this.db.applicationAttempt.findFirst({
      where: { submittedResumeVersionId: versionId },
      select: { id: true },
    });
    return attempt != null;
  }

  private async isEditableDraft(versionId: string, status: string): Promise<boolean> {
    if (status !== RESUME_VERSION_STATUS.DRAFT) return false;
    return !(await this.isSubmittedReference(versionId));
  }

  private async assertNotSubmittedReference(versionId: string): Promise<void> {
    if (await this.isSubmittedReference(versionId)) {
      throw new CareerRuntimeError(
        "SUBMITTED_RESUME_PROVENANCE",
        "Versions referenced by ApplicationAttempt.submittedResumeVersionId cannot be overwritten",
      );
    }
  }

  private async requireOwnedVariant(variantId: string) {
    const variant = await this.db.resumeVariant.findFirst({
      where: { id: variantId, userId: this.userId },
    });
    if (!variant) {
      throw new CareerRuntimeError("VARIANT_NOT_FOUND", "Resume variant not found");
    }
    return variant;
  }

  private async requireOwnedVersion(versionId: string) {
    const version = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: versionId,
        resumeVariant: { userId: this.userId },
      },
      include: {
        resumeVariant: {
          select: { id: true, archivedAt: true, currentVersionId: true },
        },
      },
    });
    if (!version) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    return version;
  }

  private async requireOwnedEditableVersion(versionId: string) {
    const version = await this.requireOwnedVersion(versionId);
    this.assertNotArchived(version.resumeVariant.archivedAt);
    this.assertDraft(version.status);
    await this.assertNotSubmittedReference(versionId);
    return version;
  }

  private async requireOwnedEditableSection(sectionId: string) {
    const section = await this.db.resumeVariantSection.findFirst({
      where: {
        id: sectionId,
        version: { resumeVariant: { userId: this.userId } },
      },
      include: {
        version: { select: { id: true } },
      },
    });
    if (!section) {
      throw new CareerRuntimeError("SECTION_NOT_FOUND", "Resume section not found");
    }
    await this.requireOwnedEditableVersion(section.version.id);
    return section;
  }

  private async requireOwnedEditableItem(itemId: string) {
    const item = await this.db.resumeVariantSectionItem.findFirst({
      where: {
        id: itemId,
        section: { version: { resumeVariant: { userId: this.userId } } },
      },
      include: {
        section: { select: { id: true, version: { select: { id: true } } } },
      },
    });
    if (!item) {
      throw new CareerRuntimeError("ITEM_NOT_FOUND", "Resume section item not found");
    }
    await this.requireOwnedEditableVersion(item.section.version.id);
    return item;
  }

  private async requireOwnedEditableExpression(expressionId: string) {
    const expression = await this.db.resumeExpression.findFirst({
      where: {
        id: expressionId,
        sectionItem: {
          section: { version: { resumeVariant: { userId: this.userId } } },
        },
      },
      include: {
        sectionItem: {
          select: {
            id: true,
            section: { select: { version: { select: { id: true } } } },
          },
        },
      },
    });
    if (!expression) {
      throw new CareerRuntimeError(
        "EXPRESSION_NOT_FOUND",
        "Resume expression not found",
      );
    }
    await this.requireOwnedEditableVersion(expression.sectionItem.section.version.id);
    return expression;
  }

  private async requireOwnedActiveMaterial(materialId: string) {
    const material = await this.db.careerMaterialItem.findFirst({
      where: { id: materialId, userId: this.userId },
      select: { id: true, type: true, archivedAt: true },
    });
    if (!material) {
      throw new CareerRuntimeError("MATERIAL_NOT_FOUND", "Career material not found");
    }
    if (material.archivedAt) {
      throw new CareerRuntimeError(
        "MATERIAL_ARCHIVED",
        "Archived career material cannot be added to a resume",
      );
    }
    return material;
  }

  private async requireOwnedTargetJob(jobId: string | null | undefined) {
    if (jobId == null || jobId === "") return null;
    const job = await this.db.jobOpportunity.findFirst({
      where: { id: jobId, userId: this.userId },
      select: { id: true },
    });
    if (!job) {
      throw new CareerRuntimeError(
        "TARGET_JOB_NOT_FOUND",
        "Target job opportunity not found",
      );
    }
    return job.id;
  }

  private assertSystemKind(value: string | null | undefined): string | null {
    if (value == null || value === "") return null;
    if (!RESUME_SECTION_SYSTEM_KINDS.has(value)) {
      throw new CareerRuntimeError(
        "INVALID_SYSTEM_KIND",
        `Unsupported section systemKind: ${value}`,
      );
    }
    return value;
  }

  private assertItemKind(value: string | null | undefined): string {
    const kind = value?.trim() ?? "";
    if (!RESUME_SECTION_ITEM_KINDS.has(kind)) {
      throw new CareerRuntimeError(
        "INVALID_ITEM_KIND",
        `Unsupported resume itemKind: ${kind}`,
      );
    }
    return kind;
  }

  private assertExpressionKind(value: string): string {
    const kind = value.trim();
    if (!RESUME_EXPRESSION_KINDS.has(kind)) {
      throw new CareerRuntimeError(
        "INVALID_EXPRESSION_KIND",
        `Unsupported resume expression kind: ${kind}`,
      );
    }
    return kind;
  }

  private assertCompleteReorder(existingIds: string[], orderedIds: string[]): void {
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new CareerRuntimeError(
        "REORDER_INVALID",
        "Reorder id list contains duplicates",
      );
    }
    if (orderedIds.length !== existingIds.length) {
      throw new CareerRuntimeError(
        "REORDER_INVALID",
        "Reorder id list must include every item exactly once",
      );
    }
    const existing = new Set(existingIds);
    for (const id of orderedIds) {
      if (!existing.has(id)) {
        throw new CareerRuntimeError(
          "REORDER_INVALID",
          "Reorder id list contains an id that does not belong to this parent",
        );
      }
    }
  }

  private async nextSortOrder(
    model: "resumeVariantSection" | "resumeVariantSectionItem" | "resumeExpression",
    where: Record<string, string>,
  ): Promise<number> {
    const delegate = this.db[model] as unknown as {
      aggregate: (args: {
        where: Record<string, string>;
        _max: { sortOrder: true };
      }) => Promise<{ _max: { sortOrder: number | null } }>;
    };
    const agg = await delegate.aggregate({
      where,
      _max: { sortOrder: true },
    });
    return (agg._max.sortOrder ?? -1) + 1;
  }

  private async copyVersionGraph(sourceVersionId: string, fields: HeaderFields) {
    const source = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: sourceVersionId,
        resumeVariant: { userId: this.userId },
      },
      include: {
        sections: {
          include: {
            items: {
              include: {
                expressions: {
                  include: { evidenceLinks: true },
                  orderBy: { sortOrder: "asc" },
                },
              },
              orderBy: { sortOrder: "asc" },
            },
          },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (!source) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }

    const latest = await this.db.resumeVariantVersion.findFirst({
      where: { resumeVariantId: source.resumeVariantId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });

    return this.db.$transaction(async (tx) => {
      const version = await tx.resumeVariantVersion.create({
        data: {
          resumeVariantId: source.resumeVariantId,
          versionNumber: (latest?.versionNumber ?? source.versionNumber) + 1,
          parentVersionId: source.id,
          status: RESUME_VERSION_STATUS.DRAFT,
          targetJdVersionId: source.targetJdVersionId,
          locale: fields.locale !== undefined ? fields.locale : source.locale,
          headerSnapshot:
            fields.headerSnapshot !== undefined
              ? fields.headerSnapshot
              : source.headerSnapshot,
          layoutConfig:
            fields.layoutConfig !== undefined
              ? fields.layoutConfig
              : source.layoutConfig,
          createdVia: "USER",
        },
      });

      for (const section of source.sections) {
        const createdSection = await tx.resumeVariantSection.create({
          data: {
            resumeVariantVersionId: version.id,
            title: section.title,
            systemKind: section.systemKind,
            sortOrder: section.sortOrder,
          },
        });
        for (const item of section.items) {
          const createdItem = await tx.resumeVariantSectionItem.create({
            data: {
              resumeVariantSectionId: createdSection.id,
              careerMaterialItemId: item.careerMaterialItemId,
              itemKind: item.itemKind,
              sortOrder: item.sortOrder,
            },
          });
          for (const expression of item.expressions) {
            const createdExpression = await tx.resumeExpression.create({
              data: {
                resumeVariantSectionItemId: createdItem.id,
                kind: expression.kind,
                content: expression.content,
                sortOrder: expression.sortOrder,
                evidenceStatus: expression.evidenceStatus,
              },
            });
            for (const link of expression.evidenceLinks) {
              await tx.resumeExpressionEvidence.create({
                data: {
                  resumeExpressionId: createdExpression.id,
                  careerEvidenceId: link.careerEvidenceId,
                  evidenceContentSnapshot: link.evidenceContentSnapshot,
                  evidenceHashSnapshot: link.evidenceHashSnapshot,
                  evidenceUpdatedAtSnapshot: link.evidenceUpdatedAtSnapshot,
                },
              });
            }
          }
        }
      }

      await tx.resumeVariant.update({
        where: { id: source.resumeVariantId },
        data: { currentVersionId: version.id },
      });

      return version;
    });
  }
}

export function isSubmittableResumeVersionStatus(status: string): boolean {
  return SUBMITTABLE_STATUSES.has(status);
}
