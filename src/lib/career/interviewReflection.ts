import { CareerRuntimeError } from "./errors";
import { PROCESS_STEP_CATEGORY } from "./identities";

export const INTERVIEW_REFLECTION_SORT_STEP = 10;

export const REFLECTION_ITEM_SOURCE_KIND = {
  QUESTION_BANK: "QUESTION_BANK",
  AD_HOC: "AD_HOC",
  PRACTICE_SESSION: "PRACTICE_SESSION",
} as const;

export type ReflectionItemSourceKind =
  (typeof REFLECTION_ITEM_SOURCE_KIND)[keyof typeof REFLECTION_ITEM_SOURCE_KIND];

const REFLECTION_ITEM_SOURCE_KINDS = new Set<string>(
  Object.values(REFLECTION_ITEM_SOURCE_KIND),
);

export type InterviewReflectionItemDTO = {
  id: string;
  questionText: string;
  answerNotes: string | null;
  sourceQuestionId: string | null;
  sourceKind: ReflectionItemSourceKind | null;
  /** False when the bank row is missing, inactive, or soft-deleted. */
  sourceQuestionActive: boolean;
  sortOrder: number;
};

export type InterviewReflectionDTO = {
  applicationProcessStepId: string;
  reflectionText: string | null;
  /** ISO instant. Null means draft or never marked complete. */
  reflectionCompletedAt: string | null;
  items: InterviewReflectionItemDTO[];
};

export type SaveInterviewReflectionItemInput = {
  id?: string;
  questionText: string;
  answerNotes?: string | null;
  sourceQuestionId?: string | null;
  sourceKind?: string | null;
};

export type SaveInterviewReflectionInput = {
  applicationProcessStepId: string;
  reflectionText?: string | null;
  items: SaveInterviewReflectionItemInput[];
  /**
   * Omitted keeps the stored mark. `true` sets the server clock when the
   * mark is empty. `false` clears it. Clients never send a timestamp.
   */
  reflectionCompleted?: boolean;
};

export type NormalizedInterviewReflectionItem = {
  id?: string;
  questionText: string;
  answerNotes: string | null;
  sourceQuestionId: string | null;
  sourceKind: ReflectionItemSourceKind | null;
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
    reflectionCompletedAt: null,
    items: [],
  };
}

export function toInterviewReflectionDTO(
  applicationProcessStepId: string,
  reflectionText: string | null | undefined,
  reflectionCompletedAt: Date | string | null | undefined,
  items: ReadonlyArray<{
    id: string;
    questionText: string;
    answerNotes: string | null;
    sourceQuestionId?: string | null;
    sourceKind?: string | null;
    sourceQuestionActive?: boolean;
    sortOrder: number;
  }>,
): InterviewReflectionDTO {
  return {
    applicationProcessStepId,
    reflectionText: reflectionText ?? null,
    reflectionCompletedAt:
      reflectionCompletedAt instanceof Date
        ? reflectionCompletedAt.toISOString()
        : (reflectionCompletedAt ?? null),
    items: [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({
        id: item.id,
        questionText: item.questionText,
        answerNotes: item.answerNotes,
        sourceQuestionId: item.sourceQuestionId ?? null,
        sourceKind: isReflectionItemSourceKind(item.sourceKind)
          ? item.sourceKind
          : null,
        sourceQuestionActive: item.sourceQuestionActive === true,
        sortOrder: item.sortOrder,
      })),
  };
}

export function isReflectionItemSourceKind(
  value: string | null | undefined,
): value is ReflectionItemSourceKind {
  return typeof value === "string" && REFLECTION_ITEM_SOURCE_KINDS.has(value);
}

export function reflectionHasContent(
  reflectionText: string | null | undefined,
  itemCount: number,
): boolean {
  return normalizeReflectionText(reflectionText) != null || itemCount > 0;
}

/**
 * `true` stamps now only when the mark is empty. `false` clears it.
 * Omitted keeps the stored instant.
 */
export function nextReflectionCompletedAt(
  existing: Date | null | undefined,
  requested: boolean | undefined,
  now: Date,
): Date | null {
  if (requested === true) return existing ?? now;
  if (requested === false) return null;
  return existing ?? null;
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
    const source = normalizeReflectionItemSource(item);
    return {
      id,
      questionText: normalizeInterviewQuestionText(item.questionText),
      answerNotes: normalizeReflectionText(item.answerNotes),
      sourceQuestionId: source.sourceQuestionId,
      sourceKind: source.sourceKind,
    };
  });
}

export function normalizeReflectionItemSource(item: {
  sourceQuestionId?: string | null;
  sourceKind?: string | null;
}): {
  sourceQuestionId: string | null;
  sourceKind: ReflectionItemSourceKind | null;
} {
  const sourceQuestionId =
    typeof item.sourceQuestionId === "string" && item.sourceQuestionId.trim()
      ? item.sourceQuestionId.trim()
      : null;
  const rawKind =
    typeof item.sourceKind === "string" && item.sourceKind.trim()
      ? item.sourceKind.trim()
      : null;
  if (rawKind == null && sourceQuestionId == null) {
    return { sourceQuestionId: null, sourceKind: null };
  }
  if (!isReflectionItemSourceKind(rawKind)) {
    throw new CareerRuntimeError(
      "INTERVIEW_REFLECTION_SOURCE_KIND_INVALID",
      "Interview reflection source kind is invalid",
    );
  }
  if (rawKind === REFLECTION_ITEM_SOURCE_KIND.AD_HOC && sourceQuestionId) {
    throw new CareerRuntimeError(
      "INTERVIEW_REFLECTION_SOURCE_KIND_INVALID",
      "An ad-hoc reflection item cannot link a question bank row",
    );
  }
  return { sourceQuestionId, sourceKind: rawKind };
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
