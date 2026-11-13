import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { APP_CONSTANTS } from "@/lib/constants";
import { AGENT_PASTE_PART_TYPE } from "@/models/agent.model";

const chat = {
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready" as string,
  approvalPending: false,
  queued: undefined as any,
  clearQueued: vi.fn(),
  error: undefined as Error | undefined,
  actionError: null as { code: string } | null,
  clearError: vi.fn(),
  preflight: { checked: true, ok: true } as any,
  composerNonce: 0,
  composerSeed: "",
  registerComposerApi: vi.fn(),
  // The chip is provider state now (a model-switch remount must not lose it),
  // so the mock mirrors setPasteChip back into pasteChip; specs rerender to
  // observe it, the same way the real provider re-renders consumers.
  pasteChip: undefined as any,
  setPasteChip: vi.fn((v: any) => {
    chat.pasteChip = v;
  }),
  context: { version: 1, items: [] as any[] },
  addContextItem: vi.fn(),
  removeContextItem: vi.fn(),
  contextPickerNonce: 0,
  conversationId: null as string | null,
  identity: {
    checked: true,
    ok: true,
    kind: "legacy",
    locked: false,
    model: "m1",
    displayName: null,
    persistedLegacy: false,
  } as any,
  setDraftModel: vi.fn(),
  startNewConversation: vi.fn(),
  modelPickerNonce: 0,
  contextUsage: null as any,
  panelWidth: 640,
  messages: [] as any[],
  regenerate: vi.fn(),
  requestModelPicker: vi.fn(),
};
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));
vi.mock("@/actions/agentChat.actions", () => ({
  listAgentContextOptions: vi.fn(async () => ({
    success: true,
    data: { jobs: [], resumes: [] },
  })),
  listEligibleChatModels: vi.fn(async () => ({ success: true, data: [] })),
}));

import { AgentChatInput } from "@/components/agent/AgentChatInput";
import { AgentChatContextBar } from "@/components/agent/AgentChatContextBar";

// A function, not a const: React bails out of rerendering a referentially
// identical element, and the mocked provider mutates `chat` outside React
// state, so every rerender needs a fresh element to re-read it.
const harness = () => (
  <>
    <AgentChatContextBar />
    <AgentChatInput />
  </>
);
const renderComposer = () => render(harness());

const paste = async (text: string) => {
  const box = screen.getByRole("textbox");
  box.focus();
  await userEvent.paste(text);
};

const short = "a short pasted note";
const long = "x".repeat(APP_CONSTANTS.AGENT_CHAT_PASTE_THRESHOLD + 100);
// A real Indeed posting measured 1368 chars and fell under the old 1500-char
// threshold, so it arrived as plain text with no chip and add_job lost the
// description. The threshold has to clear a posting this size.
const posting = "z".repeat(1368);
const huge = "y".repeat(APP_CONSTANTS.AGENT_CHAT_PASTE_MAX_CHARS + 1000);

