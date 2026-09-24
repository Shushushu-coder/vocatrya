import { generateText } from "ai";
import {
  getModel,
  parseJobMatch,
  AUTOMATION_JOB_MATCH_SYSTEM_PROMPT,
  buildAutomationJobMatchPrompt,
  removeHtmlTags,
} from "@/lib/ai";
import { AIBusinessError } from "@/lib/ai/connections";
import { executeAIConnectionText } from "@/lib/ai/execution";
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

export interface MatchResult {
  success: boolean;
  score: number;
  data?: object;
  error?: string;
  // Stable business-layer code when the AI step failed for a configuration
  // or runtime reason (assignment broken, connection not connected, runtime
  // unavailable, …). Systemic: every job in the run would fail identically.
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

    if (matchPlan.kind === "account") {
      // Locked resolved configuration — the run's connectionId + model.
      // The account runtime executes TEXT_ONLY; system prompt and business
      // prompt travel as one plain-text prompt payload.
      effectiveProvider = matchPlan.provider;
      effectiveModel = matchPlan.model;
      const executed = await withSpan(
        "scraper.match",
        {
          ...genAiRequestAttrs({
            provider: matchPlan.backendKind,
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
          });
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
