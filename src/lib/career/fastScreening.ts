import "server-only";

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import type { ExecuteAIConnectionTextDeps } from "@/lib/ai/execution";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { removeHtmlTags } from "@/lib/ai/tools/text-processing";
import type { StructuredOutputSchema } from "@/lib/ai/structured-output";
import { CareerRuntimeError } from "./errors";
import { canonicalize, hashCanonical } from "./hash";
import {
  FAST_SCREENING_ERROR_CODES,
  type FastScreeningAssignmentState,
  type FastScreeningPreflight,
  type FastScreeningResumeOption,
  type FastScreeningRunResult,
  type FastScreeningSource,
  type MatchAnalysisListItem,
} from "./fastScreeningContract";
import {
  MATCH_ANALYSIS_TYPE,
  MATCH_STALE_REASON,
} from "./identities";
import { CareerMaterialService } from "./careerMaterialService";
import { JobSearchPreferenceService } from "./jobSearchPreferenceService";
import { ResumeVariantService } from "./resumeVariantService";
import { MatchAnalysisService } from "./matchAnalysisService";
import { buildMaterialItemText } from "./applicationCopy";
import { projectResumeVariantText } from "./resumeVariantText";

/**
 * Canonical minimal match chain (RM-MATCH): FAST_SCREENING only.
 *
 *   source selection → material/preference snapshot → deterministic
 *   JobDescriptionParse (raw-text pass-through; the AI JD-parse pipeline
 *   does not exist in canonical yet) → MATCH_ANALYSIS assignment
 *   resolution → structured TEXT_ONLY execution → MatchAnalysisService
 *   persistence → stale marking of superseded analyses.
 *
 * A failed run persists nothing: MatchAnalysis rows are completed
 * analyses only (MATCH_ANALYSIS_STATUS.COMPLETED), so "connection broke"
 * surfaces as a retryable action error rather than a failed row.
 */

/** Parse identity for the raw-text pass-through — no AI JD parse exists yet. */
const FAST_SCREENING_PARSER_VERSION = "jd-raw-text-v1";
const FAST_SCREENING_PARSE_SCHEMA_VERSION = "1";
const FAST_SCREENING_SCHEMA_NAME = "vocatrya_fast_screening_v1";
const MANAGED_BUSINESS = "MATCH_ANALYSIS";

const FAST_SCREENING_RESULT_SCHEMA: StructuredOutputSchema = {
  type: "object",
  // Strict-schema compliant (same rule AGENT_DECISION_SCHEMA follows):
  // native-schema transports (codex --output-schema → OpenAI strict
  // response_format) require every `properties` key in `required` —
  // optional fields stay required and express "absent" as null.
  required: [
    "verdict",
    "reasons",
    "hardRequirements",
    "coreMatch",
    "preferenceMatch",
  ],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["PASS", "BORDERLINE", "FAIL"] },
    reasons: { type: "string" },
    hardRequirements: { type: ["string", "null"] },
    coreMatch: { type: ["string", "null"] },
    preferenceMatch: { type: ["string", "null"] },
  },
};

const FAST_SCREENING_SYSTEM_PROMPT = `You are an expert recruiter performing a fast screening of a candidate against a job description. You receive the job description, the candidate's career material, and the candidate's job-search preferences (when provided).

## VERDICT VALUES
- PASS: the candidate clearly meets the core requirements — worth applying now
- BORDERLINE: the candidate partially meets requirements — apply only with a tailored positioning
- FAIL: the candidate misses core requirements — deprioritize

## RULES
- Judge only what the job description explicitly requires; credit transferable evidence from different technologies or industries.
- Never inflate: most candidates are BORDERLINE for any given job. Be honest about gaps.
- hardRequirements: one short paragraph on mandatory-requirement coverage and the gaps, or null when the job description lists none.
- coreMatch: one short paragraph on experience and skill alignment.
- preferenceMatch: one short paragraph on fit with the candidate's stated preferences — null when no preferences were provided.
- reasons: 2-4 sentences on the decisive factors behind the verdict.`;

