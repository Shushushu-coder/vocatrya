import "server-only";

import type { HarnessTask, PrismaClient } from "@prisma/client";
import { AIBusinessError } from "@/lib/ai/connections";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import {
  AI_EXECUTION_DEFAULT_TIMEOUT_MS,
  executeAIConnectionText,
  type ExecuteAIConnectionTextDeps,
} from "@/lib/ai/execution";
import {
  findUnsupportedSchemaKeys,
  runStructuredValidation,
  type StructuredOutputSchema,
  type StructuredOutputStrategy,
} from "@/lib/ai/structured-output";
import { CareerRuntimeError } from "@/lib/career/errors";
import { canonicalize, hashCanonical, sha256Utf8 } from "@/lib/career/hash";
import {
  MATCH_ANALYSIS_TYPE,
  MATCH_STALE_REASON,
  RESUME_VERSION_STATUS,
} from "@/lib/career/identities";
import {
  buildResumeVersionMaterial,
  ensureRawTextParse,
  jobDescriptionText,
} from "@/lib/career/fastScreening";
import { loadJobPreferenceContext } from "@/lib/career/jobPreferenceContext.server";
import { FAST_SCREENING_ERROR_CODES } from "@/lib/career/fastScreeningContract";
import { MatchAnalysisService } from "@/lib/career/matchAnalysisService";
import { log } from "@/lib/telemetry";
import {
  appendTaskEvent,
  failClaimedTask,
  finalizeCancelledTask,
  guardedTaskUpdate,
  writeStepCheckpoint,
  type HarnessClaim,
} from "./taskService";
import {
  DEEP_MATCH_TASK_INPUT_VERSION,
  DEEP_MATCH_TASK_PINNED_VERSION,
  HARNESS_TASK_EVENT,
  HARNESS_TASK_STATUS,
  HARNESS_TASK_STEP,
  HarnessOwnershipLost,
} from "./types";

/**
 * The DEEP_MATCH consumer: executes a claimed HarnessTask through
 * PIN_INPUTS → RUN_ANALYSIS → COMMIT_RESULT. Every durable transition is
 * guarded by the claim epoch; the settled artifact (MatchAnalysis +
 * DeepMatchDetail + task completion + success event) commits in one
 * transaction so a late runner can never produce a second bound result.
 *
 * The model call runs under the resolution pinned at PIN_INPUTS — a
 * recovered epoch never silently re-resolves the user's latest
 * assignment, and the material text the model sees is exactly what the
 * first attempt assembled.
 */

const DEEP_MATCH_SCHEMA_NAME = "vocatrya_deep_match_v1";
// v2 adds the pinned dual-track preference context (M2.2). Checkpoints
// written before it carry no preference fields and still parse — they
// replay the v1 prompt shape exactly.
const DEEP_MATCH_PROMPT_VERSION = "deep-match-v2";
const MANAGED_BUSINESS = "MATCH_ANALYSIS";

const SUBMITTABLE_VERSION_STATUSES: readonly string[] = [
  RESUME_VERSION_STATUS.DRAFT,
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
];

const DEEP_MATCH_RESULT_SCHEMA: StructuredOutputSchema = {
  type: "object",
  // Same strict-schema rule as FAST_SCREENING: every property stays
  // required and expresses "absent" as null.
  required: [
    "overallSummary",
    "overallScore",
    "hardRequirements",
    "responsibilityAlignment",
    "experienceRelevance",
    "skillCoverage",
    "educationExperienceFit",
    "strengths",
    "gaps",
    "resumeOptimizationOpportunities",
    "nonFixableGaps",
  ],
  additionalProperties: false,
  properties: {
    overallSummary: { type: "string" },
    overallScore: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    hardRequirements: { type: ["string", "null"] },
    responsibilityAlignment: { type: ["string", "null"] },
    experienceRelevance: { type: ["string", "null"] },
    skillCoverage: { type: ["string", "null"] },
    educationExperienceFit: { type: ["string", "null"] },
    strengths: { type: ["string", "null"] },
    gaps: { type: ["string", "null"] },
    resumeOptimizationOpportunities: { type: ["string", "null"] },
    nonFixableGaps: { type: ["string", "null"] },
  },
};

