import {
  INTERVIEW_ADAPTER_ERROR_CODES,
  InterviewAdapterError,
} from "./errors";
import { assertSameUser } from "./userAdapter";

/**
 * Question -> interview snapshot adapter (Phase 2).
 *
 * Binds the living Vocatrya `Question` (question / answer? / createdBy /
 * createdVia + Tag[] relation) to the frozen domain snapshot shape without
 * creating any InterviewSession/QuestionInstance storage. That storage is
 * REQUIRES_SCHEMA_CHANGE and belongs to Phase 3.
 *
 * Drift digested here (ADAPTERABLE_DRIFT):
 * - `Question.question`        -> `displayedText`
 * - `Question.answer`          -> `referenceAnswerSnapshot`
 * - host Tag[] expression      -> snapshot `tags` + `category`
 * - `Question.createdVia`      -> snapshot provenance (verbatim copy)
 */

export interface QuestionTagLike {
  value?: unknown;
  label?: unknown;
}

export interface QuestionLike {
  id: string;
  question: string;
  answer?: string | null;
  createdBy: string;
  createdVia?: string | null;
  tags?: QuestionTagLike[] | null;
}

/** Deterministic domain snapshot for exactly one living Question. */
export interface QuestionSnapshot {
  questionId: string;
  sourceQuestionId: string;
  displayedText: string;
  referenceAnswerSnapshot: string | null;
  /** Sorted tag values; deterministic across reads. */
  tags: string[];
  /** First sorted tag value, or null when untagged. */
  category: string | null;
  createdVia: string | null;
}

function snapshotTags(tags: QuestionTagLike[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const values = new Set<string>();
  for (const tag of tags) {
    if (!tag || typeof tag !== "object") continue;
    const raw =
      typeof tag.value === "string" && tag.value.trim().length > 0
        ? tag.value.trim()
        : typeof tag.label === "string" && tag.label.trim().length > 0
          ? tag.label.trim()
          : undefined;
    if (raw) values.add(raw);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * Pure mapper. Throws QUESTION_INVALID on empty text and
 * SESSION_FORBIDDEN on cross-user binds. Never touches the database.
 */
export function mapQuestionToSnapshot(
  question: QuestionLike,
  actorUserId: string,
): QuestionSnapshot {
  if (!question || typeof question.id !== "string" || !question.id) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_INVALID,
      "Question id is required",
    );
  }
  assertSameUser(question.createdBy, actorUserId);
  const displayedText =
    typeof question.question === "string" ? question.question.trim() : "";
  if (!displayedText) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_INVALID,
      "Question text is required",
    );
  }
  const tags = snapshotTags(question.tags);
  const referenceAnswerSnapshot =
    typeof question.answer === "string" && question.answer.trim().length > 0
      ? question.answer
      : (question.answer ?? null);
  return {
    questionId: question.id,
    sourceQuestionId: question.id,
    displayedText,
    referenceAnswerSnapshot: referenceAnswerSnapshot ?? null,
    tags,
    category: tags.length > 0 ? tags[0] : null,
    createdVia: question.createdVia ?? null,
  };
}

export interface QuestionReader {
  question: {
    findUnique: (args: {
      where: { id: string };
      include?: { tags?: boolean };
    }) => Promise<QuestionLike | null>;
  };
}

/**
 * Ownership-checked loader. Uses the real Question row (with tags) and
 * returns the deterministic snapshot. Throws QUESTION_NOT_FOUND when the
 * row is missing and SESSION_FORBIDDEN on cross-user access.
 */
export async function loadQuestionSnapshot(
  db: QuestionReader,
  actorUserId: string,
  questionId: string,
): Promise<QuestionSnapshot> {
  if (!questionId || typeof questionId !== "string") {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_INVALID,
      "questionId is required",
    );
  }
  const row = await db.question.findUnique({
    where: { id: questionId },
    include: { tags: true },
  });
  if (!row) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_NOT_FOUND,
      "Question not found",
    );
  }
  return mapQuestionToSnapshot(row, actorUserId);
}
