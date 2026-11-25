import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";

const state = vi.hoisted(() => ({
  identity: { checked: true, ok: false, kind: "blocked", model: null as string | null, displayName: null as string | null, locked: false, persistedLegacy: false, code: "AI_NOT_CONFIGURED" },
  conversationId: null as string | null,
  setDraftModel: vi.fn(),
  startNewConversation: vi.fn(),
  startNativeConversation: vi.fn(),
  nativeSession: false,
  models: [] as any[],
  nativeEntry: null as any,
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    identity: state.identity,
    conversationId: state.conversationId,
    modelPickerNonce: 0,
    setDraftModel: state.setDraftModel,
    startNewConversation: state.startNewConversation,
    startNativeConversation: state.startNativeConversation,
    nativeSession: state.nativeSession,
    explicit: null,
  }),
}));
vi.mock("@/actions/agentChat.actions", () => ({
  listEligibleChatModels: async () => ({ success: true, data: state.models }),
  getNativeChatEntry: async () => ({ success: true, data: state.nativeEntry }),
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

// The Codex native entry passes the server-resolved pair straight to the
// provider — it never reuses the generic chat lock or the draft's pick.
it("creates a native conversation with the server-resolved Codex pair", async () => {
  state.conversationId = null;
  state.nativeSession = false;
  state.nativeEntry = { ok: true, connectionId: "conn-codex", model: "gpt-5.4", displayName: "ChatGPT via Codex" };
  state.startNativeConversation.mockClear();
  render(<AgentChatIdentity />);
  await userEvent.click(screen.getByTestId("agent-identity"));
  await userEvent.click(await screen.findByTestId("agent-native-entry"));
  expect(state.startNativeConversation).toHaveBeenCalledWith({
    connectionId: "conn-codex",
    model: "gpt-5.4",
  });
});

// An unavailable entry is grey with the specific blocker, not a click that
// errors afterwards.
it("greys the native entry with the specific blocker", async () => {
  state.nativeSession = false;
  state.nativeEntry = { ok: false, details: { reason: "RUNTIME_VERSION_MISMATCH", runtimeVersion: "0.165.0", requiredVersion: "0.170.0", model: null, models: ["gpt-5.4"], verifiedVersions: ["0.169.0", "0.170.0"] } };
  render(<AgentChatIdentity />);
  await userEvent.click(screen.getByTestId("agent-identity"));
  expect(await screen.findByText("Version 0.165.0 is not verified; verified: 0.169.0, 0.170.0")).toBeInTheDocument();
  expect(screen.queryByTestId("agent-native-entry")).not.toBeInTheDocument();
});

// Native mode reads as a mode badge with a one-click exit to a regular
// draft — not a locked model pair posing as a picker.
it("shows the native mode badge and a leave action", async () => {
  state.nativeSession = true;
  state.conversationId = "conv-native";
  state.startNewConversation.mockClear();
  render(<AgentChatIdentity />);
  expect(screen.getByTestId("agent-identity")).toHaveTextContent("Codex native");
  await userEvent.click(screen.getByTestId("agent-identity"));
  expect(await screen.findByText(/automatic native web search/i)).toBeInTheDocument();
  expect(screen.getByText(/read-only business tools/i)).toBeInTheDocument();
  expect(screen.getByText(/write tools and skills are not loaded/i)).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: /back to regular chat/i }));
  expect(state.startNewConversation).toHaveBeenCalledWith({ carry: true });
});