function buildFastScreeningPrompt(input: {
  jobText: string;
  materialText: string;
  preferenceText: string | null;
}): string {
  return `Screen this candidate against the job description.

JOB DESCRIPTION:
${input.jobText}

CANDIDATE MATERIAL:
${input.materialText}

JOB-SEARCH PREFERENCES:
${input.preferenceText ?? "(none provided)"}`;
}

function toListItem(row: {
  id: string;
  analysisType: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  provider: string | null;
  model: string | null;
  isStale: boolean;
  staleReasonCodes: string | null;
  fastScreeningDetail: {
    verdict: string;
    hardRequirements: string | null;
    coreMatch: string | null;
    preferenceMatch: string | null;
    reasons: string | null;
  } | null;
}): MatchAnalysisListItem {
  let staleReasonCodes: string[] = [];
  if (row.staleReasonCodes) {
    try {
      const parsed = JSON.parse(row.staleReasonCodes);
      if (Array.isArray(parsed)) {
        staleReasonCodes = parsed.filter((code) => typeof code === "string");
      }
    } catch {
      staleReasonCodes = [];
    }
  }
  return {
    id: row.id,
    analysisType: row.analysisType,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    provider: row.provider,
    model: row.model,
    isStale: row.isStale,
    staleReasonCodes,
    fastScreeningDetail: row.fastScreeningDetail
      ? {
          verdict: row.fastScreeningDetail.verdict,
          hardRequirements: row.fastScreeningDetail.hardRequirements,
          coreMatch: row.fastScreeningDetail.coreMatch,
          preferenceMatch: row.fastScreeningDetail.preferenceMatch,
          reasons: row.fastScreeningDetail.reasons,
        }
      : null,
  };
}

async function requireOwnedOpportunity(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
) {
  const opportunity = await db.jobOpportunity.findFirst({
    where: { id: jobOpportunityId, userId },
    include: {
      currentJdVersion: {
        select: {
          id: true,
          rawContent: true,
          rawContentFormat: true,
          contentHash: true,
        },
      },
    },
  });
  if (!opportunity) {
    throw new CareerRuntimeError(
      "OPPORTUNITY_NOT_FOUND",
      "Opportunity not found",
    );
  }
  return opportunity;
}

export function jobDescriptionText(version: {
  rawContent: string;
  rawContentFormat: string;
}): string {
  const text =
    version.rawContentFormat === "HTML"
      ? removeHtmlTags(version.rawContent)
      : version.rawContent.trim();
  return text;
}

type PreferenceSnapshot = Record<string, unknown>;

async function loadPreferenceSnapshot(
  db: PrismaClient,
  userId: string,
  env?: NodeJS.ProcessEnv,
): Promise<{
  snapshot: PreferenceSnapshot;
  text: string | null;
  present: boolean;
}> {
  const preferences = new JobSearchPreferenceService(db, userId, env);
  const row = await preferences.getJobSearchPreference();
  const fields = {
    targetRoles: row?.targetRoles ?? null,
    preferredCities: row?.preferredCities ?? null,
    preferredIndustries: row?.preferredIndustries ?? null,
    recruitmentTypes: row?.recruitmentTypes ?? null,
    availability: row?.availability ?? null,
    hardConstraints: row?.hardConstraints ?? null,
    softPreferences: row?.softPreferences ?? null,
  };
  const entries = Object.entries(fields).filter(
    ([, value]) => typeof value === "string" && value.trim() !== "",
  );
  if (entries.length === 0) {
    return { snapshot: {}, text: null, present: false };
  }
  return {
    snapshot: fields,
    text: entries.map(([key, value]) => `${key}: ${value}`).join("\n"),
    present: true,
  };
}

