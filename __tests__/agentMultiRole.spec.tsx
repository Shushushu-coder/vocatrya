import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildAgentTools } from "@/lib/agent/tools";
import {
  AGENT_ROLE_TOOL_ALLOWLIST,
  AGENT_ROLES,
  normalizeAgentRole,
  slotRoleFor,
} from "@/lib/agent/agentRoles";
import {
  buildAgentChatSystemPrompt,
  buildPageContextMessage,
} from "@/lib/agent/prompt";
import { suggestionsForRole } from "@/lib/agent/roleSuggestions";
import { copyFor } from "@/lib/agent/roleCopy";
import { NOTION_ALL_TOOL_NAMES } from "@/lib/extensions/notion/constants";
import { FEISHU_ALL_TOOL_NAMES } from "@/lib/extensions/feishu/constants";

const toolCtx = {
  userId: "user-1",
  pageContext: { jobId: "page-job" },
  model: {} as never,
  provider: "ollama",
  modelName: "qwen3.5:9b",
  writer: { write: () => {}, merge: () => {}, onError: undefined } as never,
};

// A fully-connected Notion + Feishu session: the route resolves these names into
// ctx.notionTools / ctx.feishuTools before build.
const NOTION_NAMES = [...NOTION_ALL_TOOL_NAMES];
const FEISHU_NAMES = [...FEISHU_ALL_TOOL_NAMES];

// The contract's effective set: role allowlist ∩ registered runtime tools.
// Allowlists only ever shrink the registry, never grow it.
describe("per-role tool allowlists", () => {
  it.each(Object.keys(AGENT_ROLE_TOOL_ALLOWLIST) as Array<"insight" | "pilot" | "reflect">)(
    "registers exactly the %s allowlist under the legacy runtime",
    (role) => {
      const tools = buildAgentTools({
        ...toolCtx,
        agentRole: role,
        notionTools: NOTION_NAMES,
        feishuTools: FEISHU_NAMES,
      });
      expect(Object.keys(tools).sort()).toEqual(
        [...AGENT_ROLE_TOOL_ALLOWLIST[role]].sort(),
      );
    },
  );

  it("keeps Insight's match_job on the canonical approval-gated variant under fresh + full", () => {
    const tools = buildAgentTools({
      ...toolCtx,
      freshNativeFull: true,
      agentRole: "insight",
      notionTools: NOTION_NAMES,
      feishuTools: FEISHU_NAMES,
    });
    expect(tools.match_job.needsApproval).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(
      [...AGENT_ROLE_TOOL_ALLOWLIST.insight].sort(),
    );
  });

  it("never exposes generate_cover_letter to any role", () => {
    for (const role of AGENT_ROLES) {
      expect(
        Object.keys(buildAgentTools({ ...toolCtx, agentRole: role })),
      ).not.toContain("generate_cover_letter");
    }
  });

  it("keeps the general registry for NULL and unknown roles", () => {
    for (const agentRole of [null, undefined, "future-role"]) {
      const tools = buildAgentTools({ ...toolCtx, agentRole });
      expect(Object.keys(tools)).toContain("generate_cover_letter");
      expect(Object.keys(tools)).toHaveLength(10);
    }
  });

  it("gives Pilot read-only get_resume (D02) while withholding review_resume and match_job", () => {
    const tools = buildAgentTools({ ...toolCtx, agentRole: "pilot" });
    expect(tools.get_resume).toBeDefined();
    expect(tools.review_resume).toBeUndefined();
    expect(tools.match_job).toBeUndefined();
  });
});

describe("per-role system prompts", () => {
  const prompts = {
    insight: buildAgentChatSystemPrompt("en", { agentRole: "insight" }),
    pilot: buildAgentChatSystemPrompt("en", { agentRole: "pilot" }),
    reflect: buildAgentChatSystemPrompt("en", { agentRole: "reflect" }),
    general: buildAgentChatSystemPrompt("en"),
    unknown: buildAgentChatSystemPrompt("en", { agentRole: "future-role" }),
  };

  it("names each role's persona", () => {
    expect(prompts.insight).toContain("Voca Insight");
    expect(prompts.pilot).toContain("Voca Pilot");
    expect(prompts.reflect).toContain("Voca Reflect");
  });

  it("keeps Insight away from adding jobs", () => {
    expect(prompts.insight).not.toContain("add_job creates");
    expect(prompts.insight).toContain("cannot add");
    for (const name of ["get_resume", "review_resume", "match_job"]) {
      expect(prompts.insight).toContain(name);
    }
  });

  it("keeps Pilot honest about having no resume or match access", () => {
    expect(prompts.pilot).toContain("add_job");
    expect(prompts.pilot).not.toContain("get_resume reads");
    expect(prompts.pilot).not.toContain("match_job scores");
    expect(prompts.pilot).toContain("cannot read, review or analyze resumes");
    // B: boundary honesty answers first — the old "cannot see that data"
    // refusal phrasing must not come back.
    expect(prompts.pilot).not.toContain("cannot see that data yet");
    expect(prompts.pilot).toContain("answer the part your job tools can cover");
  });

  // Reflect promises dialogue only — no saved-record reads it could fake.
  it("keeps Reflect honest about its limits", () => {
    expect(prompts.reflect).toContain("Voca Reflect");
    expect(prompts.reflect).toContain("no access to saved reflection");
    expect(prompts.reflect).not.toContain("review_resume produces");
    expect(prompts.reflect).not.toContain("add_job");
  });

  it("leaves the general prompt byte-identical for NULL and unknown roles", () => {
    expect(prompts.unknown).toBe(prompts.general);
    expect(buildAgentChatSystemPrompt("en", { agentRole: null })).toBe(
      prompts.general,
    );
  });
});

