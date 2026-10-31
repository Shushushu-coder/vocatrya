import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { canonicalize, hashCanonical } from "./hash";
import {
  MATCH_ANALYSIS_SCHEMA_VERSION,
  MATCH_ANALYSIS_STATUS,
  MATCH_ANALYSIS_TYPE,
} from "./identities";
import { hashEvidenceContent } from "./resumeProvenanceService";
import { assertFullAbWritable } from "./capabilities";

export type FastScreeningHashInput = {
  analysisType: typeof MATCH_ANALYSIS_TYPE.FAST_SCREENING;
  analysisSchemaVersion: string;
  jobOpportunityId: string;
  jobDescriptionVersionId: string;
  jobDescriptionParseId: string;
  parseInputHash: string;
  jdContentHash: string;
  careerMaterialSnapshot: unknown;
  preferenceSnapshot: unknown;
};

export type DeepMatchHashInput = {
  analysisType: typeof MATCH_ANALYSIS_TYPE.DEEP_MATCH;
  analysisSchemaVersion: string;
  jobOpportunityId: string;
  jobDescriptionVersionId: string;
  jobDescriptionParseId: string;
  parseInputHash: string;
  jdContentHash: string;
  resumeVariantVersionId: string;
};

export function buildFastScreeningHashInput(
  input: Omit<FastScreeningHashInput, "analysisType">,
): FastScreeningHashInput {
  return {
    analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
    ...input,
  };
}

export function buildDeepMatchHashInput(
  input: Omit<DeepMatchHashInput, "analysisType">,
): DeepMatchHashInput {
  return {
    analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH,
    ...input,
  };
}

export function hashMatchInput(input: FastScreeningHashInput | DeepMatchHashInput): string {
  return hashCanonical(input);
}

function encodeStaleReasons(codes: string[]): string {
  return JSON.stringify([...new Set(codes)].sort());
}

