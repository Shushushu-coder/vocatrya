import { describe, expect, it } from "vitest";
import { resolveTranscriptEvidence } from "@/lib/interview/services/evidence";

describe("transcript evidence grounding", () => {
  const transcript = "I led the launch of a billing rewrite under a two-week freeze.";

  it("resolves a unique excerpt to the authoritative slice", () => {
    const grounded = resolveTranscriptEvidence(transcript, "I led the launch");
    expect(grounded.transcriptExcerpt).toBe("I led the launch");
    expect(transcript.slice(grounded.startOffset, grounded.endOffset)).toBe(
      grounded.transcriptExcerpt,
    );
  });

  it("fails closed on missing, empty, or ambiguous excerpts", () => {
    expect(() => resolveTranscriptEvidence(transcript, "")).toThrowError(
      /cannot be empty/,
    );
    expect(() => resolveTranscriptEvidence(transcript, "not present")).toThrowError(
      /could not be located/,
    );
    expect(() =>
      resolveTranscriptEvidence("alpha alpha", "alpha"),
    ).toThrowError(/ambiguous/);
  });
});
