import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { EVIDENCE_STATUS, RESUME_VERSION_STATUS } from "./identities";
import { sha256Utf8 } from "./hash";
import { assertResumeV1Writable } from "./capabilities";

export function hashEvidenceContent(content: string): string {
  return sha256Utf8(content);
}

export class ResumeProvenanceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertResumeV1Writable(this.db, this.env);
  }

  async getExpressionEvidence(expressionId: string) {
    await this.gate();
    const expression = await this.requireOwnedExpression(expressionId);
    return expression.evidenceLinks;
  }

  async linkEvidenceToExpression(input: {
    expressionId: string;
    evidenceId: string;
  }) {
    await this.gate();
    const expression = await this.requireOwnedMutableExpression(input.expressionId);
    const existing = expression.evidenceLinks.find(
      (link) => link.careerEvidenceId === input.evidenceId,
    );
    if (existing) {
      return existing;
    }

    const evidence = await this.requireOwnedEvidence(input.evidenceId);
    const created = await this.db.resumeExpressionEvidence.create({
      data: {
        resumeExpressionId: expression.id,
        careerEvidenceId: evidence.id,
        evidenceContentSnapshot: evidence.content,
        evidenceHashSnapshot: hashEvidenceContent(evidence.content),
        evidenceUpdatedAtSnapshot: evidence.updatedAt,
      },
    });
    await this.syncEvidenceStatus(expression.id);
    return created;
  }

  async unlinkEvidenceFromExpression(input: {
    expressionId: string;
    evidenceId: string;
  }) {
    await this.gate();
    await this.requireOwnedMutableExpression(input.expressionId);
    await this.db.resumeExpressionEvidence.deleteMany({
      where: {
        resumeExpressionId: input.expressionId,
        careerEvidenceId: input.evidenceId,
      },
    });
    await this.syncEvidenceStatus(input.expressionId);
  }

  async replaceExpressionEvidence(input: {
    expressionId: string;
    evidenceIds: string[];
  }) {
    await this.gate();
    const expression = await this.requireOwnedMutableExpression(input.expressionId);
    const uniqueIds = [...new Set(input.evidenceIds)];
    const evidences = [];
    for (const evidenceId of uniqueIds) {
      evidences.push(await this.requireOwnedEvidence(evidenceId));
    }

    const keep = new Set(uniqueIds);
    const staleLinks = expression.evidenceLinks.filter(
      (link) => !keep.has(link.careerEvidenceId),
    );
    if (staleLinks.length > 0) {
      await this.db.resumeExpressionEvidence.deleteMany({
        where: { id: { in: staleLinks.map((link) => link.id) } },
      });
    }

    const present = new Set(expression.evidenceLinks.map((link) => link.careerEvidenceId));
    for (const evidence of evidences) {
      if (present.has(evidence.id)) continue;
      await this.db.resumeExpressionEvidence.create({
        data: {
          resumeExpressionId: expression.id,
          careerEvidenceId: evidence.id,
          evidenceContentSnapshot: evidence.content,
          evidenceHashSnapshot: hashEvidenceContent(evidence.content),
          evidenceUpdatedAtSnapshot: evidence.updatedAt,
        },
      });
    }

    await this.syncEvidenceStatus(expression.id);
    return this.getExpressionEvidence(expression.id);
  }

  private async syncEvidenceStatus(expressionId: string): Promise<void> {
    const count = await this.db.resumeExpressionEvidence.count({
      where: { resumeExpressionId: expressionId },
    });
    await this.db.resumeExpression.update({
      where: { id: expressionId },
      data: {
        evidenceStatus:
          count > 0 ? EVIDENCE_STATUS.LINKED : EVIDENCE_STATUS.UNLINKED,
      },
    });
  }

  private async requireOwnedMutableExpression(expressionId: string) {
    const expression = await this.requireOwnedExpression(expressionId);
    const version = expression.sectionItem.section.version;
    if (version.resumeVariant.archivedAt) {
      throw new CareerRuntimeError(
        "VARIANT_ARCHIVED",
        "Archived resume variants cannot be edited",
      );
    }
    if (version.status !== RESUME_VERSION_STATUS.DRAFT) {
      throw new CareerRuntimeError(
        "VERSION_IMMUTABLE",
        `Cannot change provenance on ${version.status} version`,
      );
    }
    const referenced = await this.db.applicationAttempt.findFirst({
      where: { submittedResumeVersionId: version.id },
      select: { id: true },
    });
    if (referenced) {
      throw new CareerRuntimeError(
        "SUBMITTED_RESUME_PROVENANCE",
        "Versions referenced by ApplicationAttempt.submittedResumeVersionId cannot be overwritten",
      );
    }
    return expression;
  }

  private async requireOwnedExpression(expressionId: string) {
    const expression = await this.db.resumeExpression.findFirst({
      where: {
        id: expressionId,
        sectionItem: {
          section: {
            version: { resumeVariant: { userId: this.userId } },
          },
        },
      },
      include: {
        evidenceLinks: { orderBy: { createdAt: "asc" } },
        sectionItem: {
          include: {
            section: {
              include: {
                version: {
                  select: {
                    id: true,
                    status: true,
                    resumeVariant: { select: { archivedAt: true } },
                  },
                },
              },
            },
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
    return expression;
  }

  private async requireOwnedEvidence(evidenceId: string) {
    const evidence = await this.db.careerEvidence.findFirst({
      where: {
        id: evidenceId,
        materialItem: { userId: this.userId },
      },
    });
    if (!evidence) {
      throw new CareerRuntimeError(
        "EVIDENCE_NOT_FOUND",
        "Career evidence not found",
      );
    }
    return evidence;
  }
}
