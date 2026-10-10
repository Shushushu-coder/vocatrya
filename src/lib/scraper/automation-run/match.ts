import { createHash } from "crypto";
import { generateText } from "ai";
import {
  getModel,
  parseJobMatch,
  AUTOMATION_JOB_MATCH_SYSTEM_PROMPT,
  buildAutomationJobMatchPrompt,
  removeHtmlTags,
} from "@/lib/ai";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  executeAIConnectionText,
  type ExecuteAIConnectionTextDeps,
} from "@/lib/ai/execution";
import { APP_CONSTANTS } from "@/lib/constants";
import type { JobBoard } from "@/models/automation.model";
import type { AiSettings } from "@/models/userSettings.model";
import {
  genAiRequestAttrs,
  genAiResponseAttrs,
  inputSizeAttrs,
  log,
  SURFACES,
  withSpan,
} from "@/lib/telemetry";
import type { JobDetails } from "../types";
import type { ResumeWithSections } from "./types";
import { getDefaultModelForProvider } from "./aiSettings";
import type { AutomationMatchRuntimePlan } from "./matchRuntime";
import { convertResumeForMatch } from "./resumeText";

/**
 * Invocation-ledger codes scoped to a single job's operation identity —
 * a replayed/in-flight/unknown receipt means THIS job already ran (or is
 * running), not that the run's AI is broken. Systemic codes (assignment,
 * auth, quota, binding) still halt the run; per-job ones are logged and
 * the job is saved unanalyzed while siblings proceed.
 */
export const PER_JOB_MATCH_ERROR_CODES = new Set([
  "INVOCATION_REPLAYED",
  "INVOCATION_IN_PROGRESS",
  "INVOCATION_STATUS_UNKNOWN",
]);

export interface MatchResult {
  success: boolean;
  score: number;
  data?: object;
  error?: string;
  // Stable business-layer code when the AI step failed for a configuration
  // or runtime reason (assignment broken, connection not connected, runtime
  // unavailable, …). Systemic unless listed in PER_JOB_MATCH_ERROR_CODES.
  code?: string;
  // Effective provider/model that produced the analysis — provenance for
  // the persisted match record alongside the run's resolved lock fields.
  provider?: string;
  model?: string;
}

