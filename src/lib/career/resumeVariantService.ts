import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { RESUME_VERSION_STATUS } from "./identities";
import { assertAbWritesAllowed } from "./writeGuard";

const IMMUTABLE = new Set<string>([
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
  RESUME_VERSION_STATUS.ARCHIVED,
]);

export class ResumeVariantService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertAbWritesAllowed(this.db, this.env);
  }

  async createVariant(input: {
    name: string;
    targetJobOpportunityId?: string | null;
  }) {
    await this.gate();
    const variant = await this.db.resumeVariant.create({
      data: {
        userId: this.userId,
        name: input.name,
        targetJobOpportunityId: input.targetJobOpportunityId ?? null,
      },
    });
    const version = await this.db.resumeVariantVersion.create({
      data: {
        resumeVariantId: variant.id,
        versionNumber: 1,
        status: RESUME_VERSION_STATUS.DRAFT,
        createdVia: "USER",
      },
    });
    return this.db.resumeVariant.update({
      where: { id: variant.id },
      data: { currentVersionId: version.id },
      include: { currentVersion: true, versions: true },
    });
  }

  async getVersion(versionId: string) {
    await this.gate();
    return this.db.resumeVariantVersion.findFirst({
      where: {
        id: versionId,
        resumeVariant: { userId: this.userId },
      },
      include: {
        sections: {
          include: {
            items: {
              include: {
                expressions: { include: { evidenceLinks: true } },
              },
            },
          },
        },
      },
    });
  }

  async updateDraft(
    versionId: string,
    fields: {
      locale?: string | null;
      headerSnapshot?: string | null;
      layoutConfig?: string | null;
    },
  ) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    this.assertDraft(version.status);
    await this.assertNotSubmittedReference(versionId);
    return this.db.resumeVariantVersion.update({
      where: { id: versionId },
      data: fields,
    });
  }

  async freeze(versionId: string) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    this.assertDraft(version.status);
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
  async editVersion(
    versionId: string,
    fields: {
      locale?: string | null;
      headerSnapshot?: string | null;
      layoutConfig?: string | null;
    },
  ) {
    await this.gate();
    const version = await this.requireOwnedVersion(versionId);
    const referenced = await this.isSubmittedReference(versionId);
    if (version.status === RESUME_VERSION_STATUS.DRAFT && !referenced) {
      return this.db.resumeVariantVersion.update({
        where: { id: versionId },
        data: fields,
      });
    }
    if (!IMMUTABLE.has(version.status) && !referenced) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Cannot edit version in status ${version.status}`,
      );
    }
    return this.cloneAsDraft(version.id, fields);
  }

  private assertDraft(status: string): void {
    if (status !== RESUME_VERSION_STATUS.DRAFT) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Version status ${status} is immutable`,
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

  private async assertNotSubmittedReference(versionId: string): Promise<void> {
    if (await this.isSubmittedReference(versionId)) {
      throw new CareerRuntimeError(
        "SUBMITTED_RESUME_PROVENANCE",
        "Versions referenced by ApplicationAttempt.submittedResumeVersionId cannot be overwritten",
      );
    }
  }

  private async requireOwnedVersion(versionId: string) {
    const version = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: versionId,
        resumeVariant: { userId: this.userId },
      },
    });
    if (!version) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    return version;
  }

  private async cloneAsDraft(
    sourceVersionId: string,
    fields: {
      locale?: string | null;
      headerSnapshot?: string | null;
      layoutConfig?: string | null;
    },
  ) {
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

    const created = await this.db.$transaction(async (tx) => {
      const version = await tx.resumeVariantVersion.create({
        data: {
          resumeVariantId: source.resumeVariantId,
          versionNumber: (latest?.versionNumber ?? source.versionNumber) + 1,
          parentVersionId: source.id,
          status: RESUME_VERSION_STATUS.DRAFT,
          targetJdVersionId: source.targetJdVersionId,
          locale: fields.locale ?? source.locale,
          headerSnapshot: fields.headerSnapshot ?? source.headerSnapshot,
          layoutConfig: fields.layoutConfig ?? source.layoutConfig,
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

    return created;
  }
}
