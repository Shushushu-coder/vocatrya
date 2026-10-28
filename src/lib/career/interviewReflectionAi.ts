/**
 * Interview reflection AI draft — the CAREER_REFLECTION business consumer.
 *
 * Resolves the CAREER_REFLECTION assignment (explicit → GLOBAL_DEFAULT →
 * honest NOT_CONFIGURED), assembles the interview step's context (step
 * facts, interview detail, position, submitted JD, the user's in-progress
 * notes), and runs one TEXT_ONLY one-shot through the shared execution
 * seam — the same transport the INTERVIEW purpose uses.
 *
 * The output is a draft only: it is returned to the caller and never
 * written to the reflection store here. Persistence stays on the existing
 * save path, gated by an explicit user confirmation.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  assertInterviewReflectionStep,
  normalizeReflectionText,
} from "./interviewReflection";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { isManagedResolution } from "@/lib/ai/business-execution-lock";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
} from "@/lib/ai/connections";
import {
  executeAIConnectionText,
  type ExecuteAIConnectionTextInput,
} from "@/lib/ai/execution";
import {
  isPlainObject,
  parseStructuredText,
} from "@/lib/ai/structured-output";

const CAREER_REFLECTION_PURPOSE = "CAREER_REFLECTION";
const MANAGED_RESOURCE_BUSINESS = "CAREER_REFLECTION";

/** A draft never needs more than a handful of questions; the rest is noise. */
export const REFLECTION_DRAFT_MAX_ITEMS = 8;
/** Bounded excerpts keep the one-shot prompt inside the request cap. */
const JD_EXCERPT_MAX_CHARS = 6000;
const STEP_NOTES_MAX_CHARS = 2000;

export type InterviewReflectionDraftItem = {
  questionText: string;
  answerNotes: string | null;
};

export type InterviewReflectionDraft = {
  reflectionText: string | null;
  items: InterviewReflectionDraftItem[];
};

/**
 * Generation outcome: a usable draft, or an honest resolution state the
 * caller surfaces as an unavailable affordance. Execution and parse
 * failures throw — they are request failures, not outcomes.
 */
export type InterviewReflectionDraftOutcome =
  | { status: "DRAFT"; draft: InterviewReflectionDraft }
  | { status: "NOT_CONFIGURED" }
  | { status: "INVALID_ASSIGNMENT"; code: string };

export type InterviewReflectionDraftContext = {
  stepLabel: string;
  stepStatus: string;
  scheduledAt: Date | null;
  completedAt: Date | null;
  stepResult: string | null;
  stepNotes: string | null;
  interviewFormat: string | null;
  interviewerNames: string | null;
  durationMinutes: number | null;
  interviewLocation: string | null;
  jobTitle: string;
  company: string | null;
  jobLocation: string | null;
  employmentType: string | null;
  channelLabel: string;
  resumeLabel: string | null;
  jdExcerpt: string | null;
  currentReflectionText: string | null;
  currentItems: { questionText: string; answerNotes: string | null }[];
};

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The prompt contract mirrors the INTERVIEW pattern: a system line plus a
 * user prompt flattened into one TEXT_ONLY request, with the JSON shape
 * embedded in the prompt and strict parsing on the way out.
 */
