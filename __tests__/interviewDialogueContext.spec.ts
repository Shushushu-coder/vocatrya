// @vitest-environment node
/**
 * Bounded dialogue-history selection and coaching prompt assembly.
 * The current user message, target feedback, question and answer are
 * mandatory; history is dropped oldest-first, never mid-pair.
 */
import { describe, expect, it } from "vitest";
import {
  buildCoachingPrompt,
  estimateDialogueTokens,
  selectDialogueHistory,
  DIALOGUE_HISTORY_TOKEN_BUDGET,
  DIALOGUE_MAX_HISTORY_PAIRS,
} from "@/lib/interview/services/dialogueContext";
import type { DialogueTurnRecord } from "@/lib/interview/persistence/interviewRecords";

function turn(n: number, userText: string, assistantReply: string) {
  return {
    turnNumber: n,
    userText,
    assistantReply,
    targetType: "SESSION",
  } as DialogueTurnRecord;
}

describe("selectDialogueHistory", () => {
  it("keeps the most recent complete pairs up to the cap", () => {
    const turns = Array.from({ length: 9 }, (_, i) =>
      turn(i + 1, `u${i + 1}`, `a${i + 1}`),
    );
    const selected = selectDialogueHistory(turns);
    expect(selected).toHaveLength(DIALOGUE_MAX_HISTORY_PAIRS);
    expect(selected[0].turnNumber).toBe(4);
    expect(selected[selected.length - 1].turnNumber).toBe(9);
  });

  it("drops incomplete turns (empty reply or text)", () => {
    const turns = [
      turn(1, "u1", "a1"),
      turn(2, "u2", ""),
      turn(3, "", "a3"),
      turn(4, "u4", "a4"),
    ];
    const selected = selectDialogueHistory(turns);
    expect(selected.map((pair) => pair.turnNumber)).toEqual([1, 4]);
  });

  it("drops the oldest pairs first when over the token budget", () => {
    const big = "x".repeat(DIALOGUE_HISTORY_TOKEN_BUDGET * 2 * 2);
    const turns = [
      turn(1, big, big),
      turn(2, "u2", "a2"),
      turn(3, "u3", "a3"),
    ];
    const selected = selectDialogueHistory(turns);
    expect(selected[0].turnNumber).not.toBe(1);
    expect(selected[selected.length - 1].turnNumber).toBe(3);
    const tokens = selected.reduce(
      (sum, pair) =>
        sum +
        estimateDialogueTokens(pair.userText) +
        estimateDialogueTokens(pair.assistantReply),
      0,
    );
    expect(tokens).toBeLessThanOrEqual(DIALOGUE_HISTORY_TOKEN_BUDGET);
  });
});

describe("buildCoachingPrompt", () => {
  it("assembles all mandatory sections for a FEEDBACK_ITEM target", () => {
    const { system, prompt } = buildCoachingPrompt({
      targetType: "FEEDBACK_ITEM",
      job: {
        jobTitle: "Backend Engineer",
        companyName: "Acme",
        jdExcerpt: "Own billing reliability.",
      },
      questionText: "Tell me about a launch.",
      answerTranscript: "I led the launch under a freeze.",
      feedbackItem: {
        problemLabel: "Missing Situation Context",
        problemStatement: "Situation missing",
        evidenceExcerpt: "I led the launch",
        underlyingCause: "Jumped to action",
        performanceImpact: "Hard to judge scope",
        suggestion: "Add the team and constraint first.",
      },
      relatedFeedback: [
        { problemLabel: "Thin result", suggestion: "Add the metric." },
      ],
      history: [
        { turnNumber: 1, userText: "u1", assistantReply: "a1", targetType: "SESSION" },
      ],
      userText: "Why is this a problem?",
    });
    expect(prompt).toContain("COACHING_TURN");
    expect(prompt).toContain("## SESSION CONTEXT");
    expect(prompt).toContain("Backend Engineer");
    expect(prompt).toContain("## INTERVIEW CONTENT");
    expect(prompt).toContain("Tell me about a launch.");
    expect(prompt).toContain("I led the launch under a freeze.");
    expect(prompt).toContain("## FEEDBACK TARGET");
    expect(prompt).toContain("Missing Situation Context");
    expect(prompt).toContain("Situation missing");
    expect(prompt).toContain("Add the team and constraint first.");
    expect(prompt).toContain("## OTHER FEEDBACK ON THIS ANSWER");
    expect(prompt).toContain("Thin result");
    expect(prompt).toContain("## DIALOGUE HISTORY");
    expect(prompt).toContain("u1");
    expect(prompt).toContain("## CURRENT USER MESSAGE");
    expect(prompt).toContain("Why is this a problem?");
    expect(system).toContain("commercial_coaching_v2");
    // Safety boundaries live in the system section.
    expect(system).toContain("Never predict hiring outcomes");
    expect(system).toContain("untrusted data");
  });

  it("keeps the user message mandatory even with empty context", () => {
    const { prompt } = buildCoachingPrompt({
      targetType: "SESSION",
      history: [],
      userText: "Any general advice?",
    });
    expect(prompt).toContain("(none)");
    expect(prompt).toContain("Any general advice?");
  });
});
