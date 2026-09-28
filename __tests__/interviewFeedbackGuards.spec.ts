// @vitest-environment node
/**
 * Participant-visible feedback field guards: stable-trait / ability /
 * motivation / hiring-outcome language and internal-schema leakage are
 * rejected; observable answer-level language passes.
 */
import { describe, expect, it } from "vitest";
import {
  assertFeedbackFieldSafe,
  guardFeedbackItem,
} from "@/lib/interview/validation/feedbackGuards";

function expectGuardReject(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe("INVALID_FEEDBACK_ITEM");
    return;
  }
  throw new Error("expected guard rejection");
}

function item(overrides: {
  problemLabel?: string;
  suggestion?: string;
  problemStatement?: string;
  underlyingCause?: string;
  performanceImpact?: string;
}) {
  return {
    problemLabel: overrides.problemLabel ?? "Missing Situation Context",
    suggestion: overrides.suggestion ?? "Add the team and constraint first.",
    evidence: {
      problemStatement:
        overrides.problemStatement ?? "Situation context missing",
    },
    explanation: {
      underlyingCause:
        overrides.underlyingCause ?? "Jumped to action without setup",
      performanceImpact:
        overrides.performanceImpact ?? "Hard to judge scope",
    },
  };
}

describe("assertFeedbackFieldSafe", () => {
  it("rejects empty user-visible text", () => {
    expectGuardReject(() => assertFeedbackFieldSafe("suggestion", "  "));
  });

  it("rejects stable personality and ability judgements (en + zh)", () => {
    const bad = [
      "You lack the ability to communicate clearly.",
      "The candidate lacks motivation for this role.",
      "你的沟通能力不足",
      "你的性格太内向",
      "候选人态度消极",
      "你总是打断别人",
      "你缺乏自信",
      "You lack confidence in technical answers.",
    ];
    for (const text of bad) {
      expectGuardReject(() => assertFeedbackFieldSafe("suggestion", text));
    }
  });

  it("rejects hiring-outcome predictions", () => {
    for (const text of [
      "You will fail the interview like this.",
      "Chances of being hired are low.",
      "无法被录用",
      "面试不会通过",
    ]) {
      expectGuardReject(() => assertFeedbackFieldSafe("suggestion", text));
    }
  });

  it("rejects internal schema/prompt terminology leakage", () => {
    for (const text of [
      "See problem_label taxonomy for details.",
      "This violates the prompt version rules.",
      "Check the grounding_sources entry.",
    ]) {
      expectGuardReject(() => assertFeedbackFieldSafe("suggestion", text));
    }
  });

  it("accepts observable answer-level language", () => {
    const good = [
      "The answer jumps to actions before stating the situation.",
      "Quantify the outcome with the metric you already have.",
      "The transcript omits who else was involved.",
      "先交代约束条件，再说明你的动作。",
    ];
    for (const text of good) {
      expect(() => assertFeedbackFieldSafe("suggestion", text)).not.toThrow();
    }
  });
});

describe("guardFeedbackItem", () => {
  it("rejects when any participant-visible field violates a rule", () => {
    const cases = [
      item({ problemLabel: "你缺乏沟通能力" }),
      item({ problemStatement: "候选人态度消极" }),
      item({ underlyingCause: "You lack the ability to prioritize." }),
      item({ performanceImpact: "面试不会通过" }),
      item({ suggestion: "You will fail the interview." }),
    ];
    for (const candidate of cases) {
      expectGuardReject(() => guardFeedbackItem(candidate));
    }
  });

  it("passes a fully clean diagnostic item", () => {
    expect(() => guardFeedbackItem(item({}))).not.toThrow();
  });
});
