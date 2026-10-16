import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/constants";
import { hasDescription } from "@/lib/tasks/description";

// "TBD" was the placeholder the form used to auto-fill for unanswered
// questions. It is no longer generated, but records that already store it must
// stay editable without forcing an answer rewrite — so the marker is only
// accepted when updating (id present), never on create.
const LEGACY_EMPTY_ANSWER = "TBD";

export const AddQuestionFormSchema = z
  .object({
    id: z.string().optional(),
    question: z
      .string({ error: "Question is required." })
      .min(APP_CONSTANTS.MIN_QUESTION_LENGTH, { message: `Question must be at least ${APP_CONSTANTS.MIN_QUESTION_LENGTH} characters.` })
      .max(APP_CONSTANTS.MAX_QUESTION_LENGTH, { message: `Question cannot exceed ${APP_CONSTANTS.MAX_QUESTION_LENGTH} characters.` }),
    answer: z
      .string({ error: "Answer is required." })
      .max(APP_CONSTANTS.MAX_QUESTION_ANSWER_LENGTH, { message: `Answer cannot exceed ${APP_CONSTANTS.MAX_QUESTION_ANSWER_LENGTH} characters.` }),
    tagIds: z
      .array(z.string())
      .max(APP_CONSTANTS.MAX_JOB_TAGS, { message: `Maximum ${APP_CONSTANTS.MAX_JOB_TAGS} skill tags allowed.` })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!hasDescription(data.answer)) return;
    if (data.id && data.answer === LEGACY_EMPTY_ANSWER) return;
    if (data.answer.length < APP_CONSTANTS.MIN_QUESTION_ANSWER_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["answer"],
        message: `Answer must be at least ${APP_CONSTANTS.MIN_QUESTION_ANSWER_LENGTH} characters.`,
      });
    }
  });
