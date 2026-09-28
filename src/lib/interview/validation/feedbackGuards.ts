/**
 * Participant-visible feedback field guards (semantic safety).
 *
 * Adapted from InterviewDx feedback validators — the product subset only:
 * stable-trait / ability / motivation / hiring-outcome judgements and
 * internal-schema leakage are prohibited in every user-visible field.
 * Research-condition rules (diagnostic/descriptive, treatment/control)
 * are intentionally NOT ported.
 *
 * Every violation throws DomainError(INVALID_FEEDBACK_ITEM) so the
 * generation pipeline can reject the whole candidate output and (at most
 * once) fully regenerate — rejected payloads are never persisted.
 */
import { DomainError, ErrorCodes } from "../persistence/interviewErrors";

export const FEEDBACK_FIELD_GUARD_VERSION = "feedback_field_guard_v1";

type GuardRule = { id: string; pattern: RegExp };

const FIELD_GUARD_RULES: GuardRule[] = [
  {
    id: "personality_judgment_en_v1",
    pattern:
      /\b(?:your|the candidate(?:'s)?)\s+personality\s+(?:is|seems)\b/i,
  },
  {
    id: "personality_judgment_zh_v1",
    pattern: /(?:你|候选人)(?:的)?(?:性格|人格).{0,8}(?:粗心|懒惰|固执|内向|外向|消极)/,
  },
  {
    id: "general_ability_judgment_en_v1",
    pattern: /\b(?:you|the candidate)\s+lacks?\s+(?:the\s+)?ability\b/i,
  },
  {
    id: "general_ability_judgment_zh_v1",
    pattern:
      /(?:你|候选人)(?:的)?(?:分析|沟通|表达|学习|执行|解决问题)?能力.{0,4}(?:不足|欠缺|较差|不够|有限)/,
  },
  {
    id: "motivation_attitude_judgment_en_v1",
    pattern:
      /\b(?:you|the candidate)\s+(?:lacks?\s+motivation|has\s+(?:a\s+)?(?:negative|poor)\s+attitude)\b/i,
  },
  {
    id: "motivation_attitude_judgment_zh_v1",
    pattern: /(?:你|候选人)(?:的)?(?:态度|动机).{0,8}(?:消极|不足|欠缺|不端正|有问题)/,
  },
  {
    id: "ability_lack_zh_v1",
    pattern: /(?:你|候选人)(?:的)?(?:缺乏|没有|缺少).{0,4}能力/,
  },
  {
    id: "habit_confidence_attribution_en_v1",
    pattern:
      /\b(?:(?:you|the candidate)\s+(?:always|habitually)\b|(?:you|the candidate)\s+lacks?\s+confidence\b)/i,
  },
  {
    id: "habit_confidence_attribution_zh_v1",
    pattern: /(?:(?:你|候选人)(?:总是|一贯|习惯性)|(?:你|候选人)?(?:缺乏|没有|不够)自信)/,
  },
  {
    id: "outcome_prediction_en_v1",
    pattern:
      /\b(?:chances?\s+of\s+being\s+hired|(?:will|would|won't|cannot)\s+(?:pass|fail)\s+(?:the\s+)?interview|(?:will|would|won't)\s+(?:be|get)\s+hired)\b/i,
  },
  {
    id: "outcome_prediction_zh_v1",
    pattern:
      /(?:面试.{0,6}(?:无法|不能|难以|不会)?通过|(?:无法|不能|难以|不会|不被)(?:被)?录用|录用(?:机会|概率|结果))/,
  },
];

/** Internal/schema vocabulary that must never reach user-visible text. */
const INTERNAL_TERMS = [
  "problem_label",
  "taxonomy",
  "kb_taxonomy",
  "reason_diagnostic",
  "grounding_sources",
  "prompt version",
  "prompt_version",
  "schema",
  "json",
  "内部字段",
];

export class FeedbackFieldGuardViolation extends Error {
  readonly fieldPath: string;
  readonly ruleIds: string[];

  constructor(fieldPath: string, ruleIds: string[]) {
    super("feedback field failed semantic guard");
    this.name = "FeedbackFieldGuardViolation";
    this.fieldPath = fieldPath;
    this.ruleIds = ruleIds;
  }
}

/**
 * Assert one user-visible string is safe. Throws
 * DomainError(INVALID_FEEDBACK_ITEM) listing the matched rule ids.
 */
export function assertFeedbackFieldSafe(fieldPath: string, text: unknown): void {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value.trim()) {
    throw new DomainError(
      ErrorCodes.INVALID_FEEDBACK_ITEM,
      `${fieldPath} cannot be empty`,
    );
  }
  const matched = FIELD_GUARD_RULES.filter((rule) => rule.pattern.test(value)).map(
    (rule) => rule.id,
  );
  if (matched.length) {
    throw new DomainError(
      ErrorCodes.INVALID_FEEDBACK_ITEM,
      `${fieldPath} violates participant-visible guard: ${matched.join(",")}`,
    );
  }
  const lowered = value.toLowerCase();
  const leaked = INTERNAL_TERMS.filter((term) => lowered.includes(term));
  if (leaked.length) {
    throw new DomainError(
      ErrorCodes.INVALID_FEEDBACK_ITEM,
      `${fieldPath} leaks internal terminology: ${leaked.join(",")}`,
    );
  }
}

/**
 * Guard every participant-visible field of one validated feedback item.
 * problemLabel, problemStatement, suggestion, and the explanation fields
 * all must pass; the first violation rejects the item.
 */
export function guardFeedbackItem(item: {
  problemLabel: string;
  suggestion: string;
  evidence: { problemStatement: string };
  explanation: {
    underlyingCause: string;
    performanceImpact: string;
    interviewerPerspective?: string | null;
  };
}): void {
  assertFeedbackFieldSafe("problemLabel", item.problemLabel);
  assertFeedbackFieldSafe(
    "evidence.problemStatement",
    item.evidence.problemStatement,
  );
  assertFeedbackFieldSafe(
    "explanation.underlyingCause",
    item.explanation.underlyingCause,
  );
  assertFeedbackFieldSafe(
    "explanation.performanceImpact",
    item.explanation.performanceImpact,
  );
  if (item.explanation.interviewerPerspective) {
    assertFeedbackFieldSafe(
      "explanation.interviewerPerspective",
      item.explanation.interviewerPerspective,
    );
  }
  assertFeedbackFieldSafe("suggestion", item.suggestion);
}
