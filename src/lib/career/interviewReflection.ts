import { CareerRuntimeError } from "./errors";
import { PROCESS_STEP_CATEGORY } from "./identities";

export const INTERVIEW_REFLECTION_SORT_STEP = 10;

export type InterviewReflectionItemDTO = {
  id: string;
  questionText: string;
  answerNotes: string | null;
  sortOrder: number;
};

export type InterviewReflectionDTO = {
  applicationProcessStepId: string;
  reflectionText: string | null;
  items: InterviewReflectionItemDTO[];
};

export type SaveInterviewReflectionItemInput = {
  id?: string;
  questionText: string;
  answerNotes?: string | null;
};

export type SaveInterviewReflectionInput = {
  applicationProcessStepId: string;
  reflectionText?: string | null;
  items: SaveInterviewReflectionItemInput[];
};

export type NormalizedInterviewReflectionItem = {
  id?: string;
  questionText: string;
  answerNotes: string | null;
};

export function assertInterviewReflectionStep(category: string): void {
  if (category !== PROCESS_STEP_CATEGORY.INTERVIEW) {
    throw new CareerRuntimeError(
      "INTERVIEW_REFLECTION_STEP_CATEGORY_INVALID",
      "Interview reflection can only belong to an INTERVIEW process step",
    );
  }
}

export function emptyInterviewReflection(
  applicationProcessStepId: string,
): InterviewReflectionDTO {
  return {
    applicationProcessStepId,
    reflectionText: null,
    items: [],
  };
}

export function toInterviewReflectionDTO(
  applicationProcessStepId: string,
  reflectionText: string | null | undefined,
  items: ReadonlyArray<{
    id: string;
    questionText: string;
    answerNotes: string | null;
    sortOrder: number;
  }>,
): InterviewReflectionDTO {
  return {
    applicationProcessStepId,
    reflectionText: reflectionText ?? null,
    items: [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({
        id: item.id,
        questionText: item.questionText,
        answerNotes: item.answerNotes,
        sortOrder: item.sortOrder,
      })),
  };
}

export function normalizeReflectionText(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeInterviewQuestionText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CareerRuntimeError(
      "INTERVIEW_REFLECTION_QUESTION_REQUIRED",
      "Interview reflection question text is required",
    );
  }
  return trimmed;
}

export function normalizeSaveInterviewReflectionItems(
  items: SaveInterviewReflectionItemInput[],
): NormalizedInterviewReflectionItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const id =
      typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined;
    if (id) {
      if (seen.has(id)) {
        throw new CareerRuntimeError(
          "INTERVIEW_REFLECTION_ITEM_DUPLICATE",
          "Interview reflection item ids must be unique in one save",
        );
      }
      seen.add(id);
    }
    return {
      id,
      questionText: normalizeInterviewQuestionText(item.questionText),
      answerNotes: normalizeReflectionText(item.answerNotes),
    };
  });
}

export function isEmptyInterviewReflectionSave(
  reflectionText: string | null,
  items: NormalizedInterviewReflectionItem[],
): boolean {
  return reflectionText == null && items.length === 0;
}

export function interviewReflectionSortOrder(index: number): number {
  return (index + 1) * INTERVIEW_REFLECTION_SORT_STEP;
}
