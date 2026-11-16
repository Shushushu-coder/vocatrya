import "server-only";

import type { PrismaClient } from "@prisma/client";
import type {
  DeepMatchAnalysisItem,
  DeepMatchDetailDTO,
} from "./deepMatchContract";
import { MATCH_ANALYSIS_TYPE } from "./identities";
import { MatchAnalysisService } from "./matchAnalysisService";

function parseStaleReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((code): code is string => typeof code === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * List persisted DEEP_MATCH analyses for one owned opportunity, newest
 * first. Source labels (JD version, resume version, bound task) are
 * resolved for display — missing rows read as null, never as a different
 * input than the analysis actually used.
 */
export async function listDeepMatchAnalyses(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
  env?: NodeJS.ProcessEnv,
): Promise<DeepMatchAnalysisItem[]> {
  const match = new MatchAnalysisService(db, userId, env);
  const rows = await match.listAnalysesForOpportunity(jobOpportunityId, {
    analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH,
  });
  const analysisIds = rows.map((row) => row.id);
  const [tasks, versions, parses] = await Promise.all([
    db.harnessTask.findMany({
      where: { resultAnalysisId: { in: analysisIds } },
      select: { id: true, resultAnalysisId: true },
    }),
    db.resumeVariantVersion.findMany({
      where: {
        id: {
          in: rows
            .map((row) => row.resumeVariantVersionId)
            .filter((id): id is string => typeof id === "string"),
        },
      },
      select: {
        id: true,
        versionNumber: true,
        resumeVariant: { select: { name: true } },
      },
    }),
    db.jobDescriptionParse.findMany({
      where: { id: { in: rows.map((row) => row.jobDescriptionParseId) } },
      select: {
        id: true,
        jobDescriptionVersion: { select: { versionNumber: true } },
      },
    }),
  ]);
  const taskByAnalysis = new Map(
    tasks.map((task) => [task.resultAnalysisId, task.id] as const),
  );
  const versionById = new Map(versions.map((row) => [row.id, row] as const));
  const parseById = new Map(parses.map((row) => [row.id, row] as const));

  return rows.map((row) => {
    const resumeVersion = row.resumeVariantVersionId
      ? versionById.get(row.resumeVariantVersionId)
      : undefined;
    const parse = parseById.get(row.jobDescriptionParseId);
    const detail = row.deepMatchDetail;
    return {
      id: row.id,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      provider: row.provider,
      model: row.model,
      isStale: row.isStale,
      staleReasonCodes: parseStaleReasons(row.staleReasonCodes),
      deepMatchDetail: detail
        ? ({
            overallSummary: detail.overallSummary,
            overallScore: detail.overallScore,
            hardRequirements: detail.hardRequirements,
            responsibilityAlignment: detail.responsibilityAlignment,
            experienceRelevance: detail.experienceRelevance,
            skillCoverage: detail.skillCoverage,
            educationExperienceFit: detail.educationExperienceFit,
            strengths: detail.strengths,
            gaps: detail.gaps,
            resumeOptimizationOpportunities:
              detail.resumeOptimizationOpportunities,
            nonFixableGaps: detail.nonFixableGaps,
          } satisfies DeepMatchDetailDTO)
        : null,
      taskId: taskByAnalysis.get(row.id) ?? null,
      source: {
        jdVersionNumber: parse?.jobDescriptionVersion.versionNumber ?? null,
        resumeVariantVersionId: row.resumeVariantVersionId,
        resumeVariantName: resumeVersion?.resumeVariant.name ?? null,
        resumeVersionNumber: resumeVersion?.versionNumber ?? null,
      },
    };
  });
}
