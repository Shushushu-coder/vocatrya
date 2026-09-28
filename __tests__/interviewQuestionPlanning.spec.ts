// @vitest-environment node
/**
 * Question-planning contract: structured plan validation, prompt assembly,
 * deterministic context bounding, and model failure handling.
 */
import { describe, expect, it } from "vitest";
import {
  buildQuestionPlanningPrompt,
  generateInterviewQuestionPlan,
  truncateUtf8,
  validateQuestionPlan,
  QUESTION_PLAN_INVALID,
  type InterviewPlanningContext,
} from "@/lib/interview/services/questionPlanning";
import { DomainError } from "@/lib/interview/persistence/interviewErrors";
import type { ResolvedInterviewModel } from "@/lib/interview/hostPorts";

function plan(questions: unknown[]) {
  return { questions };
}

function validQuestions() {
  return [
    { text: "Q1?", category: "behavioral", rationale: "r1" },
    { text: "Q2?", category: "technical", rationale: "r2" },
    { text: "Q3?", category: "motivation", rationale: "r3" },
  ];
}

function expectPlanInvalid(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(QUESTION_PLAN_INVALID);
    return;
  }
  throw new Error("expected INVALID_QUESTION_PLAN");
}

describe("validateQuestionPlan", () => {
  it("accepts exactly 3 distinct non-empty questions", () => {
    const parsed = validateQuestionPlan(plan(validQuestions()));
    expect(parsed.questions).toHaveLength(3);
    expect(parsed.questions[0].text).toBe("Q1?");
    expect(parsed.questions[0].category).toBe("behavioral");
  });

  it("rejects any count other than 3", () => {
    for (const count of [0, 1, 2, 4]) {
      const questions = Array.from({ length: count }, (_, i) => ({
        text: `Q${i}?`,
      }));
      expectPlanInvalid(() => validateQuestionPlan(plan(questions)));
    }
  });

  it("rejects empty question text", () => {
    const questions = validQuestions();
    questions[1] = { text: "   ", category: "x", rationale: "r" };
    expectPlanInvalid(() => validateQuestionPlan(plan(questions)));
  });

  it("rejects duplicate questions after normalization", () => {
    const questions = validQuestions();
    questions[2] = { text: "  q1?  ", category: "x", rationale: "r" };
    expectPlanInvalid(() => validateQuestionPlan(plan(questions)));
  });
});

describe("buildQuestionPlanningPrompt", () => {
  const base: InterviewPlanningContext = {
    job: null,
    careerFacts: [],
    careerFactsTruncated: false,
  };

  it("marks the general-interview path when no job is bound", () => {
    const { prompt } = buildQuestionPlanningPrompt(base);
    expect(prompt).toContain("general job interview");
    expect(prompt).not.toContain("jd_version");
  });

  it("embeds real JD content and career facts when provided", () => {
    const { prompt } = buildQuestionPlanningPrompt({
      job: {
        jobTitle: "Product Manager",
        companyName: "ByteDance",
        jdVersionNumber: 3,
        jdContent: "Own the payments roadmap.",
        jdTruncated: false,
      },
      careerFacts: ["- [PROJECT] Billing rewrite | Acme"],
      careerFactsTruncated: false,
    });
    expect(prompt).toContain("Product Manager");
    expect(prompt).toContain("ByteDance");
    expect(prompt).toContain("jd_version: 3");
    expect(prompt).toContain("Own the payments roadmap.");
    expect(prompt).toContain("Billing rewrite");
  });
});

describe("truncateUtf8", () => {
  it("stays within the byte budget on multibyte text", () => {
    const text = "中文内容".repeat(2000);
    const out = truncateUtf8(text, 500);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(510);
    expect(out).toContain("[…]");
  });

  it("returns short text untouched", () => {
    expect(truncateUtf8("short", 100)).toBe("short");
  });
});

describe("generateInterviewQuestionPlan", () => {
  const context: InterviewPlanningContext = {
    job: null,
    careerFacts: [],
    careerFactsTruncated: false,
  };

  it("maps model errors to GENERATION_FAILED", async () => {
    const model: ResolvedInterviewModel = {
      provider: "mock",
      model: "mock",
      generateJson: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      generateInterviewQuestionPlan({ model, context }),
    ).rejects.toMatchObject({ code: "GENERATION_FAILED" });
  });

  it("propagates DomainError codes unchanged", async () => {
    const model: ResolvedInterviewModel = {
      provider: "mock",
      model: "mock",
      generateJson: async () => {
        throw new DomainError("AI_EXECUTION_TIMEOUT", "t");
      },
    };
    await expect(
      generateInterviewQuestionPlan({ model, context }),
    ).rejects.toMatchObject({ code: "AI_EXECUTION_TIMEOUT" });
  });

  it("rejects an invalid structured plan instead of creating questions", async () => {
    const model: ResolvedInterviewModel = {
      provider: "mock",
      model: "mock",
      generateJson: async () => plan([{ text: "only one" }]),
    };
    await expect(
      generateInterviewQuestionPlan({ model, context }),
    ).rejects.toMatchObject({ code: QUESTION_PLAN_INVALID });
  });
});
