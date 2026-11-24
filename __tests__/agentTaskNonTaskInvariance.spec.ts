// @vitest-environment node
/**
 * Non-task invariance (spec 16.7): for conversations without a task binding,
 * prompts, tool sets, approval policy and the rendered career-dialogue
 * context are identical to the pre-harness implementation. The golden file
 * (fixtures/agentPromptToolsNonTaskGolden.json) holds sha256 hashes and tool
 * lists produced by the pre-card-C prompt.ts / toolPermissions.ts (regenerated from
 * main 0f9c4659 when the harness was merged, so read_webpage is included).
 */
import { createHash } from "node:crypto";
import { buildAgentChatSystemPrompt } from "@/lib/agent/prompt";
import { agentToolApproval, effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import { renderCareerDialoguePrompt } from "@/lib/agent/accountTurn";
import golden from "./fixtures/agentPromptToolsNonTaskGolden.json";
import { AGENT_CHAT_TERMINAL_TOOLS } from "@/models/agent.model";
import { buildTodayPlanTool } from "@/lib/agent/tools/todayPlan";
import { buildAgentTools } from "@/lib/agent/tools";
import { NON_TASK_INVARIANCE_CASES } from "./helpers/contextBudgetInvarianceInputs";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ROLES = [null, undefined, "insight", "pilot", "reflect", "bogus"] as const;
const NOTION = [
  "notion_search",
  "notion_read",
  "notion_create_page",
  "notion_append_content",
  "notion_update_record",
  "notion_update_content",
  "notion_delete_pages",
];
const NOTION_SETS = [undefined, [], NOTION, ["notion_read"]] as const;

describe("system prompt without a task binding", () => {
  for (const role of ROLES) {
    for (const fresh of [false, true]) {
      for (const notion of NOTION_SETS) {
        for (const locale of ["zh-CN", "en"]) {
          const label = `${String(role)}|fresh=${fresh}|notion=${notion ? notion.length : "none"}|${locale}`;
          it(`matches the current non-task prompt: ${label}`, () => {
            const opts = { freshNativeFull: fresh, agentRole: role, notionTools: notion };
            const expected = (golden.prompts as Record<string, string>)[label];
            expect(sha(buildAgentChatSystemPrompt(locale, opts))).toBe(expected);
            // Absent/null task extension is the non-task path.
            expect(sha(buildAgentChatSystemPrompt(locale, { ...opts, taskExtraTools: null }))).toBe(expected);
            expect(sha(buildAgentChatSystemPrompt(locale, { ...opts, taskExtraTools: undefined }))).toBe(expected);
          });
        }
      }
    }
  }

  it("the task section appears only when a task extension is supplied (Pilot)", () => {
    const plain = buildAgentChatSystemPrompt("en", { agentRole: "pilot" });
    expect(plain).not.toContain("long-running job-search task");
    const task = buildAgentChatSystemPrompt("en", { agentRole: "pilot", taskExtraTools: ["match_job"] });
    expect(task).toContain("long-running job-search task");
    expect(task).toContain("match_job screens the job");
    // Other roles never take the section, even if asked.
    for (const role of ["insight", "reflect", null] as const) {
      expect(buildAgentChatSystemPrompt("en", { agentRole: role, taskExtraTools: ["match_job"] })).not.toContain(
        "long-running job-search task",
      );
    }
  });
});

describe("tool sets and approvals without a task binding", () => {
  for (const role of ROLES) {
    for (const fresh of [false, true]) {
      for (const notion of NOTION_SETS) {
        const key = `${String(role)}|fresh=${fresh}|notion=${notion ? notion.length : "none"}`;
        it(`effective tool names unchanged: ${key}`, () => {
          const expected = (golden.tools as Record<string, string[]>)[key];
          const base = { agentRole: role, freshNativeFull: fresh, notionTools: notion };
          expect(effectiveAgentToolNames(base)).toEqual(expected);
          expect(effectiveAgentToolNames({ ...base, taskExtraTools: null })).toEqual(expected);
          expect(effectiveAgentToolNames({ ...base, taskExtraTools: [] })).toEqual(expected);
        });
      }
    }
  }

  it("approval policy is unchanged for every tool/mode", () => {
    for (const [key, expected] of Object.entries(golden.approvals as Record<string, string>)) {
      const [name, fresh, mode] = key.split("|");
      expect(agentToolApproval(name, fresh === "true", mode as "ask" | "rules" | "full")).toBe(expected);
    }
  });
});

describe("career-dialogue prompt without a task binding", () => {
  const profiles = Object.entries(NON_TASK_INVARIANCE_CASES);
  for (const [name, input] of profiles) {
    it(`${name}: a handoff line never leaks into a non-task prompt`, () => {
      const render = (extra: { agentTaskId?: string | null; handoffLine?: string }) =>
        renderCareerDialoguePrompt({
          profile: input.profile,
          systemPrompt: "SYSTEM PROMPT",
          messages: input.messages,
          pageContext: input.pageContext,
          pastedText: undefined,
          summary: input.summary,
          agentRole: input.agentRole,
          ...extra,
        });
      const baseline = render({});
      for (const agentTaskId of [undefined, null, ""]) {
        const withLine = render({ agentTaskId, handoffLine: "Active task state (system-maintained)\nTask: x" });
        expect(withLine.prompt).toBe(baseline.prompt);
        expect(withLine.prompt).not.toContain("Active task state");
      }
      // A task id with no line also changes nothing.
      expect(render({ agentTaskId: "task-1" }).prompt).toBe(baseline.prompt);
      // And with both, the line is present (task sessions only).
      const task = render({ agentTaskId: "task-1", handoffLine: "Active task state (system-maintained)\nTask: x" });
      expect(task.prompt).toContain("Active task state");
    });
  }
});


describe("To-do tool behavior on ordinary conversations", () => {
  it.each(["insight", "pilot", "reflect"] as const)("registers working To-do gates for %s without granting other roles' writes", (agentRole) => {
    for (const freshNativeFull of [false, true]) {
      for (const permissionMode of ["ask", "rules", "full"] as const) {
        const tools = buildAgentTools({
          userId: "test-user", agentRole, freshNativeFull, permissionMode,
          model: {} as never, provider: "ollama", modelName: "fixture",
          writer: { write: () => {}, merge: () => {} } as never,
          notionTools: ["notion_create_page"],
          feishuTools: ["feishu_create_doc"],
        });
        expect(tools.today_plan_read).toBeDefined();
        expect(tools.today_plan).toBeDefined();
        const gate = tools.today_plan.needsApproval as (input: { action: string }) => boolean;
        expect(gate({ action: "suggest" })).toBe(true);
        for (const action of ["add", "rename", "complete", "uncomplete", "move", "remove"]) {
          expect(gate({ action })).toBe(false);
        }
        if (agentRole !== "pilot") {
          for (const name of ["add_job", "notion_create_page", "feishu_create_doc"]) expect(tools[name]).toBeUndefined();
        }
      }
    }
  });
  it("keeps read nonterminal so a grounded suggestion can follow", () => {
    expect([...AGENT_CHAT_TERMINAL_TOOLS]).not.toContain("today_plan_read");
    expect([...AGENT_CHAT_TERMINAL_TOOLS]).toContain("today_plan");
  });
  it("keeps suggestions gated and explicit adds ungated in every permission mode", async () => {
    for (const mode of ["ask", "rules", "full"] as const) {
      expect(agentToolApproval("today_plan", true, mode)).toBe("conditional");
      const gate = buildTodayPlanTool("test-user").needsApproval as (input: { action: string }) => boolean;
      expect(gate({ action: "suggest" })).toBe(true);
      expect(gate({ action: "add" })).toBe(false);
    }
  });
  it("grants conversation-scoped writes to every named role and preserves the grounding prompt", () => {
    for (const role of ["pilot", "insight", "reflect"] as const) {
      const tools = effectiveAgentToolNames({ agentRole: role });
      expect(tools).toContain("today_plan_read");
      expect(tools).toContain("today_plan");
      const prompt = buildAgentChatSystemPrompt("en", { agentRole: role });
      expect(prompt).toContain("today_plan_read");
      expect(prompt).toContain("suggest");
      expect(prompt).toContain("today_plan changes it");
      expect(prompt).not.toContain("checklist changes belong to Voca Pilot");
      expect(prompt).not.toContain("you cannot change it");
    }
  });
});
