import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_BASE_VERSION,
  loadInterviewKnowledgeBase,
  knowledgePromptExcerpt,
} from "@/lib/interview/knowledge/loader";

describe("interview knowledge loader", () => {
  it("loads bundled versioned assets with a stable content hash", () => {
    const kb = loadInterviewKnowledgeBase();
    expect(kb.version).toBe(KNOWLEDGE_BASE_VERSION);
    expect(kb.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(kb.taxonomy.entries.length).toBeGreaterThan(0);
    expect(knowledgePromptExcerpt()).toContain(kb.version);
    const again = loadInterviewKnowledgeBase();
    expect(again.contentHash).toBe(kb.contentHash);
  });
});