async function buildCareerProfileMaterial(
  db: PrismaClient,
  userId: string,
  env?: NodeJS.ProcessEnv,
): Promise<{
  snapshot: Record<string, unknown>;
  text: string;
  materialsCount: number;
}> {
  const materials = new CareerMaterialService(db, userId, env);
  const items = await materials.list();
  const entries = items
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      text: buildMaterialItemText(item),
    }))
    .filter((item) => item.text.trim() !== "");
  return {
    snapshot: {
      kind: "CAREER_PROFILE",
      items: entries.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        text: item.text,
      })),
    },
    text: entries.map((item) => item.text).join("\n\n"),
    materialsCount: items.length,
  };
}

export async function buildResumeVersionMaterial(
  db: PrismaClient,
  userId: string,
  versionId: string,
  env?: NodeJS.ProcessEnv,
): Promise<{
  snapshot: Record<string, unknown>;
  text: string;
}> {
  const variants = new ResumeVariantService(db, userId, env);
  const version = await variants.getVersion(versionId);
  const text = projectResumeVariantText({
    headerSnapshot: version.headerSnapshot,
    sections: version.sections,
  });
  return {
    snapshot: {
      kind: "RESUME_VERSION",
      resumeVariantVersionId: version.id,
      resumeVariantName: version.resumeVariant.name,
      versionNumber: version.versionNumber,
      text,
    },
    text,
  };
}

async function listResumeVersionOptions(
  db: PrismaClient,
  userId: string,
  env?: NodeJS.ProcessEnv,
): Promise<FastScreeningResumeOption[]> {
  const variants = new ResumeVariantService(db, userId, env);
  const rows = await variants.listSubmittableVersions();
  return rows.flatMap((variant) =>
    variant.versions.map((version) => ({
      versionId: version.id,
      variantId: variant.id,
      variantName: variant.name,
      versionNumber: version.versionNumber,
      status: version.status,
    })),
  );
}

/**
 * The deterministic parse the minimal chain anchors analyses to: the JD
 * pass-through, keyed by content hash so later runs on unchanged content
 * reuse the same row. A real AI JD-parse pipeline can coexist later —
 * parses are per-(version, inputHash), never overwritten.
 */
export async function ensureRawTextParse(
  db: PrismaClient,
  version: {
    id: string;
    contentHash: string;
    rawContent: string;
    rawContentFormat: string;
  },
  jobText: string,
) {
  const inputHash = hashCanonical({
    schemaVersion: FAST_SCREENING_PARSE_SCHEMA_VERSION,
    parserVersion: FAST_SCREENING_PARSER_VERSION,
    jdContentHash: version.contentHash,
  });
  const existing = await db.jobDescriptionParse.findFirst({
    where: { jobDescriptionVersionId: version.id, inputHash },
  });
  if (existing) return existing;
  const created = await db.jobDescriptionParse.create({
    data: {
      jobDescriptionVersionId: version.id,
      schemaVersion: FAST_SCREENING_PARSE_SCHEMA_VERSION,
      parserVersion: FAST_SCREENING_PARSER_VERSION,
      structuredData: JSON.stringify({ kind: "RAW_TEXT", text: jobText }),
      parseStatus: "SUCCEEDED",
      inputHash,
      parsedAt: new Date(),
    },
  });
  await db.jobDescriptionVersion.update({
    where: { id: version.id },
    data: { currentParseId: created.id },
  });
  return created;
}

