"use server";

import db from "@/lib/db";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import { requireUser } from "../shared";
import { generateText } from "ai";
import {
  getModel,
  parseJobMatch,
  JOB_MATCH_SYSTEM_PROMPT,
  buildJobMatchPrompt,
  preprocessResume,
  preprocessJob,
} from "@/lib/ai";
import { getResumeById } from "@/actions/profile.actions";
import { getJobDetails } from "@/actions/job.actions";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { AIBusinessError } from "@/lib/ai/connections";
import { defaultUserSettings } from "@/models/userSettings.model";
import { automationLogger } from "@/lib/automation-logger";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  genAiRequestAttrs,
  genAiResponseAttrs,
  inputSizeAttrs,
  SURFACES,
  withSpan,
} from "@/lib/telemetry";
import { formatError } from "./shared";

// Runs an on-demand LLM match for an un-analyzed discovered job using the
// resume tied to its automation and the user's AI settings (no model picker —
// mirrors the automation runner). Upgrades matchData with analyzed: true.
export async function analyzeDiscoveredJob(jobId: string): Promise<{
  success: boolean;
  matchScore?: number;
  message?: string;
}> {
  try {
    const user = await requireUser();
    await assertLegacyCareerWriteAllowed(db);

    const job = await db.job.findFirst({
      where: { id: jobId, userId: user.id, automationId: { not: null } },
      include: { automation: { select: { resumeId: true } } },
    });

    if (!job) {
      return { success: false, message: "Discovered job not found" };
    }

    if (job.automationId && automationLogger.isRunning(job.automationId)) {
      return {
        success: false,
        message:
          "A run is in progress for this automation. Please wait until it completes before analyzing jobs.",
      };
    }

    const resumeId = job.automation?.resumeId;
    if (!resumeId) {
      return { success: false, message: "Automation resume is missing" };
    }

    // The MATCH_ANALYSIS assignment takes precedence over legacy AI
    // settings when configured; an explicitly broken assignment fails
    // instead of falling back to another account or the API-key path.
    const matchResolution = await resolveBusinessAIConfig({
      userId: user.id,
      purpose: "MATCH_ANALYSIS",
    });
    if (matchResolution.status === "INVALID_ASSIGNMENT") {
      return {
        success: false,
        message: `AI assignment is not usable (${matchResolution.code})`,
      };
    }
    const useAccountRuntime = matchResolution.status === "RESOLVED";

    const userSettings = await db.userSettings.findUnique({
      where: { userId: user.id },
    });
    const ai = userSettings
      ? {
          ...defaultUserSettings.ai,
          ...(JSON.parse(userSettings.settings).ai ?? {}),
        }
      : defaultUserSettings.ai;

    const [{ data: resume }, { job: jobDetails }] = await Promise.all([
      getResumeById(resumeId),
      getJobDetails(jobId),
    ]);

    const [resumePre, jobPre] = await Promise.all([
      preprocessResume(resume),
      preprocessJob(jobDetails),
    ]);

    if (!resumePre.success || !jobPre.success) {
      return { success: false, message: "Failed to prepare match inputs" };
    }

    const promptText = buildJobMatchPrompt(
      resumePre.data.normalizedText,
      jobPre.data.normalizedText,
    );

    let resultText: string;
    let effectiveProvider: string;
    let effectiveModel: string;

    if (useAccountRuntime && matchResolution.status === "RESOLVED") {
      const executed = await withSpan(
        "automation.analyze",
        {
          ...genAiRequestAttrs({
            provider: matchResolution.backendKind,
            model: matchResolution.model,
            surface: SURFACES.JOB_MATCH,
            system: JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
          }),
          ...inputSizeAttrs({
            resumeChars: resumePre.data.normalizedText.length,
            jobChars: jobPre.data.normalizedText.length,
          }),
          "jobsync.user_id": user.id,
          "jobsync.job_id": jobId,
          "jobsync.connection_id": matchResolution.connectionId,
        },
        async (span) => {
          const exec = await executeAIConnectionText({
            userId: user.id,
            connectionId: matchResolution.connectionId,
            model: matchResolution.model,
            prompt: `${JOB_MATCH_SYSTEM_PROMPT}\n\n${promptText}`,
          });
          span.setAttrs(
            genAiResponseAttrs({ finishReason: "stop", text: exec.text }),
          );
          return exec;
        },
      );
      resultText = executed.text;
      effectiveProvider = matchResolution.provider;
      effectiveModel = matchResolution.model;
    } else {
      const model = await getModel(
        ai.provider,
        ai.model || "llama3.2",
        user.id,
      );
      effectiveProvider = ai.provider;
      effectiveModel = ai.model || "llama3.2";
      const result = await withSpan(
        "automation.analyze",
        {
          ...genAiRequestAttrs({
            provider: ai.provider,
            model: ai.model || "llama3.2",
            temperature: 0.3,
            numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
            surface: SURFACES.JOB_MATCH,
            system: JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
          }),
          ...inputSizeAttrs({
            resumeChars: resumePre.data.normalizedText.length,
            jobChars: jobPre.data.normalizedText.length,
          }),
          "jobsync.user_id": user.id,
          "jobsync.job_id": jobId,
        },
        async (span) => {
          const generated = await generateText({
            model,
            system: JOB_MATCH_SYSTEM_PROMPT,
            prompt: promptText,
            temperature: 0.3,
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
      resultText = result.text;
    }

    const { scores, body } = parseJobMatch(resultText);
    if (!scores) {
      return { success: false, message: "AI did not return a match score" };
    }

    let previous: Record<string, unknown> = {};
    try {
      previous = JSON.parse(job.matchData ?? "{}");
    } catch {
      previous = {};
    }

    const matchData = JSON.stringify({
      ...previous,
      matchScore: scores.matchScore,
      recommendation: scores.recommendation,
      body,
      resumeId,
      resumeTitle: resume.title,
      matchedAt: new Date().toISOString(),
      provider: effectiveProvider,
      model: effectiveModel,
      analyzed: true,
    });

    await db.job.update({
      where: { id: jobId, userId: user.id },
      data: { matchScore: scores.matchScore, matchData },
    });

    return { success: true, matchScore: scores.matchScore };
  } catch (error) {
    // Stable business codes surface verbatim — a broken assigned
    // connection reports its real state, never a generic failure.
    if (error instanceof AIBusinessError) {
      return { success: false, message: `AI execution failed (${error.code})` };
    }
    return formatError(error, "Failed to analyze discovered job");
  }
}
