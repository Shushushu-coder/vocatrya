import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JourneySection from "@/components/dashboard/JourneySection";
import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";
import {
  AGENT_ROLE_TOOL_ALLOWLIST,
  AGENT_ROLES,
} from "@/lib/agent/agentRoles";
import {
  buildAgentChatSystemPrompt,
  buildNotionPromptSection,
} from "@/lib/agent/prompt";
import {
  AGENT_ROSTER,
  copyFor,
  rosterDuty,
  rosterFallback,
  rosterSiblings,
} from "@/lib/agent/roleCopy";

const open = vi.hoisted(() => vi.fn());

vi.mock("@/components/agent/empty-state-motion", () => ({
  mountEmptyStateMotion: () => ({ dispose: vi.fn(), setState: vi.fn() }),
}));

const NOTION_ALL = [
  "notion_search",
  "notion_read",
  "notion_create_page",
  "notion_append_content",
  "notion_update_record",
  "notion_update_content",
  "notion_delete_pages",
] as const;

const READ_ONLY = "Your Notion access in this session is read-only";

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    open,
    fillComposer: vi.fn(),
    sendMessage: vi.fn(),
    activeRole: "insight" as const,
    context: { version: 1, items: [] },
    requestAddContext: vi.fn(),
  }),
}));

vi.mock("@/context/CareerSurfacesContext", () => ({
  useCareerSurfaces: () => ({
    freshNativeFull: false,
    jobMutationsEnabled: true,
    resumeV1Enabled: true,
  }),
}));

describe("roster single source", () => {
  const copy = copyFor((key) => key, "en");

  it("feeds the same duty string to the prompt and the homepage line", () => {
    for (const role of AGENT_ROLES) {
      const duty = rosterDuty(role, "en");
      expect(copy(AGENT_ROSTER[role].dutyKey)).toBe(duty);
      const prompt = buildAgentChatSystemPrompt("en", {
        agentRole: rosterSiblings(role)[0],
      });
      expect(prompt).toContain(duty);
      expect(prompt).toContain(AGENT_ROSTER[role].icon);
    }
  });

  it("keeps extension names out of the static roster strings", () => {
    for (const role of AGENT_ROLES) {
      const entry = AGENT_ROSTER[role];
      for (const key of [entry.dutyKey, entry.selfLeadKey, entry.selfHandoffKey]) {
        expect(copy(key)).not.toMatch(/notion/i);
        expect(rosterFallback(key, "zh-CN")).not.toMatch(/notion/i);
      }
    }
  });
});

