"use server";

import { requireUser } from "./shared";
import { getInterviewRuntime } from "@/lib/interview/runtime";
import { mapInterviewError } from "@/lib/interview/productErrors";
import { getInterviewConfig } from "@/lib/interview/interviewSettings";
import {
  updateInterviewAiSettings,
  clearInterviewAiSettings,
  getUserSettings,
} from "./userSettings.actions";
import type { InterviewAiSettings } from "@/models/userSettings.model";
import type { CoachingMode } from "@/lib/interview/persistence/interviewEnums";

function runtime() {
  return getInterviewRuntime();
}

export async function getInterviewConfigAction() {
  try {
    await requireUser();
    const settings = await getUserSettings();
    const config = getInterviewConfig(settings?.data?.settings);
    return {
      success: true as const,
      data: {
        configured: Boolean(config),
        provider: config?.provider ?? null,
        model: config?.model ?? null,
      },
    };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function updateInterviewConfigAction(input: InterviewAiSettings) {
  try {
    await requireUser();
    return updateInterviewAiSettings(input);
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function clearInterviewConfigAction() {
  try {
    await requireUser();
    return clearInterviewAiSettings();
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function listInterviewPresetsAction() {
  try {
    const user = await requireUser();
    const app = runtime();
    await app.ensurePreset(user.id);
    const presets = await app.listPresets();
    const questions = await app.listUserQuestions(user.id);
    const jobs = await app.listUserJobs(user.id);
    return { success: true as const, data: { presets, questions, jobs } };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function createInterviewSessionAction(input: {
  coachingMode?: CoachingMode;
  questionIds: string[];
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
}) {
  try {
    const user = await requireUser();
    const app = runtime();
    const [ownedQuestions, presets] = await Promise.all([
      app.listUserQuestions(user.id),
      app.listPresets(),
    ]);
    const questions = [];
    for (const questionId of input.questionIds) {
      const owned = ownedQuestions.find((row) => row.id === questionId);
      const preset = presets.find((row) => row.questionId === questionId);
      const prompt = owned?.promptText ?? preset?.promptText;
      if (!prompt) {
        return {
          success: false as const,
          code: "QUESTION_NOT_FOUND",
          message: "题目不存在。",
        };
      }
      questions.push({
        displayedText: prompt,
        sourceKind: preset ? ("QUESTION_BANK" as const) : ("USER_PROVIDED" as const),
        sourceQuestionId: questionId,
        category: owned?.category ?? preset?.category ?? null,
        referenceAnswerSnapshot: owned?.referenceAnswer ?? preset?.referenceAnswer ?? null,
      });
    }
    const created = await app.createInterviewSession({
      userId: user.id,
      coachingMode: input.coachingMode ?? "PRACTICE",
      questions,
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

export async function listInterviewSessionsAction() {
  try {
    const user = await requireUser();
    const sessions = await runtime().listInterviewSessions(user.id);
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

export async function getInterviewFeedbackAction(answerAttemptId: string) {
  try {
    const user = await requireUser();
    const data = await runtime().getInterviewFeedback(user.id, answerAttemptId);
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function sendInterviewFollowUpAction(input: {
  sessionId: string;
  userText: string;
  targetType?: string;
  commercialFeedbackItemId?: string | null;
}) {
  try {
    const user = await requireUser();
    const data = await runtime().sendInterviewFollowUp({
      userId: user.id,
      sessionId: input.sessionId,
      userText: input.userText,
      targetType: input.targetType ?? "SESSION",
      commercialFeedbackItemId: input.commercialFeedbackItemId ?? null,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function generateInterviewSummaryAction(sessionId: string) {
  try {
    const user = await requireUser();
    await runtime().completeSession(user.id, sessionId);
    const data = await runtime().generateInterviewSummary({
      userId: user.id,
      sessionId,
    });
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}

export async function getInterviewSummaryAction(sessionId: string) {
  try {
    const user = await requireUser();
    const data = await runtime().getInterviewSummary(user.id, sessionId);
    return { success: true as const, data };
  } catch (error) {
    return mapInterviewError(error);
  }
}
