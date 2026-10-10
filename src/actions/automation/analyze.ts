"use server";

import { createHash } from "node:crypto";
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
  code?: string;
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
    // A managed assignment executes through Hosted with a durable
    // operation identity keyed on the job — the manual analysis of a job
    // is one stable operation, so a repeated trigger replays to the same
    // receipt rather than double-billing.
    const managed =
      matchResolution.status === "RESOLVED" &&
      matchResolution.provider === "VOCATRYA" &&
      matchResolution.backendKind === "MANAGED_GATEWAY";

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

    // P1-02: the operation identity freezes the actual inputs, not just
    // the job. Legacy Job/Resume rows mutate in place and carry no
    // version authority, so the snapshot identity is the hash of the
    // exact normalized text sent to the model — a retried analysis of
    // the same input set replays, while a changed resume or JD mints a
    // new operation instead of returning the old score.
    const inputFingerprint = (text: string) =>
      createHash("sha256").update(text).digest("hex").slice(0, 20);
    const matchInput = {
      resume: inputFingerprint(resumePre.data.normalizedText),
      jobDescription: inputFingerprint(jobPre.data.normalizedText),
    };
    const matchInputKey = `${matchInput.resume}:${matchInput.jobDescription}`;

    let resultText: string;
    let effectiveProvider: string;
    let effectiveModel: string;

    if (useAccountRuntime && matchResolution.status === "RESOLVED") {
      let executed;
      try {
        executed = await withSpan(
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
            ...(managed
              ? {
                  operationId: `match-analysis:${jobId}:${matchInputKey}`,
                  managedResource: {
                    business: "MATCH_ANALYSIS",
                    resourceKey: `job-match:${jobId}`,
                  },
                }
              : {}),
          });
          span.setAttrs(
            genAiResponseAttrs({ finishReason: "stop", text: exec.text }),
          );
          return exec;
        },
      );
      } catch (error) {
        // Replay semantics: this exact input set's operation already
        // exists on the Hosted receipt ledger — return the score that
        // was persisted FOR THOSE INPUTS. A different input set mints a
        // different operationId, so a replay here can only mean the
        // same analysis ran before (same-key same-request dedupe).
        if (error instanceof AIBusinessError && error.code === "INVOCATION_REPLAYED") {
          const replayedScore = replayedMatchScore(job.matchData, matchInputKey);
          if (replayedScore !== undefined) {
            return { success: true, matchScore: replayedScore };
          }
          return {
            success: false,
            message: "This job was already analyzed",
            code: "INVOCATION_REPLAYED",
          };
        }
        throw error;
      }
      resultText = executed.text;
      // Match the runner's label for the same managed execution path so
      // persisted matchData provenance is uniform across entry points.
      effectiveProvider = managed ? "VOCATRYA_MANAGED" : matchResolution.provider;
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

    // Retain a bounded per-input analysis ledger alongside the headline
    // score: an older input set stays queryable for replay instead of
    // being silently overwritten by the newest analysis.
    const matchedAt = new Date().toISOString();
    const analyses: Record<string, { matchScore: number; matchedAt: string }> = {
      ...(typeof previous.analyses === "object" && previous.analyses !== null
        ? (previous.analyses as Record<string, { matchScore: number; matchedAt: string }>)
        : {}),
      [matchInputKey]: { matchScore: scores.matchScore, matchedAt },
    };
    const analysisKeys = Object.keys(analyses)
      .sort((a, b) => analyses[b].matchedAt.localeCompare(analyses[a].matchedAt))
      .slice(0, 20);

    const matchData = JSON.stringify({
      ...previous,
      matchScore: scores.matchScore,
      recommendation: scores.recommendation,
      body,
      resumeId,
      resumeTitle: resume.title,
      matchedAt,
      provider: effectiveProvider,
      model: effectiveModel,
      analyzed: true,
      analysisInputKey: matchInputKey,
      analyses: Object.fromEntries(analysisKeys.map((key) => [key, analyses[key]])),
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

/**
 * The score persisted for exactly this input set — the current analysis
 * when its key matches, or any older retained entry. A replay can only
 * resolve a score that was computed for the same resume+JD inputs;
 * anything else reports nothing rather than serving a stale answer.
 */
function replayedMatchScore(
  matchData: string | null,
  matchInputKey: string,
): number | undefined {
  try {
    const persisted = JSON.parse(matchData ?? "{}") as {
      matchScore?: number;
      analyzed?: boolean;
      analysisInputKey?: string;
      analyses?: Record<string, { matchScore?: number }>;
    };
    const retained = persisted.analyses?.[matchInputKey]?.matchScore;
    if (typeof retained === "number") return retained;
    if (
      persisted.analyzed &&
      persisted.analysisInputKey === matchInputKey &&
      typeof persisted.matchScore === "number"
    ) {
      return persisted.matchScore;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