export async function matchJobToResume(
  job: JobDetails,
  resume: ResumeWithSections,
  sourceBoard: JobBoard,
  aiSettings: AiSettings,
  userId: string,
  signal?: AbortSignal,
  matchPlan: AutomationMatchRuntimePlan = { kind: "legacy" },
  // The run id scopes the per-job Managed operation identity — each job's
  // analysis is a distinct durable operation under the run's binding.
  runId?: string,
  /** Injected for tests; production uses the default clients. */
  deps?: ExecuteAIConnectionTextDeps,
): Promise<MatchResult> {
  // A run whose MATCH_ANALYSIS assignment resolved to an unusable
  // connection fails its AI step explicitly — no GLOBAL_DEFAULT fallback,
  // no legacy API-key fallback.
  if (matchPlan.kind === "invalid") {
    return {
      success: false,
      score: 0,
      error: matchPlan.code,
      code: matchPlan.code,
    };
  }
  // A preview plan is non-executable — it carries no Hosted binding, so
  // running it would lazily bind under the wrong resource identity.
  if (matchPlan.kind === "managed-preview") {
    return {
      success: false,
      score: 0,
      error: "MANAGED_BINDING_UNAVAILABLE",
      code: "MANAGED_BINDING_UNAVAILABLE",
    };
  }
  try {
    const resumeText = await convertResumeForMatch(resume);
    const jobText = `
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.salary ? `Salary: ${job.salary}` : ""}

Description:
${removeHtmlTags(job.description)}
`.trim();

    const promptText = buildAutomationJobMatchPrompt(resumeText, jobText);

    let text: string;
    let effectiveProvider: string;
    let effectiveModel: string;

    if (matchPlan.kind === "account" || matchPlan.kind === "managed") {
      // Locked resolved configuration — the run's connectionId + model.
      // The account runtime executes TEXT_ONLY; system prompt and business
      // prompt travel as one plain-text prompt payload. A managed plan
      // replays the run's persisted binding provenance and carries a
      // stable per-job operation identity.
      const managed = matchPlan.kind === "managed";
      const jobKey = createHash("sha256")
        .update(job.url || `${job.title}@${job.company}`)
        .digest("hex")
        .slice(0, 20);
      effectiveProvider = managed ? "VOCATRYA_MANAGED" : matchPlan.provider;
      effectiveModel = matchPlan.model;
      const executed = await withSpan(
        "scraper.match",
        {
          ...genAiRequestAttrs({
            provider: managed ? "MANAGED_GATEWAY" : matchPlan.backendKind,
            model: matchPlan.model,
            surface: SURFACES.AUTOMATION_MATCH,
            system: AUTOMATION_JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
          }),
          ...inputSizeAttrs({
            resumeChars: resumeText.length,
            jobChars: jobText.length,
          }),
          "jobsync.job_board": sourceBoard,
          "jobsync.user_id": userId,
          "jobsync.connection_id": matchPlan.connectionId,
        },
        async (span) => {
          const exec = await executeAIConnectionText({
            userId,
            connectionId: matchPlan.connectionId,
            model: matchPlan.model,
            prompt: `${AUTOMATION_JOB_MATCH_SYSTEM_PROMPT}\n\n${promptText}`,
            signal,
            ...(managed
              ? {
                  operationId: `automation-match:${runId ?? matchPlan.resourceKey}:${jobKey}`,
                  managedAiProvenance: matchPlan.provenance,
                  managedResource: {
                    business: "MATCH_ANALYSIS",
                    resourceKey: matchPlan.resourceKey,
                  },
                }
              : {}),
          }, deps);
          span.setAttrs(
            genAiResponseAttrs({
              finishReason: "stop",
              text: exec.text,
            }),
          );
          return exec;
        },
      );
      text = executed.text;
    } else {
      const provider = aiSettings.provider;
      const modelName = aiSettings.model || getDefaultModelForProvider(provider);
      effectiveProvider = provider;
      effectiveModel = modelName;
      const model = await getModel(provider, modelName, userId);

      const result = await withSpan(
        "scraper.match",
        {
          ...genAiRequestAttrs({
            provider,
            model: modelName,
            temperature: 0.3,
            numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
            surface: SURFACES.AUTOMATION_MATCH,
            system: AUTOMATION_JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
          }),
          ...inputSizeAttrs({
            resumeChars: resumeText.length,
            jobChars: jobText.length,
          }),
          "jobsync.job_board": sourceBoard,
          "jobsync.user_id": userId,
        },
        async (span) => {
          const generated = await generateText({
            model,
            system: AUTOMATION_JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
            temperature: 0.3,
            abortSignal: signal,
          });
          span.setAttrs(
            genAiResponseAttrs({
              usage: generated.totalUsage,
              finishReason: generated.finishReason,
              text: generated.text,
            }),
          );
          return generated;
        },
      );
      text = result.text;
    }

    const { scores, body } = parseJobMatch(text);
    if (!scores) {
      return { success: false, score: 0, error: "No match data returned" };
    }

    return {
      success: true,
      score: scores.matchScore,
      provider: effectiveProvider,
      model: effectiveModel,
      data: {
        matchScore: scores.matchScore,
        recommendation: scores.recommendation,
        body,
      },
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { success: false, score: 0, error: "aborted" };
    }

    const message =
      error instanceof Error ? error.message : "AI matching failed";
    log.error("[Automation] AI matching error", { error: message });

    // Business-layer failures carry stable codes — systemic for the run.
    if (error instanceof AIBusinessError) {
      return { success: false, score: 0, error: error.code, code: error.code };
    }

    if (
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("Failed to fetch") ||
      message.includes("ENOTFOUND")
    ) {
      return { success: false, score: 0, error: "ai_unavailable" };
    }

    return { success: false, score: 0, error: message };
  }
}