function readSnapshotField(
  inputSnapshot: string | null | undefined,
): Record<string, unknown> | null {
  if (!inputSnapshot) return null;
  try {
    const parsed = JSON.parse(inputSnapshot);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Marks every other non-stale FAST_SCREENING analysis of the opportunity
 * stale when its persisted input snapshot no longer matches the inputs
 * the fresh run used. Reason codes name the changed input, computed from
 * the stored snapshots — never guessed. Analyses re-run against identical
 * inputs keep their fresh state.
 */
async function markSupersededAnalysesStale(input: {
  match: MatchAnalysisService;
  jobOpportunityId: string;
  freshAnalysisId: string;
  hashInput: Record<string, unknown>;
}) {
  const analyses = await input.match.listAnalysesForOpportunity(
    input.jobOpportunityId,
    { analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING },
  );
  for (const analysis of analyses) {
    if (analysis.id === input.freshAnalysisId || analysis.isStale) continue;
    const previous = readSnapshotField(
      analysis.fastScreeningDetail?.inputSnapshot,
    );
    if (!previous) continue;
    const reasonCodes: string[] = [];
    if (previous.jdContentHash !== input.hashInput.jdContentHash) {
      reasonCodes.push(MATCH_STALE_REASON.JD_CHANGED);
    }
    if (
      canonicalize(previous.careerMaterialSnapshot) !==
      canonicalize(input.hashInput.careerMaterialSnapshot)
    ) {
      reasonCodes.push(MATCH_STALE_REASON.CAREER_MATERIAL_CHANGED);
    }
    if (
      canonicalize(previous.preferenceSnapshot) !==
      canonicalize(input.hashInput.preferenceSnapshot)
    ) {
      reasonCodes.push(MATCH_STALE_REASON.PREFERENCE_CHANGED);
    }
    if (reasonCodes.length > 0) {
      await input.match.markStale(analysis.id, reasonCodes);
    }
  }
}

export async function loadFastScreeningPreflight(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
  env?: NodeJS.ProcessEnv,
): Promise<FastScreeningPreflight> {
  const [opportunity, material, preference, resumeVersions, resolution] =
    await Promise.all([
      requireOwnedOpportunity(db, userId, jobOpportunityId),
      buildCareerProfileMaterial(db, userId, env),
      loadPreferenceSnapshot(db, userId, env),
      listResumeVersionOptions(db, userId, env),
      resolveBusinessAIConfig(
        { userId, purpose: "MATCH_ANALYSIS" },
        db,
      ),
    ]);

  const assignment: FastScreeningAssignmentState =
    resolution.status === "RESOLVED"
      ? {
          status: "RESOLVED",
          provider: resolution.provider,
          model: resolution.model,
        }
      : resolution.status === "INVALID_ASSIGNMENT"
        ? { status: "INVALID_ASSIGNMENT", code: resolution.code }
        : { status: "NOT_CONFIGURED" };

  return {
    hasJobDescription:
      opportunity.currentJdVersion !== null &&
      jobDescriptionText(opportunity.currentJdVersion) !== "",
    materialsCount: material.materialsCount,
    resumeVersions,
    hasPreference: preference.present,
    assignment,
  };
}

export async function listFastScreeningAnalyses(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
  env?: NodeJS.ProcessEnv,
): Promise<MatchAnalysisListItem[]> {
  const match = new MatchAnalysisService(db, userId, env);
  const rows = await match.listAnalysesForOpportunity(jobOpportunityId, {
    analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
  });
  return rows.map(toListItem);
}

export async function runFastScreening(
  db: PrismaClient,
  userId: string,
  input: {
    jobOpportunityId: string;
    source: FastScreeningSource;
  },
  deps: ExecuteAIConnectionTextDeps = {},
  env?: NodeJS.ProcessEnv,
  options?: {
    /**
     * Durable AgentToolExecution.operationKey. When set it becomes the
     * managed operationId/resourceKey (crash recovery re-runs under the
     * same identity and replays instead of double-billing) and the
     * persisted analysis completes that execution row in the same
     * transaction. Absent means a standalone run — a fresh identity per
     * call, exactly what the job-detail button does today.
     */
    executionKey?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<FastScreeningRunResult> {
  const opportunity = await requireOwnedOpportunity(
    db,
    userId,
    input.jobOpportunityId,
  );
  const version = opportunity.currentJdVersion;
  const jobText = version ? jobDescriptionText(version) : "";
  if (!version || jobText === "") {
    return { kind: "failed", code: FAST_SCREENING_ERROR_CODES.JD_MISSING };
  }

  const preference = await loadPreferenceSnapshot(db, userId, env);
  let material: { snapshot: Record<string, unknown>; text: string };
  if (input.source.kind === "career-profile") {
    material = await buildCareerProfileMaterial(db, userId, env);
  } else {
    material = await buildResumeVersionMaterial(
      db,
      userId,
      input.source.versionId,
      env,
    );
  }
  // An empty selected source means the model would screen the JD alone —
  // refuse honestly instead of producing a confidence-looking guess.
  if (material.text.trim() === "" && !preference.present) {
    return {
      kind: "failed",
      code: FAST_SCREENING_ERROR_CODES.INSUFFICIENT_MATERIAL,
    };
  }

  const parse = await ensureRawTextParse(db, version, jobText);
  const hashInput = {
    careerMaterialSnapshot: material.snapshot,
    preferenceSnapshot: preference.snapshot,
  };
  // A standalone run mints a fresh identity; an Agent execution reuses its
  // reserved operationKey so crash recovery replays the same operation.
  const operationKey = options?.executionKey ?? `match-analysis:${randomUUID()}`;

  const executed = await executeStructuredForAssignment(
    {
      userId,
      purpose: "MATCH_ANALYSIS",
      prompt: `${FAST_SCREENING_SYSTEM_PROMPT}\n\n${buildFastScreeningPrompt({
        jobText,
        materialText: material.text,
        preferenceText: preference.text,
      })}`,
      schema: FAST_SCREENING_RESULT_SCHEMA,
      schemaName: FAST_SCREENING_SCHEMA_NAME,
      // Each run is its own durable operation + binding resource: retries
      // mint a fresh identity, a re-click can never replay an old receipt.
      operationId: operationKey,
      managedResource: {
        business: MANAGED_BUSINESS,
        resourceKey: operationKey,
      },
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    },
    deps,
  );

  if (executed.status === "NOT_CONFIGURED") {
    return { kind: "failed", code: FAST_SCREENING_ERROR_CODES.NOT_CONFIGURED };
  }
  if (executed.status !== "OK") {
    return {
      kind: "failed",
      code: executed.code,
      detail: executed.issueSummary,
    };
  }

  const value = executed.value as {
    verdict?: unknown;
    reasons?: unknown;
    hardRequirements?: unknown;
    coreMatch?: unknown;
    preferenceMatch?: unknown;
  };
  const textOrNull = (field: unknown): string | null =>
    typeof field === "string" && field.trim() !== "" ? field : null;

  const match = new MatchAnalysisService(db, userId, env);
  const analysis = await match.createFastScreening({
    jobOpportunityId: opportunity.id,
    jobDescriptionParseId: parse.id,
    careerMaterialSnapshot: hashInput.careerMaterialSnapshot,
    preferenceSnapshot: hashInput.preferenceSnapshot,
    payload: {
      verdict: typeof value.verdict === "string" ? value.verdict : "BORDERLINE",
      reasons: textOrNull(value.reasons),
      hardRequirements: textOrNull(value.hardRequirements),
      coreMatch: textOrNull(value.coreMatch),
      preferenceMatch: textOrNull(value.preferenceMatch),
    },
    provider: executed.provider,
    model: executed.resolvedModel,
    resolvedConnectionId: executed.resolvedConnectionId,
    managedAiProvenance: executed.managedAiProvenance
      ? JSON.stringify(executed.managedAiProvenance)
      : null,
    agentToolExecutionKey: options?.executionKey,
  });

  await markSupersededAnalysesStale({
    match,
    jobOpportunityId: opportunity.id,
    freshAnalysisId: analysis.id,
    hashInput: {
      jdContentHash: version.contentHash,
      careerMaterialSnapshot: hashInput.careerMaterialSnapshot,
      preferenceSnapshot: hashInput.preferenceSnapshot,
    },
  });

  const persisted = await match.getAnalysis(analysis.id);
  return { kind: "ok", analysis: toListItem(persisted) };
}
