"use server";

import { requireUser } from "./shared";
import { getInterviewRuntime } from "@/lib/interview/runtime";
import { getServerLocale } from "@/i18n/server";
import { mapInterviewError as mapProductError } from "@/lib/interview/productErrors";
import { getInterviewReadiness } from "@/lib/interview/readiness";
import type { CoachingMode } from "@/lib/interview/persistence/interviewEnums";

async function mapInterviewError(error: unknown) {
  return mapProductError(error, await getServerLocale());
}

function runtime() {
  return getInterviewRuntime();
}

/**
 * Effective Interview readiness — same resolver semantics as session
 * creation (INTERVIEW assignment → legacy settings.ai.interview →
 * GLOBAL_DEFAULT → NOT_CONFIGURED; a broken explicit assignment reports
 * invalid_assignment, never a fallback).
 */
export async function getInterviewReadinessAction() {
  try {
    const user = await requireUser();
    const readiness = await getInterviewReadiness(user.id);
    return {
      success: true as const,
      data: readiness,
    };
  } catch (error) {
    return mapInterviewError(error);
  }
}

/** Jobs (+ JD versions) offered on the New Interview page. */
export async function listInterviewJobsAction() {
  try {
    const user = await requireUser();
    const jobs = await runtime().listUserJobs(user.id);
    return { success: true as const, data: jobs };
  } catch (error) {
    return mapInterviewError(error);
  }
}

/**
 * Create a product interview session. Question ids are gone — the
 * service plans 3 questions through the creation-time resolved AI
 * runtime (same lock the session persists). A planning failure aborts
 * creation; no empty session is left behind.
 */
export async function createInterviewSessionAction(input: {
  coachingMode?: CoachingMode;
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
}) {
  try {
    const user = await requireUser();
    const created = await runtime().createInterviewSession({
      userId: user.id,
      coachingMode: input.coachingMode ?? "PRACTICE",
      jobOpportunityId: input.jobOpportunityId ?? null,
      jobDescriptionVersionId: input.jobDescriptionVersionId ?? null,
    });
    return { success: true as const, data: created };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function getInterviewSessionAction(sessionId: string) {
  try {
    const user = await requireUser();
    const history = await runtime().loadSessionHistory(user.id, sessionId);
    return { success: true as const, data: history };
  } catch (error) {
    return mapInterviewError(error);
  }
}

/** Session cards for the landing history (derived readable fields). */
export async function listInterviewSessionsAction() {
  try {
    const user = await requireUser();
    const sessions = await runtime().listInterviewSessionCards(user.id);
    return { success: true as const, data: sessions };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function submitInterviewAnswerAction(input: {
  questionInstanceId: string;
  textContent: string;
}) {
  try {
    const user = await requireUser();
    const data = await runtime().submitInterviewAnswer({
      userId: user.id,
      questionInstanceId: input.questionInstanceId,
      textContent: input.textContent,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function generateInterviewFeedbackAction(answerAttemptId: string) {
  try {
    const user = await requireUser();
    const data = await runtime().generateInterviewFeedback({
      userId: user.id,
      answerAttemptId,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

/**
 * Server-side "next question". Validates the current question was
 * answered with succeeded feedback before advancing
 * currentQuestionInstanceId — clients never write it directly.
 */
export async function advanceInterviewQuestionAction(sessionId: string) {
  try {
    const user = await requireUser();
    const data = await runtime().advanceToNextQuestion({
      userId: user.id,
      sessionId,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function sendInterviewFollowUpAction(input: {
  sessionId: string;
  userText: string;
  targetType?: string;
  questionInstanceId?: string | null;
  commercialFeedbackItemId?: string | null;
}) {
  try {
    const user = await requireUser();
    const data = await runtime().sendInterviewFollowUp({
      userId: user.id,
      sessionId: input.sessionId,
      userText: input.userText,
      targetType: input.targetType ?? "SESSION",
      questionInstanceId: input.questionInstanceId ?? null,
      commercialFeedbackItemId: input.commercialFeedbackItemId ?? null,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

/**
 * Finish the interview: validate readiness → assemble real interview
 * content → generate → publish → mark COMPLETED inside the same short
 * transaction. A generation failure leaves the session IN_PROGRESS so
 * the user can retry.
 */
export async function generateInterviewSummaryAction(sessionId: string) {
  try {
    const user = await requireUser();
    const data = await runtime().generateInterviewSummary({
      userId: user.id,
      sessionId,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}