export function buildInterviewReflectionDraftPrompt(
  context: InterviewReflectionDraftContext,
): { system: string; prompt: string } {
  const system = [
    "You are an interview reflection coach. The user just finished an",
    "interview round and wants a structured first draft of their",
    "post-interview reflection to edit by hand. Return ONLY one valid JSON",
    "object — no markdown, no code fences, no commentary. Write every",
    "user-visible string in Simplified Chinese.",
  ].join(" ");

  const recordedQuestions =
    context.currentItems.length > 0
      ? context.currentItems
          .map(
            (item) =>
              `- question: ${item.questionText}${
                item.answerNotes ? `\n  answer notes: ${item.answerNotes}` : ""
              }`,
          )
          .join("\n")
      : "(none recorded)";

  const prompt = [
    "INTERVIEW_REFLECTION_DRAFT",
    "",
    "TASK: produce a draft reflection for the interview described below.",
    "",
    "JSON shape:",
    "{",
    '  "reflectionText": "<string or null>",',
    '  "items": [ { "questionText": "<string>", "answerNotes": "<string or null>" } ]',
    "}",
    "",
    "Rules:",
    `- items: 1-${REFLECTION_DRAFT_MAX_ITEMS} questions. When RECORDED`,
    "  QUESTIONS are given, keep the user's wording and their answer notes",
    "  verbatim — do not rewrite them. Questions you add come from the",
    "  role, the round, and the JD; their answerNotes are null.",
    "- reflectionText: a scaffold the user completes — short sections for",
    "  面试概况, 答得较好的地方, 需要改进的地方, 后续准备. Fill only what",
    "  the inputs state; mark unknowns with （待补充：…） prompts. When a",
    "  RECORDED REFLECTION TEXT exists, keep its meaning and structure it",
    "  into the same sections instead of replacing it with generic text.",
    "- Never invent answers the candidate gave, interviewer reactions,",
    "  interview outcomes, or facts about the candidate or the company.",
    "- All user-visible text in Simplified Chinese.",
    "",
    "## INTERVIEW STEP",
    `label: ${context.stepLabel}`,
    `status: ${context.stepStatus}`,
    `scheduledAt: ${isoOrNull(context.scheduledAt) ?? "(unscheduled)"}`,
    `completedAt: ${isoOrNull(context.completedAt) ?? "(not completed)"}`,
    `result: ${context.stepResult ?? "(none)"}`,
    `notes: ${context.stepNotes ?? "(none)"}`,
    "",
    "## INTERVIEW DETAIL",
    `format: ${context.interviewFormat ?? "(unknown)"}`,
    `interviewers: ${context.interviewerNames ?? "(unknown)"}`,
    `durationMinutes: ${context.durationMinutes ?? "(unknown)"}`,
    `location: ${context.interviewLocation ?? "(unknown)"}`,
    "",
    "## POSITION",
    `title: ${context.jobTitle}`,
    `company: ${context.company ?? "(unknown)"}`,
    `location: ${context.jobLocation ?? "(unknown)"}`,
    `employmentType: ${context.employmentType ?? "(unknown)"}`,
    `channel: ${context.channelLabel}`,
    `resume used: ${context.resumeLabel ?? "(unknown)"}`,
    "",
    "## JOB DESCRIPTION (untrusted excerpt)",
    context.jdExcerpt ?? "(not captured)",
    "",
    "## RECORDED REFLECTION TEXT (untrusted)",
    context.currentReflectionText ?? "(none recorded)",
    "",
    "## RECORDED QUESTIONS (untrusted)",
    recordedQuestions,
  ].join("\n");

  return { system, prompt };
}

function draftItemFrom(entry: unknown): InterviewReflectionDraftItem | null {
  if (!isPlainObject(entry)) return null;
  const questionText =
    typeof entry.questionText === "string" ? entry.questionText.trim() : "";
  if (!questionText) return null;
  return {
    questionText,
    answerNotes:
      typeof entry.answerNotes === "string"
        ? normalizeReflectionText(entry.answerNotes)
        : null,
  };
}

/**
 * Strict draft contract: the model's text must be a JSON object with a
 * usable reflectionText and/or at least one well-formed item. Malformed
 * items are dropped — a draft degrades, it never carries junk the save
 * path would reject. An entirely empty draft is a generation failure.
 */
export function parseInterviewReflectionDraft(
  raw: string,
): InterviewReflectionDraft {
  const parsed = parseStructuredText(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
      "AI returned a malformed reflection draft",
    );
  }
  const value = parsed.value;
  const reflectionText =
    typeof value.reflectionText === "string"
      ? normalizeReflectionText(value.reflectionText)
      : null;
  const items = (Array.isArray(value.items) ? value.items : [])
    .map(draftItemFrom)
    .filter(
      (item): item is InterviewReflectionDraftItem => item !== null,
    )
    .slice(0, REFLECTION_DRAFT_MAX_ITEMS);
  if (reflectionText === null && items.length === 0) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
      "AI returned an empty reflection draft",
    );
  }
  return { reflectionText, items };
}

type ReflectionDraftDb = Pick<
  PrismaClient,
  | "applicationProcessStep"
  | "aIBusinessAssignment"
  | "aIConnection"
  | "userSettings"
>;

export interface InterviewReflectionDraftDeps {
  dbClient?: ReflectionDraftDb;
  /** The TEXT_ONLY seam — injectable so tests observe the exact call. */
  execText?: (
    input: ExecuteAIConnectionTextInput,
  ) => Promise<{ text: string }>;
  /** Operation identity mint for managed dispatch — injectable for tests. */
  createOperationId?: (stepId: string) => string;
}

/**
 * Resolve CAREER_REFLECTION and generate one draft. The step must belong
 * to the user and be an INTERVIEW step — same ownership and category
 * gates as the manual reflection read path.
 */
