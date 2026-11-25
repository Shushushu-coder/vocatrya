import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPermissionChip } from "@/components/agent/AgentPermissionChip";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  prefs: vi.fn(),
  setDraft: vi.fn(),
  chat: {
    activeRole: "pilot",
    conversationId: "owned" as string | null,
    context: { version: 1, items: [], permissionMode: "rules" as "ask" | "rules" | "full" },
    approvalPending: false,
    draftPermissionMode: "rules" as "ask" | "rules" | "full" | undefined,
    setDraftPermissionMode: vi.fn(),
  },
}));
vi.mock("@/actions/agentChat.actions", () => ({ getAgentToolPermissions: mocks.read }));
vi.mock("@/actions/agentPreferences.actions", () => ({ getAgentPreferences: mocks.prefs }));
vi.mock("@/components/agent/AgentChatProvider", () => ({ useAgentChat: () => mocks.chat }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.chat.conversationId = "owned";
  mocks.chat.context = { version: 1, items: [], permissionMode: "rules" };
  mocks.chat.draftPermissionMode = "rules";
  mocks.prefs.mockResolvedValue({ defaultPermission: "rules" });
});
it("shows authoritative tools and their individual approval rules", async () => {
  mocks.read.mockResolvedValue({ success: true, data: { role: "pilot", tools: [{ name: "notion_create_page", approval: "always" }, { name: "list_jobs", approval: "none" }] } });
  render(<AgentPermissionChip />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText("Create Notion page")).toBeInTheDocument();
  expect(screen.getByText("Always confirm")).toBeInTheDocument();
  expect(screen.getByText("No extra confirmation")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Approve by rules (recommended)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Full access (not recommended)" })).toBeInTheDocument();
  expect(screen.queryByTestId("agent-permission-full-warning")).not.toBeInTheDocument();
  expect(mocks.read).toHaveBeenCalledWith({ conversationId: "owned", agentRole: "pilot" });
});
it("shows an unavailable state on read failure instead of inventing permissions", async () => {
  mocks.read.mockRejectedValue(new Error("offline"));
  render(<AgentPermissionChip compact />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load permissions");
});
it("shows explicit risk-at-your-own-risk warning when full access is active", async () => {
  mocks.chat.conversationId = null;
  mocks.chat.draftPermissionMode = "full";
  mocks.read.mockResolvedValue({ success: true, data: { role: "pilot", tools: [] } });
  render(<AgentPermissionChip />);
  fireEvent.click(screen.getByRole("button"));
  const warning = await screen.findByTestId("agent-permission-full-warning");
  expect(warning).toHaveTextContent(/not recommended/i);
  expect(warning).toHaveTextContent(/assumed by you/i);
});