const DEEP_MATCH_SYSTEM_PROMPT = `You are an expert recruiter performing a deep match analysis of a candidate against a job description. You receive the job description, the candidate's resume version text, and the candidate's job-search preferences when provided.

## RULES
- Judge only what the job description explicitly requires; credit transferable evidence from different technologies or industries.
- Never inflate: be honest about gaps and about what the resume cannot fix.
- Job-search preferences (when provided): the structured fields are authoritative business records; notes labeled 对话沉淀偏好 are advisory supplements and never override them.
- overallSummary: 3-6 sentences covering the decisive fit factors.
- overallScore: integer 0-100, or null when the material is too thin to score honestly.
- hardRequirements: coverage of mandatory requirements, or null when none are stated.
- responsibilityAlignment: how well the candidate's experience matches the role's responsibilities.
- experienceRelevance: relevance of past roles/projects to this job.
- skillCoverage: required skills covered and missing.
- educationExperienceFit: education/experience-level fit, or null when irrelevant.
- strengths: the candidate's strongest evidence for this job.
- gaps: the decisive gaps for this job.
- resumeOptimizationOpportunities: concrete resume changes that would improve the match for THIS job, or null when none.
- nonFixableGaps: gaps a resume edit cannot fix (location, years, degree), or null when none.`;

function buildDeepMatchPrompt(input: {
  jobText: string;
  resumeText: string;
  preferenceText?: string | null;
}): string {
  const base = `Deep-match this candidate's resume version against the job description.

JOB DESCRIPTION:
${input.jobText}

CANDIDATE RESUME:
${input.resumeText}`;
  const preference = input.preferenceText?.trim();
  return preference
    ? `${base}\n\nCANDIDATE JOB-SEARCH PREFERENCES:\n${preference}`
    : base;
}

// ---------------------------------------------------------------------------
// Pinned payloads
// ---------------------------------------------------------------------------

type TaskInput = {
  jobOpportunityId: string;
  jobDescriptionVersionId: string;
  resumeVariantVersionId: string;
};

type PinnedExecution = {
  v: string;
  inputs: TaskInput & {
    jobDescriptionParseId: string;
    parseInputHash: string;
    jdContentHash: string;
    jdVersionNumber: number;
    resumeVariantId: string;
    resumeVariantName: string;
    resumeVersionNumber: number;
  };
  material: {
    jdText: string;
    resumeText: string;
    resumeTextHash: string;
    /**
     * M2.2: the dual-track preference context pinned with the material —
     * the authoritative business snapshot plus the labeled 对话沉淀偏好
     * notes. Absent on checkpoints written before preference pinning
     * existed; recovery replays exactly what the task saw.
     */
    preferenceText?: string | null;
    preferenceSnapshot?: Record<string, unknown>;
  };
  resolution: {
    connectionId: string;
    model: string;
    provider: string;
    backendKind: string;
    source: string;
  };
  promptVersion: string;
  schemaName: string;
  promptHash: string;
  analysis?: {
    payload: Record<string, unknown>;
    provider: string;
    model: string;
    resolvedConnectionId: string;
    managedAiProvenance: string | null;
    attemptCount: number;
    retried: boolean;
  };
};

class TaskFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "TaskFailure";
  }
}

function failTask(code: string, message: string, detail?: string): never {
  throw new TaskFailure(code, message, detail);
}

