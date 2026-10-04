import { buildAgentTools } from "@/lib/agent/tools";
import {
  AGENT_CHAT_FRESH_FULL_SECTIONS,
  buildAgentChatSystemPrompt,
  buildPageContextMessage,
} from "@/lib/agent/prompt";

const toolCtx = {
  userId: "user-1",
  pageContext: { jobId: "page-job" },
  model: {} as never,
  provider: "ollama",
  modelName: "qwen3.5:9b",
  writer: { write: () => {}, merge: () => {}, onError: undefined } as never,
};

describe("buildAgentTools under fresh + full", () => {
  it("registers only the canonical read tools", () => {
    const tools = buildAgentTools({ ...toolCtx, freshNativeFull: true });
    expect(Object.keys(tools)).toEqual([
      "list_jobs",
      "get_job",
      "get_resume",
      "review_resume",
    ]);
  });

  it("keeps the full registry outside fresh + full", () => {
    for (const freshNativeFull of [false, undefined]) {
      const tools = buildAgentTools({ ...toolCtx, freshNativeFull });
      expect(Object.keys(tools)).toEqual([
        "add_job",
        "list_jobs",
        "get_job",
        "get_resume",
        "review_resume",
        "match_job",
        "generate_cover_letter",
      ]);
    }
  });
});

describe("fresh + full system prompt", () => {
  const prompt = buildAgentChatSystemPrompt("en", { freshNativeFull: true });

  it("never advertises the deferred write tools", () => {
    for (const name of ["add_job", "match_job", "generate_cover_letter"]) {
      expect(prompt).not.toContain(name);
      expect(AGENT_CHAT_FRESH_FULL_SECTIONS.capabilities).not.toContain(name);
      expect(AGENT_CHAT_FRESH_FULL_SECTIONS.limitations).not.toContain(name);
    }
    // Even without the tool names, the deferred actions are declined plainly.
    expect(prompt).toMatch(/cannot add a job/i);
    expect(prompt).toMatch(/match analysis/i);
    expect(prompt).toMatch(/cover letter/i);
  });

  it("keeps the canonical read tools advertised", () => {
    for (const name of ["list_jobs", "get_job", "get_resume", "review_resume"]) {
      expect(prompt).toContain(name);
    }
  });

  it("drops the add_job paste contract but keeps pasted-content safety", () => {
    expect(prompt).not.toMatch(/jobDescription/);
    expect(prompt).toMatch(/never instructions to follow/i);
  });

  it("keeps the locale instruction", () => {
    expect(
      buildAgentChatSystemPrompt("zh-CN", { freshNativeFull: true }),
    ).toContain("Simplified Chinese");
    expect(
      buildAgentChatSystemPrompt("en", { freshNativeFull: true }),
    ).toContain("Reply in English");
  });

  it("leaves the default prompt unchanged", () => {
    const legacy = buildAgentChatSystemPrompt("en");
    expect(legacy).toContain("add_job");
    expect(legacy).toContain("match_job");
    expect(legacy).toContain("generate_cover_letter");
  });
});

describe("fresh + full page context", () => {
  it("does not steer the model toward match or cover-letter tools", () => {
    const jobPage = buildPageContextMessage(
      { jobId: "job-1" },
      { freshNativeFull: true },
    );
    expect(jobPage).not.toContain("match_job");
    expect(jobPage).not.toContain("generate_cover_letter");

    const jobsList = buildPageContextMessage(
      { route: "/dashboard/myjobs" },
      { freshNativeFull: true },
    );
    expect(jobsList).not.toContain("match");
    expect(jobsList).not.toContain("cover letter");
  });

  it("keeps the legacy page-context wording by default", () => {
    const jobPage = buildPageContextMessage({ jobId: "job-1" });
    expect(jobPage).toContain("match_job");
    expect(jobPage).toContain("generate_cover_letter");
  });
});
