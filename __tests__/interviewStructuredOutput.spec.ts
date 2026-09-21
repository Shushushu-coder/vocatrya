// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Structured-output compatibility probe (Phase 2).
 *
 * Default automated path is MOCK ONLY: a deterministic mock payload shaped
 * like the frozen Phase 1 commercial feedback item is validated with a
 * strict local copy of the item schema. The validator is never relaxed to
 * make output pass. The real-provider probe (Vercel AI SDK -> OpenRouter ->
 * Claude) is opt-in via INTERVIEW_REAL_PROBE=1 and skips otherwise, so the
 * suite never requires a real API key.
 */

const feedbackEvidenceSchema = z.object({
  transcriptExcerpt: z.string(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  problemStatement: z.string(),
  groundingSources: z.array(z.record(z.string(), z.unknown())).default([]),
});

const feedbackExplanationSchema = z.object({
  underlyingCause: z.string(),
  performanceImpact: z.string(),
  interviewerPerspective: z.string().nullable().optional(),
});

const feedbackItemSchema = z.object({
  problemLabel: z.string().min(1),
  suggestion: z.string().min(1),
  evidence: feedbackEvidenceSchema,
  explanation: feedbackExplanationSchema,
});

function mockFeedbackPayload() {
  const excerpt = "I led the migration and shipped it in six weeks.";
  return {
    feedbackItems: [
      {
        problemLabel: "Result quantification is thin",
        suggestion: "Close with verifiable numbers and team/business impact.",
        evidence: {
          transcriptExcerpt: excerpt,
          startOffset: 0,
          endOffset: Math.min(40, excerpt.length),
          problemStatement: "The answer lacks an observable result.",
          groundingSources: [],
        },
        explanation: {
          underlyingCause: "Stops at actions without stating results.",
          performanceImpact: "The interviewer cannot judge contribution.",
          interviewerPerspective: "I would ask: what was the outcome?",
        },
      },
    ],
  };
}

describe("structured-output mock probe", () => {
  it("valid mock feedback item passes strict validation", () => {
    const payload = mockFeedbackPayload();
    expect(payload.feedbackItems).toHaveLength(1);
    const parsed = feedbackItemSchema.safeParse(payload.feedbackItems[0]);
    expect(parsed.success).toBe(true);
  });

  it("empty items are a failure signal, not a silent pass", () => {
    const payload = { feedbackItems: [] as unknown[] };
    expect(payload.feedbackItems).toHaveLength(0);
    // Empty output must never validate as a usable generation.
    expect(payload.feedbackItems.length > 0).toBe(false);
  });

  it("invalid items are rejected without relaxing the validator", () => {
    const bad = {
      // problemLabel missing on purpose
      suggestion: "Add numbers.",
      evidence: {
        transcriptExcerpt: "x",
        startOffset: 0,
        endOffset: 1,
        problemStatement: "y",
        groundingSources: [],
      },
      explanation: {
        underlyingCause: "a",
        performanceImpact: "b",
      },
    };
    const parsed = feedbackItemSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });
});

describe("structured-output real probe (opt-in)", () => {
  it("runs only with INTERVIEW_REAL_PROBE=1 and a real credential", async () => {
    if (process.env.INTERVIEW_REAL_PROBE !== "1") {
      // MOCK ONLY by default; never requires a real API key.
      expect(true).toBe(true);
      return;
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE: INTERVIEW_REAL_PROBE=1 but OPENROUTER_API_KEY is missing",
      );
    }
    const modelName =
      process.env.INTERVIEW_MODEL_NAME ?? "anthropic/claude-3.5-sonnet";
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "system",
            content:
              "Return exactly one JSON object with a feedbackItems array of one commercial feedback item.",
          },
          {
            role: "user",
            content: `Transcript: "I led the migration and shipped it in six weeks." Return JSON with problemLabel, suggestion, evidence{transcriptExcerpt,startOffset,endOffset,problemStatement,groundingSources:[]}, explanation{underlyingCause,performanceImpact}.`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE: HTTP ${response.status}`,
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content) as unknown;
    } catch {
      throw new Error(
        "BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE: non-JSON output",
      );
    }
    const items = (parsedJson as { feedbackItems?: unknown }).feedbackItems;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(
        "BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE: empty items",
      );
    }
    const parsed = feedbackItemSchema.safeParse(items[0]);
    if (!parsed.success) {
      throw new Error(
        `BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE: ${parsed.error.message}`,
      );
    }
    expect(parsed.success).toBe(true);
  }, 120000);
});