function parseTaskInput(task: HarnessTask): TaskInput {
  let raw: { v?: unknown; jobOpportunityId?: unknown; jobDescriptionVersionId?: unknown; resumeVariantVersionId?: unknown };
  try {
    raw = JSON.parse(task.inputJson) as typeof raw;
  } catch {
    return failTask(
      "TASK_INPUT_VERSION_UNSUPPORTED",
      "Stored task input is unreadable",
    );
  }
  if (
    raw.v !== DEEP_MATCH_TASK_INPUT_VERSION ||
    typeof raw.jobOpportunityId !== "string" ||
    typeof raw.jobDescriptionVersionId !== "string" ||
    typeof raw.resumeVariantVersionId !== "string"
  ) {
    return failTask(
      "TASK_INPUT_VERSION_UNSUPPORTED",
      `Unsupported task input version ${String(raw.v)}`,
    );
  }
  return {
    jobOpportunityId: raw.jobOpportunityId,
    jobDescriptionVersionId: raw.jobDescriptionVersionId,
    resumeVariantVersionId: raw.resumeVariantVersionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Load the versioned step checkpoint — completely or not at all. A
 * checkpoint carries the pinned material text the model saw, the AI
 * resolution and the step artifact; trusting a partially-shaped payload
 * would let a corrupted row silently analyze the wrong input. Structural
 * damage, a tampered material hash or a step/analysis mismatch all fail
 * deterministically as DEEP_MATCH_STATE_CONFLICT; an unreadable or
 * unsupported envelope fails as TASK_INPUT_VERSION_UNSUPPORTED.
 */
function parsePinned(
  pinnedJson: string,
  currentStep: string | null,
): PinnedExecution {
  let raw: unknown;
  try {
    raw = JSON.parse(pinnedJson);
  } catch {
    return failTask(
      "TASK_INPUT_VERSION_UNSUPPORTED",
      "Stored task checkpoint is unreadable",
    );
  }
  const corrupt = (): never =>
    failTask(
      "DEEP_MATCH_STATE_CONFLICT",
      "Stored task checkpoint is malformed or inconsistent",
    );
  if (!isRecord(raw) || raw.v !== DEEP_MATCH_TASK_PINNED_VERSION) {
    return failTask(
      "TASK_INPUT_VERSION_UNSUPPORTED",
      `Unsupported checkpoint version ${isRecord(raw) ? String(raw.v) : "none"}`,
    );
  }

  const { inputs, material, resolution, analysis } = raw as Record<
    string,
    unknown
  >;
  if (!isRecord(inputs) || !isRecord(material) || !isRecord(resolution)) {
    return corrupt();
  }
  const inputsOk =
    isText(inputs.jobOpportunityId) &&
    isText(inputs.jobDescriptionVersionId) &&
    isText(inputs.resumeVariantVersionId) &&
    isText(inputs.jobDescriptionParseId) &&
    isText(inputs.parseInputHash) &&
    isText(inputs.jdContentHash) &&
    typeof inputs.jdVersionNumber === "number" &&
    isText(inputs.resumeVariantId) &&
    isText(inputs.resumeVariantName) &&
    typeof inputs.resumeVersionNumber === "number";
  const materialOk =
    isText(material.jdText) &&
    isText(material.resumeText) &&
    isText(material.resumeTextHash) &&
    material.resumeTextHash === sha256Utf8(material.resumeText as string) &&
    (material.preferenceText === undefined ||
      material.preferenceText === null ||
      isText(material.preferenceText)) &&
    (material.preferenceSnapshot === undefined ||
      isRecord(material.preferenceSnapshot));
  const resolutionOk =
    isText(resolution.connectionId) &&
    isText(resolution.model) &&
    isText(resolution.provider) &&
    isText(resolution.backendKind) &&
    isText(resolution.source);
  const envelopeOk =
    isText(raw.promptVersion) &&
    isText(raw.schemaName) &&
    isText(raw.promptHash);
  if (!inputsOk || !materialOk || !resolutionOk || !envelopeOk) {
    return corrupt();
  }

  let parsedAnalysis: PinnedExecution["analysis"];
  if (analysis !== undefined) {
    const payload = isRecord(analysis) ? analysis.payload : undefined;
    const payloadOk =
      isRecord(payload) &&
      isText(payload.overallSummary) &&
      (payload.overallScore === null ||
        (typeof payload.overallScore === "number" &&
          Number.isInteger(payload.overallScore))) &&
      isTextOrNull(payload.hardRequirements) &&
      isTextOrNull(payload.responsibilityAlignment) &&
      isTextOrNull(payload.experienceRelevance) &&
      isTextOrNull(payload.skillCoverage) &&
      isTextOrNull(payload.educationExperienceFit) &&
      isTextOrNull(payload.strengths) &&
      isTextOrNull(payload.gaps) &&
      isTextOrNull(payload.resumeOptimizationOpportunities) &&
      isTextOrNull(payload.nonFixableGaps);
    if (
      !isRecord(analysis) ||
      !payloadOk ||
      !isText(analysis.provider) ||
      !isText(analysis.model) ||
      !isText(analysis.resolvedConnectionId) ||
      !isTextOrNull(analysis.managedAiProvenance) ||
      typeof analysis.attemptCount !== "number" ||
      typeof analysis.retried !== "boolean"
    ) {
      return corrupt();
    }
    parsedAnalysis = analysis as PinnedExecution["analysis"];
  }

  // Step consistency: the analysis artifact may only exist once the row
  // reached COMMIT_RESULT — earlier steps must not carry it, later steps
  // must not miss it, and a checkpoint at any other step is damage.
  if (currentStep === HARNESS_TASK_STEP.COMMIT_RESULT) {
    if (!parsedAnalysis) return corrupt();
  } else if (currentStep === HARNESS_TASK_STEP.RUN_ANALYSIS) {
    if (parsedAnalysis) return corrupt();
  } else {
    return corrupt();
  }

  return { ...(raw as Omit<PinnedExecution, "analysis">), analysis: parsedAnalysis };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepStarted(
  db: PrismaClient,
  claim: HarnessClaim,
  step: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await appendTaskEvent(tx, {
      taskId: claim.taskId,
      epoch: claim.epoch,
      type: HARNESS_TASK_EVENT.STEP_STARTED,
      payload: { step },
    });
    // Cheap ownership probe inside the same tx — the event never lands
    // for a superseded epoch.
    await guardedTaskUpdate(tx, claim, { lastHeartbeatAt: new Date() });
  });
}

/**
 * PIN_INPUTS: re-verify the pinned business objects still exist and stay
 * usable, run the deterministic JD parse, resolve the AI assignment ONCE,
 * and persist everything later steps need — connection/model identity and
 * the exact material text — as an epoch-guarded checkpoint.
 */
async function runPinInputs(
  db: PrismaClient,
  claim: HarnessClaim,
  task: HarnessTask,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await stepStarted(db, claim, HARNESS_TASK_STEP.PIN_INPUTS);
  const input = parseTaskInput(task);

  const [opportunity, jdVersion, resumeVersion] = await Promise.all([
    db.jobOpportunity.findFirst({
      where: { id: input.jobOpportunityId, userId: task.userId },
      select: { id: true, archivedAt: true },
    }),
    db.jobDescriptionVersion.findFirst({
      where: {
        id: input.jobDescriptionVersionId,
        jobOpportunityId: input.jobOpportunityId,
      },
      select: {
        id: true,
        versionNumber: true,
        rawContent: true,
        rawContentFormat: true,
        contentHash: true,
      },
    }),
    db.resumeVariantVersion.findFirst({
      where: {
        id: input.resumeVariantVersionId,
        resumeVariant: { userId: task.userId },
      },
      select: {
        id: true,
        status: true,
        versionNumber: true,
        resumeVariant: { select: { id: true, name: true } },
      },
    }),
  ]);

  if (!opportunity) {
    return failTask("OPPORTUNITY_NOT_FOUND", "Opportunity not found");
  }
  if (opportunity.archivedAt !== null) {
    return failTask(
      "OPPORTUNITY_ARCHIVED",
      "This job was archived while the analysis waited.",
    );
  }
  if (!jdVersion) {
    return failTask(
      "DEEP_JD_VERSION_MISSING",
      "The job description version pinned by this analysis is gone.",
    );
  }
  if (!resumeVersion) {
    return failTask(
      "DEEP_RESUME_VERSION_MISSING",
      "The resume version pinned by this analysis is gone.",
    );
  }
  if (!SUBMITTABLE_VERSION_STATUSES.includes(resumeVersion.status)) {
    return failTask(
      "RESUME_VERSION_NOT_SUBMITTABLE",
      "The pinned resume version is no longer submittable.",
    );
  }

  const jdText = jobDescriptionText(jdVersion);
  if (jdText === "") {
    return failTask(
      FAST_SCREENING_ERROR_CODES.JD_MISSING,
      "The pinned job description has no text to analyze.",
    );
  }
  const material = await buildResumeVersionMaterial(
    db,
    task.userId,
    resumeVersion.id,
    env,
  );
  if (material.text.trim() === "") {
    return failTask(
      FAST_SCREENING_ERROR_CODES.INSUFFICIENT_MATERIAL,
      "The pinned resume version has no usable content.",
    );
  }

  const parse = await ensureRawTextParse(db, jdVersion, jdText);
  const resolution = await resolveBusinessAIConfig(
    { userId: task.userId, purpose: "MATCH_ANALYSIS" },
    db,
  );
  if (resolution.status === "NOT_CONFIGURED") {
    return failTask(
      FAST_SCREENING_ERROR_CODES.NOT_CONFIGURED,
      "No AI assignment is configured for match analysis.",
    );
  }
  if (resolution.status === "INVALID_ASSIGNMENT") {
    return failTask(
      resolution.code,
      "The configured match assignment is unusable.",
    );
  }
  if (resolution.status !== "RESOLVED") {
    return failTask(
      "NOT_CONFIGURED",
      "No usable AI assignment resolves for match analysis.",
    );
  }

  // M2.2: pin the dual-track preference context with the material so the
  // prompt, the checkpoint and any recovery replay see exactly the same
  // business fields + 对话沉淀偏好 notes — memory never re-resolves later.
  const preference = await loadJobPreferenceContext(db, task.userId, env);
  const prompt = buildDeepMatchPrompt({
    jobText: jdText,
    resumeText: material.text,
    preferenceText: preference.text,
  });
  const pinned: PinnedExecution = {
    v: DEEP_MATCH_TASK_PINNED_VERSION,
    inputs: {
      ...input,
      jobDescriptionParseId: parse.id,
      parseInputHash: parse.inputHash,
      jdContentHash: jdVersion.contentHash,
      jdVersionNumber: jdVersion.versionNumber,
      resumeVariantId: resumeVersion.resumeVariant.id,
      resumeVariantName: resumeVersion.resumeVariant.name,
      resumeVersionNumber: resumeVersion.versionNumber,
    },
    material: {
      jdText,
      resumeText: material.text,
      resumeTextHash: sha256Utf8(material.text),
      preferenceText: preference.text,
      preferenceSnapshot: preference.snapshot,
    },
    resolution: {
      connectionId: resolution.connectionId,
      model: resolution.model,
      provider: resolution.provider,
      backendKind: resolution.backendKind,
      source: resolution.source,
    },
    promptVersion: DEEP_MATCH_PROMPT_VERSION,
    schemaName: DEEP_MATCH_SCHEMA_NAME,
    promptHash: sha256Utf8(prompt),
  };

  await writeStepCheckpoint(db, claim, {
    step: HARNESS_TASK_STEP.RUN_ANALYSIS,
    pinnedJson: JSON.stringify(pinned),
    payload: {
      jobDescriptionParseId: parse.id,
      connectionId: resolution.connectionId,
      provider: resolution.provider,
      model: resolution.model,
      jdContentHash: jdVersion.contentHash,
      resumeTextHash: pinned.material.resumeTextHash,
      promptVersion: DEEP_MATCH_PROMPT_VERSION,
      schemaName: DEEP_MATCH_SCHEMA_NAME,
    },
  });
}

/**
 * RUN_ANALYSIS: the one billable step. The structured call runs against
 * the PINNED connection/model under the task-attempt operation identity —
 * a crash-recovered epoch replays the managed invocation, a user retry
 * mints a new one. The validated payload is checkpointed before COMMIT so
 * a crash between model success and persistence never bills twice.
 */
async function runAnalysis(
  db: PrismaClient,
  claim: HarnessClaim,
  task: HarnessTask,
  pinned: PinnedExecution,
  deps: ExecuteAIConnectionTextDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  await stepStarted(db, claim, HARNESS_TASK_STEP.RUN_ANALYSIS);

  if (findUnsupportedSchemaKeys(DEEP_MATCH_RESULT_SCHEMA).length > 0) {
    return failTask(
      "STRUCTURED_OUTPUT_UNSUPPORTED",
      "The deep match schema is outside the supported subset.",
    );
  }

  const operationId = `deep-match-task:${task.id}:attempt:${task.attemptCount}`;
  // The prompt is rebuilt from the PINNED material — the preference text
  // included is whatever was pinned at PIN_INPUTS, never re-resolved.
  const prompt = buildDeepMatchPrompt({
    jobText: pinned.material.jdText,
    resumeText: pinned.material.resumeText,
    preferenceText: pinned.material.preferenceText ?? null,
  });
  let managedAiProvenance: string | null = null;

  const result = await runStructuredValidation({
    prompt,
    schema: DEEP_MATCH_RESULT_SCHEMA,
    schemaName: DEEP_MATCH_SCHEMA_NAME,
    signal,
    execute: async ({ prompt: attemptPrompt, signal: attemptSignal, attempt }) => {
      const callStarted = Date.now();
      await appendBestEffortEvent(db, {
        taskId: claim.taskId,
        epoch: claim.epoch,
        type: HARNESS_TASK_EVENT.MODEL_CALL_STARTED,
        payload: {
          step: HARNESS_TASK_STEP.RUN_ANALYSIS,
          operationId,
          attemptIndex: attempt,
          connectionId: pinned.resolution.connectionId,
          model: pinned.resolution.model,
        },
      });
      try {
        const outcome = await executeAIConnectionText(
          {
            userId: task.userId,
            connectionId: pinned.resolution.connectionId,
            model: pinned.resolution.model,
            prompt: attemptPrompt,
            structuredOutput: {
              schema: DEEP_MATCH_RESULT_SCHEMA as Record<string, unknown>,
              schemaName: DEEP_MATCH_SCHEMA_NAME,
            },
            timeoutMs: AI_EXECUTION_DEFAULT_TIMEOUT_MS,
            signal: attemptSignal,
            operationId,
            attemptIndex: attempt,
            managedResource: {
              business: MANAGED_BUSINESS,
              resourceKey: operationId,
            },
          },
          deps,
        );
        managedAiProvenance = outcome.managedAiProvenance
          ? JSON.stringify(outcome.managedAiProvenance)
          : null;
        await appendBestEffortEvent(db, {
          taskId: claim.taskId,
          epoch: claim.epoch,
          type: HARNESS_TASK_EVENT.MODEL_CALL_FINISHED,
          payload: {
            step: HARNESS_TASK_STEP.RUN_ANALYSIS,
            operationId,
            attemptIndex: attempt,
            outcome: "EXECUTED",
            durationMs: outcome.durationMs ?? Date.now() - callStarted,
            stopReason: outcome.stopReason ?? null,
          },
        });
        return {
          ok: true,
          text: outcome.text,
          structuredStrategy:
            (outcome.structuredStrategy as
              | StructuredOutputStrategy
              | null
              | undefined) ?? null,
          stopReason: outcome.stopReason ?? null,
          durationMs: outcome.durationMs,
        };
      } catch (error) {
        const code =
          error instanceof AIBusinessError ? error.code : "AI_EXECUTION_FAILED";
        await appendBestEffortEvent(db, {
          taskId: claim.taskId,
          epoch: claim.epoch,
          type: HARNESS_TASK_EVENT.MODEL_CALL_FINISHED,
          payload: {
            step: HARNESS_TASK_STEP.RUN_ANALYSIS,
            operationId,
            attemptIndex: attempt,
            outcome: code,
            durationMs: Date.now() - callStarted,
          },
        });
        return { ok: false, code };
      }
    },
  });

  if (result.status !== "VALID" && result.status !== "VALID_AFTER_RETRY") {
    const last = result.attempts[result.attempts.length - 1];
    const code =
      (result.status === "EXECUTION_FAILED" && last?.code) ||
      result.status ||
      "AI_EXECUTION_FAILED";
    return failTask(code, "The model call did not produce a usable result.", result.issueSummary ?? undefined);
  }

  const value = (result.value ?? {}) as Record<string, unknown>;
  const textOrNull = (field: unknown): string | null =>
    typeof field === "string" && field.trim() !== "" ? field : null;
  const scoreOrNull = (field: unknown): number | null =>
    typeof field === "number" && Number.isInteger(field) ? field : null;

  pinned.analysis = {
    payload: {
      overallSummary:
        typeof value.overallSummary === "string" ? value.overallSummary : "",
      overallScore: scoreOrNull(value.overallScore),
      hardRequirements: textOrNull(value.hardRequirements),
      responsibilityAlignment: textOrNull(value.responsibilityAlignment),
      experienceRelevance: textOrNull(value.experienceRelevance),
      skillCoverage: textOrNull(value.skillCoverage),
      educationExperienceFit: textOrNull(value.educationExperienceFit),
      strengths: textOrNull(value.strengths),
      gaps: textOrNull(value.gaps),
      resumeOptimizationOpportunities: textOrNull(
        value.resumeOptimizationOpportunities,
      ),
      nonFixableGaps: textOrNull(value.nonFixableGaps),
    },
    provider: pinned.resolution.provider,
    model: pinned.resolution.model,
    resolvedConnectionId: pinned.resolution.connectionId,
    managedAiProvenance,
    attemptCount: result.attempts.length,
    retried: result.retried,
  };
  if (pinned.analysis.payload.overallSummary === "") {
    return failTask(
      "STRUCTURED_OUTPUT_SCHEMA_FAILED",
      "The model returned an empty summary.",
    );
  }

  await writeStepCheckpoint(db, claim, {
    step: HARNESS_TASK_STEP.COMMIT_RESULT,
    pinnedJson: JSON.stringify(pinned),
    payload: {
      operationId,
      attemptCount: result.attempts.length,
      retried: result.retried,
    },
  });
}

/**
 * COMMIT_RESULT: the analysis row, its detail, the task's SUCCEEDED state,
 * the unique result binding and the success event — one transaction. The
 * task-side guard refuses the commit when this epoch lost ownership or a
 * cancel landed, rolling the analysis row back with it.
 */
async function runCommit(
  db: PrismaClient,
  claim: HarnessClaim,
  task: HarnessTask,
  pinned: PinnedExecution,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  await stepStarted(db, claim, HARNESS_TASK_STEP.COMMIT_RESULT);
  const analysis = pinned.analysis;
  if (!analysis) {
    return failTask(
      "DEEP_MATCH_STATE_CONFLICT",
      "The analysis checkpoint is missing its payload.",
    );
  }
  const match = new MatchAnalysisService(db, task.userId, env);
  const payload = analysis.payload as {
    overallSummary: string;
    overallScore: number | null;
    hardRequirements: string | null;
    responsibilityAlignment: string | null;
    experienceRelevance: string | null;
    skillCoverage: string | null;
    educationExperienceFit: string | null;
    strengths: string | null;
    gaps: string | null;
    resumeOptimizationOpportunities: string | null;
    nonFixableGaps: string | null;
  };
  const completedAt = new Date();
  const persisted = await match.createDeepMatch({
    jobOpportunityId: pinned.inputs.jobOpportunityId,
    jobDescriptionParseId: pinned.inputs.jobDescriptionParseId,
    resumeVariantVersionId: pinned.inputs.resumeVariantVersionId,
    payload,
    provider: analysis.provider,
    model: analysis.model,
    promptVersion: pinned.promptVersion,
    resolvedConnectionId: analysis.resolvedConnectionId,
    managedAiProvenance: analysis.managedAiProvenance,
    onCommitted: async (tx, analysisId) => {
      await appendTaskEvent(tx, {
        taskId: claim.taskId,
        epoch: claim.epoch,
        type: HARNESS_TASK_EVENT.TASK_SUCCEEDED,
        payload: { matchAnalysisId: analysisId },
      });
      const linked = await tx.harnessTask.updateMany({
        where: {
          id: claim.taskId,
          claimEpoch: claim.epoch,
          leaseOwner: claim.owner,
          status: HARNESS_TASK_STATUS.RUNNING,
          leaseUntil: { gt: completedAt },
        },
        data: {
          status: HARNESS_TASK_STATUS.SUCCEEDED,
          resultAnalysisId: analysisId,
          currentStep: null,
          leaseUntil: null,
          completedAt,
        },
      });
      if (linked.count !== 1) {
        throw new HarnessOwnershipLost();
      }
    },
  });
  return persisted.id;
}

/**
 * Lenient preference-snapshot extraction from a bound task checkpoint.
 * Anything unreadable or absent reads as the empty snapshot — it only feeds
 * the staleness diff, never the analysis itself.
 */
function preferenceSnapshotOfPinned(
  pinnedJson: string | null | undefined,
): Record<string, unknown> {
  if (!pinnedJson) return {};
  try {
    const parsed = JSON.parse(pinnedJson) as {
      material?: { preferenceSnapshot?: unknown };
    } | null;
    const snapshot = parsed?.material?.preferenceSnapshot;
    return isRecord(snapshot) ? snapshot : {};
  } catch {
    return {};
  }
}

/**
 * Marks other non-stale DEEP_MATCH analyses of this job stale when the
 * pinned inputs they ran against no longer match — same contract as the
 * fast-screening supersede sweep, best-effort after the commit. The
 * just-committed result is checked too: when the job's current JD moved
 * on while this task ran, the new row persists but is marked stale
 * rather than posing as the current result.
 */
async function markSupersededDeepMatchStale(
  db: PrismaClient,
  userId: string,
  pinned: PinnedExecution,
  freshAnalysisId: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const match = new MatchAnalysisService(db, userId, env);
  const analyses = await match.listAnalysesForOpportunity(
    pinned.inputs.jobOpportunityId,
    { analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH },
  );
  for (const analysis of analyses) {
    if (analysis.id === freshAnalysisId || analysis.isStale) continue;
    const reasonCodes: string[] = [];
    if (
      analysis.resumeVariantVersionId !== pinned.inputs.resumeVariantVersionId
    ) {
      reasonCodes.push(MATCH_STALE_REASON.RESUME_VERSION_CHANGED);
    }
    const parse = await db.jobDescriptionParse.findUnique({
      where: { id: analysis.jobDescriptionParseId },
      select: {
        jobDescriptionVersion: { select: { contentHash: true } },
      },
    });
    if (
      parse &&
      parse.jobDescriptionVersion.contentHash !== pinned.inputs.jdContentHash
    ) {
      reasonCodes.push(MATCH_STALE_REASON.JD_CHANGED);
    }
    // M2.2: the preference context is a pinned material input — when it
    // changed since this superseded analysis ran, it is PREFERENCE_CHANGED.
    // The bound task's pinnedJson is the only durable copy of what that
    // analysis saw; absent (pre-M2.2 tasks) reads as the empty snapshot.
    const boundTask = await db.harnessTask.findFirst({
      where: { resultAnalysisId: analysis.id },
      select: { pinnedJson: true },
    });
    const previousPreference = preferenceSnapshotOfPinned(
      boundTask?.pinnedJson,
    );
    if (
      canonicalize(previousPreference) !==
      canonicalize(pinned.material.preferenceSnapshot ?? {})
    ) {
      reasonCodes.push(MATCH_STALE_REASON.PREFERENCE_CHANGED);
    }
    if (reasonCodes.length > 0) {
      await match.markStale(analysis.id, reasonCodes);
    }
  }

  const opportunity = await db.jobOpportunity.findFirst({
    where: { id: pinned.inputs.jobOpportunityId, userId },
    select: { currentJdVersion: { select: { contentHash: true } } },
  });
  if (
    !opportunity?.currentJdVersion ||
    opportunity.currentJdVersion.contentHash !== pinned.inputs.jdContentHash
  ) {
    await match.markStale(freshAnalysisId, [MATCH_STALE_REASON.JD_CHANGED]);
  }
}

// ---------------------------------------------------------------------------
// Executor entry
// ---------------------------------------------------------------------------

export type DeepMatchExecutorOptions = {
  deps?: ExecuteAIConnectionTextDeps;
  env?: NodeJS.ProcessEnv;
  /** Abort signal for the in-flight model call (cancel / lease loss). */
  signal?: AbortSignal;
};

/**
 * Execute one claimed DEEP_MATCH task to a terminal state or a
 * survivable checkpoint. Returns normally in every case; the task row is
 * the record of what happened.
 */
export async function executeDeepMatchTask(
  db: PrismaClient,
  claim: HarnessClaim,
  options: DeepMatchExecutorOptions = {},
): Promise<void> {
  const task = await db.harnessTask.findUnique({
    where: { id: claim.taskId },
  });
  if (!task) return;
  if (task.status === HARNESS_TASK_STATUS.CANCELLING) {
    await finalizeCancelledTask(db, {
      taskId: task.id,
      epoch: claim.epoch,
    });
    return;
  }
  if (
    task.status !== HARNESS_TASK_STATUS.RUNNING ||
    task.claimEpoch !== claim.epoch ||
    task.leaseOwner !== claim.owner
  ) {
    return;
  }

  try {
    // A cancel that landed between claim and first step must not pay for
    // a model call — the status flip is checked before each step boundary.
    if (task.currentStep === null && !task.pinnedJson) {
      await runPinInputs(db, claim, task, options.env);
    }
    const live = await reloadForExecution(db, claim);
    if (!live) return;
    const pinned = parsePinned(live.pinnedJson!, live.currentStep);

    if (live.currentStep === HARNESS_TASK_STEP.RUN_ANALYSIS && !pinned.analysis) {
      await runAnalysis(db, claim, live, pinned, options.deps ?? {}, options.signal);
    }
    const beforeCommit = await reloadForExecution(db, claim);
    if (!beforeCommit) return;
    const pinnedForCommit = parsePinned(
      beforeCommit.pinnedJson!,
      beforeCommit.currentStep,
    );
    if (beforeCommit.currentStep === HARNESS_TASK_STEP.COMMIT_RESULT) {
      const analysisId = await runCommit(
        db,
        claim,
        beforeCommit,
        pinnedForCommit,
        options.env,
      );
      await markSupersededDeepMatchStale(
        db,
        beforeCommit.userId,
        pinnedForCommit,
        analysisId,
        options.env,
      );
    }
  } catch (error) {
    if (error instanceof HarnessOwnershipLost) {
      await reconcileOwnershipLoss(db, claim);
      return;
    }
    const code =
      error instanceof TaskFailure
        ? error.code
        : error instanceof CareerRuntimeError
          ? error.code
          : error instanceof AIBusinessError
            ? error.code
            : "DEEP_MATCH_EXECUTION_FAILED";
    const detail =
      error instanceof TaskFailure
        ? (error.detail ?? error.message)
        : error instanceof Error
          ? error.message
          : null;
    const failed = await failClaimedTask(db, claim, {
      code,
      detail: detail?.slice(0, 500) ?? null,
    });
    if (!failed) {
      await reconcileOwnershipLoss(db, claim);
    }
    if (!(error instanceof TaskFailure)) {
      log.error("[harness] deep-match task crashed", {
        taskId: claim.taskId,
        epoch: claim.epoch,
        error: String(error),
      });
    }
  }
}

/**
 * Re-read the task for the next step boundary. Returns null when the
 * execution should stop: the row went CANCELLING (settle it) or
 * ownership moved on (do nothing — the new epoch owns it).
 */
async function reloadForExecution(
  db: PrismaClient,
  claim: HarnessClaim,
): Promise<HarnessTask | null> {
  const row = await db.harnessTask.findUnique({ where: { id: claim.taskId } });
  if (!row) return null;
  if (row.status === HARNESS_TASK_STATUS.CANCELLING) {
    await finalizeCancelledTask(db, { taskId: row.id, epoch: claim.epoch });
    return null;
  }
  if (
    row.status !== HARNESS_TASK_STATUS.RUNNING ||
    row.claimEpoch !== claim.epoch ||
    row.leaseOwner !== claim.owner
  ) {
    return null;
  }
  return row;
}

/**
 * Ownership slipped: a newer epoch or a cancel took over. When the row is
 * CANCELLING with no live holder this epoch still settles it — the user
 * intent survives regardless of who writes the terminal row.
 */
async function reconcileOwnershipLoss(
  db: PrismaClient,
  claim: HarnessClaim,
): Promise<void> {
  try {
    const row = await db.harnessTask.findUnique({ where: { id: claim.taskId } });
    if (!row) return;
    if (row.status === HARNESS_TASK_STATUS.CANCELLING) {
      await finalizeCancelledTask(db, { taskId: row.id, epoch: claim.epoch });
      return;
    }
    const leaseExpired =
      row.leaseUntil !== null && row.leaseUntil.getTime() < Date.now();
    if (
      row.status === HARNESS_TASK_STATUS.RUNNING &&
      (row.claimEpoch !== claim.epoch || leaseExpired)
    ) {
      await db.$transaction(async (tx) => {
        await appendTaskEvent(tx, {
          taskId: row.id,
          epoch: claim.epoch,
          type: HARNESS_TASK_EVENT.LEASE_LOST,
          payload: { observedEpoch: row.claimEpoch, leaseExpired },
        });
      });
    }
  } catch {
    // Reconcile is best-effort — the next claim/sweep converges the row.
  }
}

/** Trace writes that may degrade without killing the step (model-call
 *  timing records). Claim/checkpoint/commit/cancel/terminal events never
 *  use this path — those are transactional. */
async function appendBestEffortEvent(
  db: PrismaClient,
  input: {
    taskId: string;
    epoch: number;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await appendTaskEvent(tx, input);
    });
  } catch {
    // A trace hiccup must not kill an in-flight model step.
  }
}
