import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";

const state = vi.hoisted(() => ({
  identity: { checked: true, ok: false, kind: "blocked", model: null as string | null, displayName: null as string | null, locked: false, persistedLegacy: false, code: "AI_NOT_CONFIGURED" },
  conversationId: null as string | null,
  setDraftModel: vi.fn(),
  startNewConversation: vi.fn(),
  models: [] as any[],
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    identity: state.identity,
    conversationId: state.conversationId,
    modelPickerNonce: 0,
    setDraftModel: state.setDraftModel,
    startNewConversation: state.startNewConversation,
  }),
}));
vi.mock("@/actions/agentChat.actions", () => ({
  listEligibleChatModels: async () => ({ success: true, data: state.models }),
}));

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

// D1: a model pick on a persisted conversation is a new draft that keeps the
// composer's text/context/paste — the provider carries them, so the identity
// hands it the carry flag rather than an empty reset.
it("carries the composer state when a locked conversation picks another model", async () => {
  state.conversationId = "conv-1";
  state.identity = {
    ...state.identity,
    checked: true,
    ok: true,
    kind: "managed",
    model: "gpt-5.6-luna",
    displayName: "ChatGPT",
    locked: true,
    persistedLegacy: false,
    code: undefined as unknown as string,
  };
  state.models = [{ connectionId: "c9", model: "m9", displayName: "Other" }];
  state.startNewConversation.mockClear();
  render(<AgentChatIdentity />);
  await userEvent.click(screen.getByTestId("agent-identity"));
  await userEvent.click(
    await screen.findByRole("button", { name: /another model/i }),
  );
  await userEvent.click(await screen.findByText(/m9/));
  expect(state.startNewConversation).toHaveBeenCalledWith({
    explicit: { connectionId: "c9", model: "m9" },
    carry: true,
  });
});