export class MatchAnalysisService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private async gate(): Promise<void> {
    await assertFullAbWritable(this.db, this.env);
  }

  async getAnalysis(analysisId: string) {
    await this.gate();
    const analysis = await this.db.matchAnalysis.findFirst({
      where: { id: analysisId, userId: this.userId },
      include: {
        fastScreeningDetail: true,
        deepMatchDetail: true,
        evidenceLinks: true,
      },
    });
    if (!analysis) {
      throw new CareerRuntimeError("ANALYSIS_NOT_FOUND", "Match analysis not found");
    }
    return analysis;
  }

  async listAnalysesForOpportunity(
    jobOpportunityId: string,
    input: { analysisType?: string } = {},
  ) {
    await this.gate();
    await this.requireOwnedOpportunity(jobOpportunityId);
    return this.db.matchAnalysis.findMany({
      where: {
        userId: this.userId,
        jobOpportunityId,
        ...(input.analysisType ? { analysisType: input.analysisType } : {}),
      },
      include: {
        fastScreeningDetail: true,
        deepMatchDetail: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async createFastScreening(input: {
    jobOpportunityId: string;
    jobDescriptionParseId: string;
    careerMaterialSnapshot: unknown;
    preferenceSnapshot: unknown;
    payload: {
      verdict: string;
      hardRequirements?: string | null;
      coreMatch?: string | null;
      preferenceMatch?: string | null;
      reasons?: string | null;
    };
    resumeVariantVersionId?: string | null;
    provider?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    analysisSchemaVersion?: string;
    resolvedConnectionId?: string | null;
    managedAiProvenance?: string | null;
    // Durable Agent execution this run settles: the analysis row and the
    // execution's COMPLETED + matchAnalysisId link commit in one
    // transaction, closing the "AI finished but nothing persisted" window.
    agentToolExecutionKey?: string;
  }) {
    await this.gate();
    if (input.resumeVariantVersionId) {
      throw new CareerRuntimeError(
        "FAST_SCREENING_FORBIDS_RESUME",
        "Fast screening must not bind a ResumeVariantVersion",
      );
    }

    const parse = await this.requireOwnedParse(
      input.jobOpportunityId,
      input.jobDescriptionParseId,
    );
    const schemaVersion =
      input.analysisSchemaVersion ?? MATCH_ANALYSIS_SCHEMA_VERSION;
    const hashInput = buildFastScreeningHashInput({
      analysisSchemaVersion: schemaVersion,
      jobOpportunityId: input.jobOpportunityId,
      jobDescriptionVersionId: parse.jobDescriptionVersionId,
      jobDescriptionParseId: parse.id,
      parseInputHash: parse.inputHash,
      jdContentHash: parse.jobDescriptionVersion.contentHash,
      careerMaterialSnapshot: input.careerMaterialSnapshot,
      preferenceSnapshot: input.preferenceSnapshot,
    });
    const inputHash = hashMatchInput(hashInput);
    const inputSnapshot = canonicalize(hashInput);
    const completedAt = new Date();

    return this.db.$transaction(async (tx) => {
      const analysis = await tx.matchAnalysis.create({
        data: {
          userId: this.userId,
          jobOpportunityId: input.jobOpportunityId,
          jobDescriptionParseId: parse.id,
          analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
          resumeVariantVersionId: null,
          inputHash,
          analysisSchemaVersion: schemaVersion,
          provider: input.provider ?? null,
          model: input.model ?? null,
          promptVersion: input.promptVersion ?? null,
          status: MATCH_ANALYSIS_STATUS.COMPLETED,
          completedAt,
          resolvedConnectionId: input.resolvedConnectionId ?? null,
          managedAiProvenance: input.managedAiProvenance ?? null,
        },
      });
      await tx.fastScreeningDetail.create({
        data: {
          matchAnalysisId: analysis.id,
          verdict: input.payload.verdict,
          inputSnapshot,
          hardRequirements: input.payload.hardRequirements ?? null,
          coreMatch: input.payload.coreMatch ?? null,
          preferenceMatch: input.payload.preferenceMatch ?? null,
          reasons: input.payload.reasons ?? null,
        },
      });
      if (input.agentToolExecutionKey) {
        const linked = await tx.agentToolExecution.updateMany({
          where: {
            operationKey: input.agentToolExecutionKey,
            status: "PENDING",
          },
          data: {
            status: "COMPLETED",
            matchAnalysisId: analysis.id,
            completedAt,
          },
        });
        if (linked.count !== 1) {
          // The reservation is already settled or was swept — persisting
          // the analysis anyway would create a second history row.
          throw new CareerRuntimeError(
            "TOOL_EXECUTION_CONFLICT",
            "match_job execution is no longer pending",
          );
        }
      }
      return tx.matchAnalysis.findUniqueOrThrow({
        where: { id: analysis.id },
        include: { fastScreeningDetail: true },
      });
    });
  }

  async createDeepMatch(input: {
    jobOpportunityId: string;
    jobDescriptionParseId: string;
    resumeVariantVersionId: string;
    payload: {
      overallSummary: string;
      overallScore?: number | null;
      hardRequirements?: string | null;
      responsibilityAlignment?: string | null;
      experienceRelevance?: string | null;
      skillCoverage?: string | null;
      educationExperienceFit?: string | null;
      strengths?: string | null;
      gaps?: string | null;
      resumeOptimizationOpportunities?: string | null;
      nonFixableGaps?: string | null;
    };
    provider?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    analysisSchemaVersion?: string;
  }) {
    await this.gate();
    if (!input.resumeVariantVersionId) {
      throw new CareerRuntimeError(
        "DEEP_MATCH_REQUIRES_RESUME",
        "Deep match requires a ResumeVariantVersion",
      );
    }

    const parse = await this.requireOwnedParse(
      input.jobOpportunityId,
      input.jobDescriptionParseId,
    );
    await this.requireOwnedVersion(input.resumeVariantVersionId);
    const schemaVersion =
      input.analysisSchemaVersion ?? MATCH_ANALYSIS_SCHEMA_VERSION;
    const hashInput = buildDeepMatchHashInput({
      analysisSchemaVersion: schemaVersion,
      jobOpportunityId: input.jobOpportunityId,
      jobDescriptionVersionId: parse.jobDescriptionVersionId,
      jobDescriptionParseId: parse.id,
      parseInputHash: parse.inputHash,
      jdContentHash: parse.jobDescriptionVersion.contentHash,
      resumeVariantVersionId: input.resumeVariantVersionId,
    });
    const inputHash = hashMatchInput(hashInput);
    const completedAt = new Date();

    return this.db.$transaction(async (tx) => {
      const analysis = await tx.matchAnalysis.create({
        data: {
          userId: this.userId,
          jobOpportunityId: input.jobOpportunityId,
          jobDescriptionParseId: parse.id,
          analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH,
          resumeVariantVersionId: input.resumeVariantVersionId,
          inputHash,
          analysisSchemaVersion: schemaVersion,
          provider: input.provider ?? null,
          model: input.model ?? null,
          promptVersion: input.promptVersion ?? null,
          status: MATCH_ANALYSIS_STATUS.COMPLETED,
          completedAt,
        },
      });
      await tx.deepMatchDetail.create({
        data: {
          matchAnalysisId: analysis.id,
          overallSummary: input.payload.overallSummary,
          overallScore: input.payload.overallScore ?? null,
          hardRequirements: input.payload.hardRequirements ?? null,
          responsibilityAlignment: input.payload.responsibilityAlignment ?? null,
          experienceRelevance: input.payload.experienceRelevance ?? null,
          skillCoverage: input.payload.skillCoverage ?? null,
          educationExperienceFit: input.payload.educationExperienceFit ?? null,
          strengths: input.payload.strengths ?? null,
          gaps: input.payload.gaps ?? null,
          resumeOptimizationOpportunities:
            input.payload.resumeOptimizationOpportunities ?? null,
          nonFixableGaps: input.payload.nonFixableGaps ?? null,
        },
      });
      return tx.matchAnalysis.findUniqueOrThrow({
        where: { id: analysis.id },
        include: { deepMatchDetail: true },
      });
    });
  }

  async linkMatchEvidence(input: {
    matchAnalysisId: string;
    requirementKey: string;
    requirementTextSnapshot: string;
    judgement: string;
    careerEvidenceId?: string | null;
    resumeExpressionId?: string | null;
  }) {
    await this.gate();
    await this.requireOwnedAnalysis(input.matchAnalysisId);

    let evidenceContentSnapshot: string | null = null;
    let evidenceHashSnapshot: string | null = null;
    if (input.careerEvidenceId) {
      const evidence = await this.requireOwnedEvidence(input.careerEvidenceId);
      evidenceContentSnapshot = evidence.content;
      evidenceHashSnapshot = hashEvidenceContent(evidence.content);
    }
    if (input.resumeExpressionId) {
      await this.requireOwnedExpression(input.resumeExpressionId);
    }

    return this.db.matchEvidenceLink.create({
      data: {
        matchAnalysisId: input.matchAnalysisId,
        requirementKey: input.requirementKey,
        requirementTextSnapshot: input.requirementTextSnapshot,
        careerEvidenceId: input.careerEvidenceId ?? null,
        resumeExpressionId: input.resumeExpressionId ?? null,
        judgement: input.judgement,
        evidenceContentSnapshot,
        evidenceHashSnapshot,
      },
    });
  }

  async markStale(analysisId: string, reasonCodes: string[]) {
    await this.gate();
    const analysis = await this.requireOwnedAnalysis(analysisId);
    if (analysis.isStale) {
      return this.db.matchAnalysis.findUniqueOrThrow({
        where: { id: analysis.id },
        include: {
          fastScreeningDetail: true,
          deepMatchDetail: true,
        },
      });
    }
    return this.db.matchAnalysis.update({
      where: { id: analysis.id },
      data: {
        isStale: true,
        staleAt: new Date(),
        staleReasonCodes: encodeStaleReasons(reasonCodes),
      },
      include: {
        fastScreeningDetail: true,
        deepMatchDetail: true,
      },
    });
  }

  async markAnalysesStaleForInputChange(input: {
    jobOpportunityId: string;
    reasonCodes: string[];
    analysisType?: string;
    resumeVariantVersionId?: string | null;
  }) {
    await this.gate();
    await this.requireWritableOpportunity(input.jobOpportunityId);
    const current = await this.db.matchAnalysis.findMany({
      where: {
        userId: this.userId,
        jobOpportunityId: input.jobOpportunityId,
        isStale: false,
        ...(input.analysisType ? { analysisType: input.analysisType } : {}),
        ...(input.resumeVariantVersionId
          ? { resumeVariantVersionId: input.resumeVariantVersionId }
          : {}),
      },
      select: { id: true },
    });
    const updated = [];
    for (const row of current) {
      updated.push(await this.markStale(row.id, input.reasonCodes));
    }
    return updated;
  }

  private async requireOwnedOpportunity(jobOpportunityId: string) {
    const opportunity = await this.db.jobOpportunity.findFirst({
      where: { id: jobOpportunityId, userId: this.userId },
      select: { id: true, archivedAt: true },
    });
    if (!opportunity) {
      throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
    }
    return opportunity;
  }

  private async requireWritableOpportunity(jobOpportunityId: string) {
    const opportunity = await this.requireOwnedOpportunity(jobOpportunityId);
    if (opportunity.archivedAt !== null) {
      throw new CareerRuntimeError(
        "OPPORTUNITY_ARCHIVED",
        "This job is archived. Restore it to edit.",
      );
    }
    return opportunity;
  }

  private async requireOwnedParse(
    jobOpportunityId: string,
    jobDescriptionParseId: string,
  ) {
    await this.requireWritableOpportunity(jobOpportunityId);
    const parse = await this.db.jobDescriptionParse.findFirst({
      where: {
        id: jobDescriptionParseId,
        jobDescriptionVersion: { jobOpportunityId },
      },
      include: {
        jobDescriptionVersion: { select: { id: true, contentHash: true } },
      },
    });
    if (!parse) {
      throw new CareerRuntimeError(
        "PARSE_NOT_FOUND",
        "Job description parse not found for opportunity",
      );
    }
    return parse;
  }

  private async requireOwnedVersion(versionId: string) {
    const version = await this.db.resumeVariantVersion.findFirst({
      where: {
        id: versionId,
        resumeVariant: { userId: this.userId },
      },
      select: { id: true },
    });
    if (!version) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    return version;
  }

  private async requireOwnedAnalysis(analysisId: string) {
    const analysis = await this.db.matchAnalysis.findFirst({
      where: { id: analysisId, userId: this.userId },
    });
    if (!analysis) {
      throw new CareerRuntimeError("ANALYSIS_NOT_FOUND", "Match analysis not found");
    }
    return analysis;
  }

  private async requireOwnedEvidence(evidenceId: string) {
    const evidence = await this.db.careerEvidence.findFirst({
      where: {
        id: evidenceId,
        materialItem: { userId: this.userId },
      },
    });
    if (!evidence) {
      throw new CareerRuntimeError("EVIDENCE_NOT_FOUND", "Career evidence not found");
    }
    return evidence;
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
      select: { id: true },
    });
    if (!expression) {
      throw new CareerRuntimeError(
        "EXPRESSION_NOT_FOUND",
        "Resume expression not found",
      );
    }
    return expression;
  }
}
