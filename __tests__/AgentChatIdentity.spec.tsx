import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";

const state = vi.hoisted(() => ({
  identity: { checked: true, ok: false, kind: "blocked", model: null as string | null, displayName: null as string | null, locked: false, persistedLegacy: false, code: "AI_NOT_CONFIGURED" },
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ identity: state.identity, conversationId: null, modelPickerNonce: 0 }),
}));
vi.mock("@/actions/agentChat.actions", () => ({ listEligibleChatModels: async () => ({ success: true, data: [] }) }));

it("shows configuration guidance when no AI model exists", async () => {
  render(<AgentChatIdentity />);
  expect(screen.getByTestId("agent-identity")).toHaveTextContent("Configure AI");
  expect(screen.queryByText(/ollama/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId("agent-identity"));
  expect(await screen.findByRole("link", { name: /AI settings/i })).toHaveAttribute("href", "/dashboard/settings?section=ai-services");
});

it("shows the assigned model and connection even while verification blocks sending", () => {
  state.identity = { ...state.identity, model: "gpt-5.6-luna", displayName: "ChatGPT", code: "STREAMING_NOT_VERIFIED" };
  render(<AgentChatIdentity />);
  expect(screen.getByTestId("agent-identity")).toHaveTextContent("gpt-5.6-luna");
  expect(screen.getByTestId("agent-identity")).toHaveTextContent("ChatGPT");
});