export async function generateInterviewReflectionDraft(
  input: {
    userId: string;
    applicationProcessStepId: string;
    current?: {
      reflectionText?: string | null;
      items?: { questionText: string; answerNotes?: string | null }[];
    };
  },
  deps: InterviewReflectionDraftDeps = {},
): Promise<InterviewReflectionDraftOutcome> {
  const db = deps.dbClient ?? prisma;
  const step = await db.applicationProcessStep.findFirst({
    where: {
      id: input.applicationProcessStepId,
      applicationAttempt: { userId: input.userId },
    },
    select: {
      id: true,
      category: true,
      label: true,
      status: true,
      scheduledAt: true,
      completedAt: true,
      result: true,
      notes: true,
      interviewDetail: {
        select: {
          interviewFormat: true,
          locationText: true,
          interviewerNames: true,
          durationMinutes: true,
        },
      },
      applicationAttempt: {
        select: {
          channelLabel: true,
          jobOpportunity: {
            select: {
              title: true,
              locationText: true,
              employmentType: true,
              company: { select: { label: true } },
              currentJdVersion: { select: { rawContent: true } },
            },
          },
          submittedAgainstJdVersion: { select: { rawContent: true } },
          submittedResumeVersion: {
            select: {
              versionNumber: true,
              resumeVariant: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!step) {
    throw new CareerRuntimeError(
      "PROCESS_STEP_NOT_FOUND",
      "Process step not found",
    );
  }
  assertInterviewReflectionStep(step.category);

  const resolution = await resolveBusinessAIConfig(
    { userId: input.userId, purpose: CAREER_REFLECTION_PURPOSE },
    db,
  );
  if (resolution.status === "INVALID_ASSIGNMENT") {
    return { status: "INVALID_ASSIGNMENT", code: resolution.code };
  }
  if (resolution.status !== "RESOLVED") {
    return { status: "NOT_CONFIGURED" };
  }

  const opportunity = step.applicationAttempt.jobOpportunity;
  const jdText =
    step.applicationAttempt.submittedAgainstJdVersion?.rawContent ??
    opportunity.currentJdVersion?.rawContent ??
    null;
  const resumeVersion = step.applicationAttempt.submittedResumeVersion;
  const { system, prompt } = buildInterviewReflectionDraftPrompt({
    stepLabel: step.label,
    stepStatus: step.status,
    scheduledAt: step.scheduledAt,
    completedAt: step.completedAt,
    stepResult: clip(step.result, 200),
    stepNotes: clip(step.notes, STEP_NOTES_MAX_CHARS),
    interviewFormat: step.interviewDetail?.interviewFormat ?? null,
    interviewerNames: clip(step.interviewDetail?.interviewerNames, 500),
    durationMinutes: step.interviewDetail?.durationMinutes ?? null,
    interviewLocation: clip(step.interviewDetail?.locationText, 500),
    jobTitle: opportunity.title,
    company: opportunity.company.label,
    jobLocation: clip(opportunity.locationText, 300),
    employmentType: opportunity.employmentType,
    channelLabel: step.applicationAttempt.channelLabel,
    resumeLabel: resumeVersion
      ? `${resumeVersion.resumeVariant.name} v${resumeVersion.versionNumber}`
      : null,
    jdExcerpt: clip(jdText, JD_EXCERPT_MAX_CHARS),
    currentReflectionText: clip(input.current?.reflectionText, 4000),
    currentItems: (input.current?.items ?? [])
      .slice(0, REFLECTION_DRAFT_MAX_ITEMS)
      .map((item) => ({
        questionText: item.questionText,
        answerNotes: clip(item.answerNotes, 1000),
      }))
      .filter((item) => item.questionText.trim() !== ""),
  });

  const exec = deps.execText ?? executeAIConnectionText;
  const managed = isManagedResolution(resolution);
  const executed = await exec({
    userId: input.userId,
    connectionId: resolution.connectionId,
    model: resolution.model,
    prompt: `${system}\n\n${prompt}`,
    ...(managed
      ? {
          operationId: (
            deps.createOperationId ??
            ((stepId: string) => `career-reflection:${stepId}:${randomUUID()}`)
          )(step.id),
          managedResource: {
            business: MANAGED_RESOURCE_BUSINESS,
            resourceKey: `interview-reflection:${step.id}`,
          },
        }
      : {}),
  });

  return { status: "DRAFT", draft: parseInterviewReflectionDraft(executed.text) };
}
