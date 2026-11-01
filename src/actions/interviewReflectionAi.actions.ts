"use server";

import prisma from "@/lib/db";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import { CareerRuntimeError } from "@/lib/career/errors";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import {
  resolveCareerRuntimeMode,
  type CareerRuntimeResolution,
} from "@/lib/career/runtimeMode";
import { CAREER_REFLECTION_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  generateInterviewReflectionDraft as runInterviewReflectionDraft,
  type InterviewReflectionDraftOutcome,
} from "@/lib/career/interviewReflectionAi";
import type { ActionResult } from "@/models/action.model";

// The dialog's in-progress content is prompt context, not a stored value —
// bounded like any request body before it reaches the model.
const MAX_CURRENT_ITEMS = 8;
const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;
const MAX_REFLECTION_CHARS = 4000;

function isFullAbReadSurface(runtime: CareerRuntimeResolution): boolean {
  if (runtime.mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) return true;
  return isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope);
}

function clipContext(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Generates an AI reflection draft for an INTERVIEW process step. The
 * result is a draft contract only — this action never writes the
 * reflection store; persistence stays on saveInterviewReflection after
 * the user applies the draft and confirms.
 */
export async function generateInterviewReflectionDraft(input: {
  applicationProcessStepId: string;
  current?: {
    reflectionText?: string | null;
    items?: { questionText?: string; answerNotes?: string | null }[];
  };
}): Promise<ActionResult<InterviewReflectionDraftOutcome>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isFullAbReadSurface(runtime)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        CAREER_REFLECTION_UNAVAILABLE_MESSAGE,
      );
    }
    const stepId =
      typeof input?.applicationProcessStepId === "string"
        ? input.applicationProcessStepId.trim()
        : "";
    if (!stepId) {
      throw new CareerRuntimeError("INVALID_ID", "Invalid process step id");
    }
    const items = (
      Array.isArray(input?.current?.items) ? input.current.items : []
    )
      .slice(0, MAX_CURRENT_ITEMS)
      .map((item) => ({
        questionText: clipContext(item?.questionText, MAX_QUESTION_CHARS),
        answerNotes: clipContext(item?.answerNotes, MAX_ANSWER_CHARS),
      }))
      .filter(
        (
          item,
        ): item is { questionText: string; answerNotes: string | null } =>
          item.questionText !== null,
      );
    const outcome = await runInterviewReflectionDraft({
      userId: user.id,
      applicationProcessStepId: stepId,
      current: {
        reflectionText: clipContext(
          input?.current?.reflectionText,
          MAX_REFLECTION_CHARS,
        ),
        items,
      },
    });
    return { success: true, data: outcome };
  } catch (error) {
    if (error instanceof AIBusinessError) {
      return { success: false, code: error.code, message: error.message };
    }
    const result = handleError(error, "Failed to generate interview reflection draft.");
    if (error instanceof CareerRuntimeError) {
      return { success: false, code: error.code, message: result.message };
    }
    return result;
  }
}