describe("refusal prompts follow the registered tool set", () => {
  const writes = [
    "notion_create_page",
    "notion_append_content",
    "notion_update_record",
    "notion_update_content",
    "notion_delete_pages",
  ];

  it("points a read-only Insight session at Pilot and does not grant writes", () => {
    const prompt = buildAgentChatSystemPrompt("zh-CN", {
      agentRole: "insight",
      notionTools: NOTION_ALL,
    });
    expect(prompt).toContain(READ_ONLY);
    expect(prompt).toContain("Voca Pilot");
    expect(prompt).toContain("compass icon");
    expect(prompt).toContain("Do not say Notion is disconnected");
    expect(prompt).not.toContain("notion_create_page creates");
    expect(prompt).not.toContain("not connected");
    expect(prompt).toContain("telescope icon");
    expect(prompt).toContain(rosterDuty("pilot", "en"));
    expect(prompt).toContain(rosterDuty("reflect", "en"));
    expect(prompt).not.toContain(rosterDuty("insight", "en"));
  });

  it("describes Pilot writes and omits the read-only handoff", () => {
    const prompt = buildAgentChatSystemPrompt("en", {
      agentRole: "pilot",
      notionTools: NOTION_ALL,
    });
    expect(prompt).toContain("notion_create_page creates a page");
    expect(prompt).toContain("notion_append_content appends");
    expect(prompt).toContain("notion_update_record changes");
    expect(prompt).toContain("notion_update_content edits text already on a page");
    expect(prompt).toContain("no confirmation card");
    expect(prompt).toContain("notion_delete_pages moves every page");
    expect(prompt).toContain("never split a batch");
    expect(prompt).not.toContain(READ_ONLY);
    expect(prompt).toContain(rosterDuty("insight", "en"));
    expect(prompt).toContain("telescope icon");
    expect(prompt).not.toContain("match_job scores");
  });

  it("keeps Reflect To-do writes local and sends other writes to Pilot and analysis to Insight", () => {
    const prompt = buildAgentChatSystemPrompt("en", {
      agentRole: "reflect",
      notionTools: ["notion_search", "notion_read"],
    });
    expect(prompt).toContain(READ_ONLY);
    expect(prompt).toContain("Job writes and connected-extension writes belong to Voca Pilot");
    expect(prompt).toContain("today_plan changes it");
    expect(prompt).toContain("belong to Voca Insight");
    expect(prompt).toContain("compass icon");
    expect(prompt).toContain("telescope icon");
    expect(prompt).not.toContain("add_job");
    expect(prompt).not.toContain("notion_create_page creates");
  });

  it("does not invent a Notion section when nothing is registered", () => {
    for (const role of ["insight", "pilot", "reflect"] as const) {
      const prompt = buildAgentChatSystemPrompt("en", {
        agentRole: role,
        notionTools: [],
      });
      expect(prompt).not.toContain("Notion");
      expect(prompt).not.toContain("disconnected");
    }
  });

  it("names only the write tool that was actually registered", () => {
    const section = buildNotionPromptSection(["notion_create_page"], {
      agentRole: "pilot",
    });
    expect(section).toContain("notion_create_page creates a page");
    expect(section).not.toContain("notion_append_content");
    expect(section).not.toContain("notion_update_record");
    expect(section).not.toContain("notion_update_content");
    expect(section).not.toContain("notion_delete_pages");
    expect(section).not.toContain(READ_ONLY);
  });

  it("keeps a read-only Pilot session from claiming writes or a disconnect", () => {
    const section = buildNotionPromptSection(["notion_search"], {
      agentRole: "pilot",
    });
    expect(section).toContain("notion_search finds");
    expect(section).toContain(READ_ONLY);
    expect(section).not.toContain("notion_read reads");
    expect(section).not.toContain("notion_create_page");
    expect(section).not.toContain("Suggest the user switch");
    expect(section).toContain("Do not say Notion is disconnected");
  });

  it("shares To-do writes while keeping other role write boundaries", () => {
    for (const name of writes) {
      expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).not.toContain(name);
      expect(AGENT_ROLE_TOOL_ALLOWLIST.reflect).not.toContain(name);
    }
    expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).not.toContain("add_job");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).toEqual([
      "list_jobs",
      "get_job",
      "read_webpage",
      "add_job",
      "notion_search",
      "notion_read",
      "notion_create_page",
      "notion_append_content",
      "notion_update_record",
      "notion_update_content",
      "notion_delete_pages",
      "feishu_search_docs",
      "feishu_read_doc",
      "feishu_create_doc",
      "feishu_append_content",
      "feishu_update_content",
      "today_plan_read",
      "today_plan",
      "suggest_role",
    ]);
    expect(AGENT_ROLE_TOOL_ALLOWLIST.reflect).toEqual([
      "list_jobs",
      "get_job",
      "read_webpage",
      "notion_search",
      "notion_read",
      "feishu_search_docs",
      "feishu_read_doc",
      "today_plan_read",
      "today_plan",
      "suggest_role",
    ]);
  });
});

describe("homepage and empty state consume the roster", () => {
  it("renders the insight duty from the roster and only opens the panel", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    open.mockClear();
    render(<JourneySection jobsAbRead />);
    const prepare = screen.getByTestId("journey-agent-prepare");
    expect(prepare).toHaveTextContent(
      `Ask Voca Insight — ${rosterDuty("insight", "en")}`,
    );
    expect(prepare.textContent).not.toMatch(/notion/i);
    await user.click(prepare);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ role: "insight" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders the empty-state self lines for the active role", () => {
    render(<AgentChatEmptyState />);
    const self = screen.getByTestId("agent-empty-self");
    expect(self).toHaveTextContent(
      copyFor((key) => key, "en")(AGENT_ROSTER.insight.selfLeadKey),
    );
    expect(self).toHaveTextContent(
      copyFor((key) => key, "en")(AGENT_ROSTER.insight.selfHandoffKey),
    );
    expect(screen.getByTestId("agent-roster-legend")).toHaveTextContent(
      "Insight analyzes",
    );
    expect(screen.getByTestId("agent-empty-state").textContent).not.toMatch(
      /notion/i,
    );
  });
});
