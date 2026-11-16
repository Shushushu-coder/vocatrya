import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPermissionChip } from "@/components/agent/AgentPermissionChip";
const mocks = vi.hoisted(() => ({ read: vi.fn(), chat: { activeRole: "pilot", conversationId: "owned", approvalPending: false } }));
vi.mock("@/actions/agentChat.actions", () => ({ getAgentToolPermissions: mocks.read }));
vi.mock("@/components/agent/AgentChatProvider", () => ({ useAgentChat: () => mocks.chat }));
it("shows authoritative tools and their individual approval rules", async () => {
  mocks.read.mockResolvedValue({ success: true, data: { role: "pilot", tools: [{ name: "notion_create_page", approval: "always" }, { name: "list_jobs", approval: "none" }] } });
  render(<AgentPermissionChip />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText("Create Notion page")).toBeInTheDocument();
  expect(screen.getByText("Always confirm")).toBeInTheDocument();
  expect(screen.getByText("No extra confirmation")).toBeInTheDocument();
  expect(mocks.read).toHaveBeenCalledWith({ conversationId: "owned", agentRole: "pilot" });
});
it("shows an unavailable state on read failure instead of inventing permissions", async () => {
  mocks.read.mockRejectedValue(new Error("offline"));
  render(<AgentPermissionChip compact />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load permissions");
});