describe("AgentChatInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.status = "ready";
    chat.approvalPending = false;
    chat.queued = undefined;
    chat.error = undefined;
    chat.actionError = null;
    chat.preflight = { checked: true, ok: true };
    chat.composerNonce = 0;
    chat.pasteChip = undefined;
    chat.context = { version: 1, items: [] };
    chat.conversationId = null;
    chat.identity = {
      checked: true,
      ok: true,
      kind: "legacy",
      locked: false,
      model: "m1",
      displayName: null,
      persistedLegacy: false,
    };
    chat.contextUsage = null;
    chat.contextPickerNonce = 0;
    chat.modelPickerNonce = 0;
  });

  it("leaves a short paste inline in the textarea", async () => {
    renderComposer();
    await paste(short);
    // Not toHaveValue: jest-dom does not reliably accept asymmetric matchers.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(
      short,
    );
    expect(screen.queryByText(/pasted posting/i)).not.toBeInTheDocument();
  });

  it("turns an over-threshold paste into a removable card in the row", async () => {
    const { rerender } = renderComposer();
    await paste(long);
    rerender(harness());
    expect(screen.getByTestId("agent-paste-chip")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    await userEvent.click(
      screen.getByRole("button", { name: /remove pasted/i }),
    );
    rerender(harness());
    expect(screen.queryByTestId("agent-paste-chip")).not.toBeInTheDocument();
  });

  it("chips a short job posting, not just a long one", async () => {
    const { rerender } = renderComposer();
    await paste(posting);
    rerender(harness());
    expect(screen.getByTestId("agent-paste-chip")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  // Browsers gate crypto.randomUUID behind a secure context, so it is absent
  // over plain http on a LAN host. Node's global crypto is not gated, which is
  // why every other test here passes while the browser drops the paste.
  it("chips an over-threshold paste where crypto.randomUUID is unavailable", async () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      const { rerender } = renderComposer();
      await paste(long);
      rerender(harness());
      expect(screen.getByTestId("agent-paste-chip")).toBeInTheDocument();
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });

  it("truncates and labels a paste above the ceiling", async () => {
    const { rerender } = renderComposer();
    await paste(huge);
    rerender(harness());
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "add this");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    const parts = chat.sendMessage.mock.calls[0][0].parts;
    const pastePart = parts.find((p: any) => p.type === AGENT_PASTE_PART_TYPE);
    expect(pastePart.data.text.length).toBe(
      APP_CONSTANTS.AGENT_CHAT_PASTE_MAX_CHARS,
    );
    expect(pastePart.data.truncated).toBe(true);
  });

  it("sends the chip as a data part alongside the text", async () => {
    const { rerender } = renderComposer();
    await paste(long);
    rerender(harness());
    await userEvent.type(screen.getByRole("textbox"), "add this job");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    const parts = chat.sendMessage.mock.calls[0][0].parts;
    expect(
      parts.some((p: any) => p.type === "text" && p.text === "add this job"),
    ).toBe(true);
    expect(parts.some((p: any) => p.type === AGENT_PASTE_PART_TYPE)).toBe(true);
  });

  // Whether a send waits — for an approval, or for a reply already streaming —
  // is the provider's call, because it is the only place that sees all five
  // senders. A composer that second-guesses it disagrees with the resume
  // page's Review button. Holding is covered in AgentChatProvider.spec.
  it("delegates every send to the provider, approval pending or not", async () => {
    chat.approvalPending = true;
    renderComposer();
    await userEvent.type(screen.getByRole("textbox"), "the company is wrong");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendMessage.mock.calls[0][0].parts[0].text).toBe(
      "the company is wrong",
    );
  });

  it("shows a held message and says what it is waiting for", () => {
    chat.queued = { parts: [{ type: "text", text: "the company is wrong" }] };
    const { rerender } = renderComposer();
    expect(screen.getByText(/current reply finishes/i)).toBeInTheDocument();
    expect(screen.getByText(/the company is wrong/)).toBeInTheDocument();
    chat.approvalPending = true;
    rerender(harness());
    expect(screen.getByText(/waiting on your approval/i)).toBeInTheDocument();
  });

  it("labels a held paste-only message with its chip", () => {
    chat.queued = {
      parts: [
        {
          type: AGENT_PASTE_PART_TYPE,
          id: "p1",
          data: { id: "p1", text: "x", chars: 1234, truncated: false },
        },
      ],
    };
    renderComposer();
    expect(screen.getByText(/pasted posting · 1,234 chars/i)).toBeInTheDocument();
  });

  it("hands the discard back to the provider", async () => {
    chat.queued = { parts: [{ type: "text", text: "never mind" }] };
    renderComposer();
    await userEvent.click(
      screen.getByRole("button", { name: /remove from queue/i }),
    );
    expect(chat.clearQueued).toHaveBeenCalled();
  });

  it("empties the composer when the conversation is cleared", async () => {
    const { rerender } = renderComposer();
    await paste(long);
    rerender(harness());
    await userEvent.type(screen.getByRole("textbox"), "never mind");
    chat.composerNonce = 1;
    chat.pasteChip = undefined;
    rerender(harness());
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByTestId("agent-paste-chip")).not.toBeInTheDocument();
  });

  it("swaps send for stop while streaming", async () => {
    chat.status = "streaming";
    renderComposer();
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(chat.stop).toHaveBeenCalled();
  });

  it("shows a dismissible error banner above the composer", async () => {
    chat.error = new Error("Cannot reach ollama.");
    renderComposer();
    expect(screen.getByText(/cannot reach ollama/i)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /dismiss error/i }),
    );
    expect(chat.clearError).toHaveBeenCalled();
  });

  it.each(["CONVERSATION_REFRESH_FAILED", "CONVERSATION_CANCEL_FAILED"])("prioritizes %s over an old AI error without offering Retry AI", (code) => {
    chat.error = Object.assign(new Error("Old AI failure"), { code: "AI_EXECUTION_FAILED" });
    chat.actionError = { code };
    renderComposer();
    expect(screen.getByText(/please reopen the conversation/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Old AI failure")).not.toBeInTheDocument();
  });

  it("disables sending entirely when the preflight failed", () => {
    chat.preflight = {
      checked: true,
      ok: false,
      error: "Ollama is not reachable.",
    };
    renderComposer();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("shows the banner while a failed preflight is not dismissed", () => {
    chat.preflight = { checked: true, ok: false, code: "STREAMING_NOT_VERIFIED" };
    renderComposer();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss error/i })).toBeInTheDocument();
    expect(screen.getByText(/runtime version has changed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AI settings/i })).toHaveAttribute("href", "/dashboard/settings?section=ai-services");
  });

  it("guides an unconfigured user to AI settings instead of suggesting another model", () => {
    chat.preflight = { checked: true, ok: false, code: "AI_NOT_CONFIGURED" };
    renderComposer();
    expect(screen.getByText(/AI is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AI settings/i })).toHaveAttribute("href", "/dashboard/settings?section=ai-services");
    expect(screen.queryByText(/another model/i)).not.toBeInTheDocument();
  });

  it("hides a dismissed preflight banner without lifting the send restriction", () => {
    chat.preflight = { checked: true, ok: false, dismissed: true, code: "STREAMING_NOT_VERIFIED" };
    renderComposer();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("keeps the model picker and add menu in the toolbar", () => {
    renderComposer();
    expect(screen.getByTestId("agent-identity")).toBeInTheDocument();
    expect(screen.getByTestId("agent-add-context")).toBeInTheDocument();
  });

  // Both menus live inside the composer subtree now, so they remount with
  // it — while their nonces are provider state that survives. A remount
  // must not reopen them; only a bump while mounted does.
  it("does not reopen the toolbar menus on a composer remount", async () => {
    chat.contextPickerNonce = 1;
    chat.modelPickerNonce = 1;
    const { rerender } = renderComposer();
    expect(screen.queryByText("Jobs")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/model for the next conversation/i),
    ).not.toBeInTheDocument();
    chat.contextPickerNonce = 2;
    rerender(harness());
    expect(await screen.findByText("Jobs")).toBeInTheDocument();
  });

  it("shows the context estimate only when the server reports one", () => {
    renderComposer();
    expect(
      screen.queryByRole("button", { name: /context usage/i }),
    ).not.toBeInTheDocument();
    chat.contextUsage = {
      conversationId: "conv-1",
      requestId: "r1",
      profile: "fresh",
      estimatedInputTokens: 3200,
      recentTurnCount: 2,
      droppedTurnCount: 0,
      tokens: {
        system: 1200,
        currentUser: 400,
        history: 800,
        explicitContext: 300,
        toolResult: 300,
        summary: 0,
        dynamic: 2000,
      },
      budgets: {
        assembledInputTokens: 16000,
        dynamicTokens: 6000,
        explicitContextTokens: 2000,
        historyTokens: 3000,
        historicalToolTokens: 2000,
        currentUserTokens: 6000,
        summaryTokens: 1000,
      },
    };
    renderComposer();
    expect(
      screen.getAllByRole("button", { name: /context usage/i }).length,
    ).toBeGreaterThan(0);
  });
});
