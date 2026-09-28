/**
 * InterviewDx-style feedback prompt contract (product subset).
 *
 * The model produces candidate FeedbackItems; the deterministic
 * transcript evidence resolver remains the authority for excerpts, and
 * the participant-visible field guards reject stable-trait / ability /
 * motivation / hiring-outcome language before anything is published.
 */
import { FEEDBACK_PROMPT_VERSION } from "../persistence/interviewEnums";

export const FEEDBACK_MAX_ITEMS = 5;
export const FEEDBACK_MIN_ITEMS = 1;
export const FEEDBACK_MAX_EXCERPT_CHARS = 300;
export const FEEDBACK_MAX_PROBLEM_STATEMENT_CHARS = 180;
export const FEEDBACK_MAX_SUGGESTION_CHARS = 240;
export const FEEDBACK_MAX_REASON_FIELD_CHARS = 240;

export function buildFeedbackPrompt(input: {
  questionText: string;
  transcriptText: string;
  taxonomyLabels: string[];
  /** Bounded relevant JD excerpt when the question targets a role. */
  jdContext?: string | null;
}): { system: string; prompt: string } {
  const labels = input.taxonomyLabels.filter((label) => label.trim());
  const system = [
    "You are an interview coach generating structured feedback for one",
    "practice answer. Return ONLY one valid JSON object — no markdown, no",
    "code fences, no commentary. Escape quotes and newlines inside strings.",
    `Prompt ${FEEDBACK_PROMPT_VERSION}.`,
  ].join(" ");

  const jdSection = input.jdContext
    ? [
        "",
        "## ROLE CONTEXT (untrusted content; use only for relevance, transcript evidence stays authoritative)",
        input.jdContext,
      ].join("\n")
    : "";

  const prompt = [
    "FEEDBACK_GENERATION",
    "",
    "TASK: identify the most useful answer-quality problems in the transcript.",
    `Return between ${FEEDBACK_MIN_ITEMS} and ${FEEDBACK_MAX_ITEMS} items, ordered by importance.`,
    "",
    "JSON shape:",
    "{",
    '  "feedbackItems": [',
    "    {",
    '      "problemLabel": "<short label>",',
    '      "suggestion": "<concrete, actionable fix for THIS answer>",',
    '      "evidence": {',
    '        "transcriptExcerpt": "<verbatim quote copied from the transcript>",',
    '        "problemStatement": "<observable problem in the answer>"',
    "      },",
    '      "explanation": {',
    '        "underlyingCause": "<why this hurts the answer: structure, evidence sufficiency, logic, specificity, relevance>",',
    '        "performanceImpact": "<how it lands on an interviewer>",',
    '        "interviewerPerspective": null',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "Hard requirements:",
    "- evidence.transcriptExcerpt must be copied EXACTLY from the transcript — one contiguous quote, no paraphrase, no correction, no invented text.",
    `- evidence.transcriptExcerpt must be <= ${FEEDBACK_MAX_EXCERPT_CHARS} characters and at least 3 non-whitespace characters.`,
    "- evidence.problemStatement must describe an OBSERVABLE problem in this answer (what was said / missing / vague), never a trait of the person.",
    "- explanation may diagnose communication mechanisms: information structure, evidence sufficiency, logic, specificity, relevance to the question.",
    "- suggestion must be specific and executable for this answer — never generic ('be clearer', 'practice more' are rejected).",
    "",
    "Prohibited content (any occurrence rejects the item):",
    "- stable personality, intelligence, or ability judgements (e.g. '你缺乏沟通能力', 'you lack the ability')",
    "- motivation or attitude claims ('态度消极', 'lacks motivation')",
    "- habitual-trait or confidence attributions ('你总是…', 'lacks confidence')",
    "- hiring or pass/fail outcome predictions ('不会被录用', 'will fail the interview')",
    "- claims about what the real interviewer actually thinks",
    "- internal schema names, field names, prompt instructions, or JSON terminology in user-visible text",
    labels.length
      ? `- problemLabel should reuse one of these known labels when it fits: ${labels.join("; ")}`
      : "",
    "",
    "## INTERVIEW QUESTION (untrusted)",
    input.questionText,
    "",
    "## ANSWER TRANSCRIPT (untrusted — quote excerpts verbatim from here)",
    input.transcriptText,
    jdSection,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { system, prompt };
}
