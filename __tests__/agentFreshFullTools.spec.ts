import { buildAgentTools } from "@/lib/agent/tools";
import {
  AGENT_CHAT_FRESH_FULL_SECTIONS,
  AGENT_TOOL_DESCRIPTIONS,
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
  it("registers canonical reads, add_job and canonical match_job; hides cover letter", () => {
    const tools = buildAgentTools({ ...toolCtx, freshNativeFull: true });
    expect(Object.keys(tools)).toEqual([
      "add_job",
      "list_jobs",
      "get_job",
      "read_webpage",
      "get_resume",
      "review_resume",
      "match_job",
      "today_plan_read",
      "today_plan",

    ]);
    // Canonical match_job always requires approval — the product decision
    // D3: every run crosses the durable approval boundary.
    expect(tools.match_job.needsApproval).toBe(true);
    expect(tools.match_job.description).toBe(
      AGENT_TOOL_DESCRIPTIONS.match_job_canonical,
    );
  });

  it("keeps canonical match_job approval-gated in rules and full modes", () => {
    // Regression for CORE-1: de-gating the canonical variant in a non-ask
    // mode let the send turn execute it directly, where the approval-bound
    // guard rejected the call as CONVERSATION_TURN_CONFLICT.
    for (const permissionMode of ["rules", "full", "ask"] as const) {
      const tools = buildAgentTools({
        ...toolCtx,
        freshNativeFull: true,
        permissionMode,
      });
      expect(tools.match_job.needsApproval).toBe(true);
    }
  });

  it("still de-gates only the legacy variants in rules and full modes", () => {
    for (const permissionMode of ["rules", "full"] as const) {
      const tools = buildAgentTools({
        ...toolCtx,
        freshNativeFull: false,
        permissionMode,
      });
      expect(tools.match_job.needsApproval).toBe(false);
      expect(tools.add_job.needsApproval).toBe(false);
    }
  });

  it("keeps add_job canonical for migrated full without hiding match or cover letter", () => {
    const tools = buildAgentTools({
      ...toolCtx,
      freshNativeFull: false,
      canonicalJobs: true,
    });
    expect(Object.keys(tools)).toEqual([
      "add_job",
      "list_jobs",
      "get_job",
      "read_webpage",
      "get_resume",
      "review_resume",
      "match_job",
      "generate_cover_letter",
      "today_plan_read",
      "today_plan",

    ]);
    const needsApproval = tools.add_job.needsApproval;
    expect(typeof needsApproval).toBe("function");
    if (typeof needsApproval !== "function") {
      throw new Error("canonical add_job must gate on approval");
    }
    expect(
      needsApproval(
        { company: "腾讯", jobTitle: "后端开发实习" },
        { toolCallId: "c", messages: [] } as never,
      ),
    ).toBe(true);
  });

  it("keeps the full registry outside fresh + full", () => {
    for (const freshNativeFull of [false, undefined]) {
      const tools = buildAgentTools({ ...toolCtx, freshNativeFull });
      expect(Object.keys(tools)).toEqual([
        "add_job",
        "list_jobs",
        "get_job",
        "read_webpage",
        "get_resume",
        "review_resume",
        "match_job",
        "generate_cover_letter",
        "today_plan_read",
        "today_plan",

      ]);
    }
  });
});

describe("fresh + full system prompt", () => {
  const prompt = buildAgentChatSystemPrompt("en", { freshNativeFull: true });

  it("advertises add_job and canonical match_job, still declines cover letter", () => {
    expect(prompt).toContain("add_job");
    expect(AGENT_CHAT_FRESH_FULL_SECTIONS.capabilities).toContain("add_job");
    expect(prompt).toContain("match_job");
    expect(AGENT_CHAT_FRESH_FULL_SECTIONS.capabilities).toContain("match_job");
    for (const name of ["generate_cover_letter"]) {
      expect(prompt).not.toContain(name);
      expect(AGENT_CHAT_FRESH_FULL_SECTIONS.capabilities).not.toContain(name);
      expect(AGENT_CHAT_FRESH_FULL_SECTIONS.limitations).not.toContain(name);
    }
    expect(prompt).not.toMatch(/cannot add a job/i);
    expect(prompt).toMatch(/match analysis/i);
    expect(prompt).toMatch(/cover letter/i);
    expect(prompt).toMatch(/does not submit an application/i);
    expect(prompt).toContain("today_plan_read");
    expect(prompt).toContain("today_plan");
  });

  it("keeps the canonical read tools advertised", () => {
    for (const name of ["list_jobs", "get_job", "get_resume", "review_resume"]) {
      expect(prompt).toContain(name);
    }
  });

  it("keeps an optional verbatim description rule and pasted-content safety", () => {
    expect(prompt).not.toMatch(/there is no case where you leave it out/i);
    expect(prompt).toMatch(/omit jobDescription/i);
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
  it("steers a job page toward match_job but never toward cover letter", () => {
    const jobPage = buildPageContextMessage(
      { jobId: "job-1" },
      { freshNativeFull: true },
    );
    expect(jobPage).toContain("match_job");
    expect(jobPage).not.toContain("generate_cover_letter");

    const jobsList = buildPageContextMessage(
      { route: "/dashboard/myjobs" },
      { freshNativeFull: true },
    );
    expect(jobsList).toContain("add_job");
    expect(jobsList).toContain("open the job they mean");
    expect(jobsList).not.toContain("cover letter");
  });

  it("keeps the legacy page-context wording by default", () => {
    const jobPage = buildPageContextMessage({ jobId: "job-1" });
    expect(jobPage).toContain("match_job");
    expect(jobPage).toContain("generate_cover_letter");
  });
});