describe("per-role page context lines", () => {
  it("steers Insight toward match on a job page and never toward add_job", () => {
    const line = buildPageContextMessage(
      { jobId: "job-1" },
      { agentRole: "insight" },
    );
    expect(line).toContain("match_job");
    expect(line).not.toContain("add_job");
    expect(line).not.toContain("generate_cover_letter");
  });

  it("steers Pilot toward add_job and never toward match", () => {
    const line = buildPageContextMessage(
      { jobId: "job-1" },
      { agentRole: "pilot" },
    );
    expect(line).toContain("add_job");
    expect(line).not.toContain("match_job");
  });

  it("steers Reflect only toward reading the open job", () => {
    const line = buildPageContextMessage(
      { jobId: "job-1" },
      { agentRole: "reflect" },
    );
    expect(line).toContain("get_job");
    expect(line).not.toContain("add_job");
    expect(line).not.toContain("match_job");
  });
});

describe("role suggestions", () => {
  it("returns four static items for every role", () => {
    for (const role of AGENT_ROLES) {
      expect(suggestionsForRole(role)).toHaveLength(4);
    }
  });

  // D5: the canonical runtime shows 运行匹配分析; the legacy runtime keeps
  // the older free-running wording so the label matches what the tool does.
  it("swaps the Insight match wording by runtime", () => {
    const copy = copyFor((k) => k, "en");
    expect(
      copy(
        suggestionsForRole("insight", { freshNativeFull: true })[0].label,
      ),
    ).toBe("Run match analysis");
    expect(copy(suggestionsForRole("insight")[0].label)).toBe(
      "Check my match for this job",
    );
  });

  it("fills the add-job suggestion with an open-ended prompt, not a canned exchange", () => {
    const [add] = suggestionsForRole("pilot");
    expect(add.fill).toBe("agent.suggest.pilot.addFill");
  });
});

describe("role normalization", () => {
  it("slots NULL and unknown roles under Pilot, keeps real roles", () => {
    expect(normalizeAgentRole("insight")).toBe("insight");
    expect(normalizeAgentRole("anything-else")).toBeNull();
    expect(slotRoleFor(null)).toBe("pilot");
    expect(slotRoleFor("reflect")).toBe("reflect");
  });
});

// ---------------------------------------------------------------------------
// Role switcher (D7)
// ---------------------------------------------------------------------------

let activeRole: "insight" | "pilot" | "reflect" = "pilot";
const switchRole = vi.fn(async () => {});
const selectConversation = vi.fn(async () => true);
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    activeRole,
    switchRole,
    conversationId: null,
    selectConversation,
    archiveConversation: vi.fn(),
    removeConversation: vi.fn(),
    historyVersion: 0,
  }),
}));

let historyRows: Array<Record<string, unknown>> = [];
vi.mock("@/actions/agentChat.actions", () => ({
  listChatConversations: vi.fn(async () => ({
    success: true,
    data: historyRows,
  })),
}));

import { AgentRoleSwitcher } from "@/components/agent/AgentRoleSwitcher";
import { AgentChatHistory } from "@/components/agent/AgentChatHistory";

describe("AgentRoleSwitcher", () => {
  beforeEach(() => {
    activeRole = "pilot";
    switchRole.mockClear();
  });

  it("renders the fixed Insight → Pilot → Reflect order, reachable, with aria-current", () => {
    render(<AgentRoleSwitcher />);
    const group = screen.getByTestId("agent-role-switcher");
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("data-role"))).toEqual([
      "insight",
      "pilot",
      "reflect",
    ]);
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
  });

  it("switches roles on click", async () => {
    render(<AgentRoleSwitcher />);
    await userEvent.click(
      within(screen.getByTestId("agent-role-switcher")).getAllByRole("button")[2],
    );
    expect(switchRole).toHaveBeenCalledWith("reflect");
  });

  // D7: the group is icons-only at every width; the accessible name stays.
  it("keeps full role names on the accessible labels", () => {
    render(<AgentRoleSwitcher />);
    const buttons = within(screen.getByTestId("agent-role-switcher")).getAllByRole("button");
    expect(buttons[1].textContent).not.toContain("Voca Pilot");
    expect(buttons[1]).toHaveAttribute("aria-label", "Voca Pilot");
  });
});

// D3: one unified history list, role badge per row; NULL (pre-multi-agent
// rows) reads as the general assistant, never a raw key.
describe("AgentChatHistory role badges", () => {
  beforeEach(() => {
    const now = new Date().toISOString();
    historyRows = [
      { id: "c-ins", title: "分析对话", updatedAt: now, agentRole: "insight" },
      { id: "c-pil", title: "工作台对话", updatedAt: now, agentRole: "pilot" },
      { id: "c-ref", title: "复盘对话", updatedAt: now, agentRole: "reflect" },
      { id: "c-old", title: "旧版对话", updatedAt: now, agentRole: null },
    ];
  });

  it("badges each row with its role and NULL rows as General", async () => {
    render(<AgentChatHistory onClose={() => {}} />);
    expect(await screen.findByText("分析对话")).toBeInTheDocument();
    for (const label of ["Voca Insight", "Voca Pilot", "Voca Reflect"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const legacy = screen.getByText("旧版对话").closest("li")!;
    expect(within(legacy).getByText("General")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("agent.role.");
  });
});
