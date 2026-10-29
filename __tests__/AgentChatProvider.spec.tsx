import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const chat = {
  messages: [] as any[],
  status: "ready" as string,
  error: undefined as Error | undefined,
  sendMessage: vi.fn(),
  stop: vi.fn(),
  regenerate: vi.fn(),
  clearError: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  setMessages: vi.fn((update: unknown) => {
    chat.messages =
      typeof update === "function"
        ? (update as (prev: typeof chat.messages) => typeof chat.messages)(
            chat.messages,
          )
        : (update as typeof chat.messages);
  }),
};
const useChatSpy = vi.fn((..._args: any[]) => chat);
vi.mock("@ai-sdk/react", () => ({
  useChat: (...a: unknown[]) => useChatSpy(...(a as [])),
}));

const chatInit = (call = 0) => useChatSpy.mock.calls[call][0] as any;
function beginExecution(durable = true) {
  const init = chatInit();
  const prepared = init.transport.prepareSendMessagesRequest({ messages: [{ id: "request-user", role: "user", parts: [{ type: "text", text: "hi" }] }], trigger: "submit-message" });
  const data = { conversationId: "conv-1", requestId: prepared.body.requestId, revision: durable ? 2 : 1, durable, released: durable };
  init.onData({ type: "data-conversation", data });
  return data;
}

const refresh = vi.fn();
let currentPathname = "/dashboard/myjobs";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => currentPathname,
}));

vi.mock("@/actions/agentChat.actions", () => ({
  archiveChatConversation: vi.fn(async () => ({ success: true })),
  getAgentChatPreflight: vi.fn(async () => {
    const settings = await getUserSettings();
    return { success: true, data: { kind: "legacy", model: settings.data?.settings?.ai?.model ?? null, persisted: true } };
  }),
  cancelChatConversationRequest: vi.fn(async () => ({ success: true, data: conversation() })),
  clearChatConversation: vi.fn(async () => ({ success: true })),
  deleteChatConversation: vi.fn(async () => ({ success: true })),
  saveChatConversation: vi.fn(async () => ({ success: true })),
  createChatConversation: vi.fn(async () => ({ success: true, data: null })),
  getChatConversation: vi.fn(async () => ({ success: false })),
  listChatConversations: vi.fn(async () => ({ success: true, data: [] })),
  resolveDraftPageContext: vi.fn(async () => ({
    success: true,
    data: { version: 1, items: [] },
  })),
  updateChatConversationContext: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({
    success: true,
    data: { settings: { ai: { provider: "ollama", model: "qwen3.5:9b" } } },
  })),
}));
vi.mock("@/utils/ai.utils", () => ({
  checkOllamaConnection: vi.fn(async () => ({ isConnected: true })),
}));

import {
  AgentChatProvider,
  useAgentChat,
} from "@/components/agent/AgentChatProvider";
import { RightRailProvider, useRightRail } from "@/context/RightRailContext";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import {
  createChatConversation,
  deleteChatConversation,
  saveChatConversation,
  cancelChatConversationRequest,
  getChatConversation,
  getAgentChatPreflight,
} from "@/actions/agentChat.actions";
import { AI_CONFIGURATION_CHANGED_EVENT } from "@/lib/ai/client-events";
import { getUserSettings } from "@/actions/userSettings.actions";
import { checkOllamaConnection } from "@/utils/ai.utils";

function Probe() {
  const c = useAgentChat();
  const { holder } = useRightRail();
  const { expanded, toggle } = useSidebar();
  return (
    <div>
      <button onClick={c.open}>open</button>
      <button onClick={c.close}>close</button>
      <button onClick={() => void c.startNewConversation()}>newConversation</button>
      <button onClick={() => void c.regenerate()}>regenerate</button>
      <button onClick={() => void c.regenerate("a2")}>regenerateTarget</button>
      <button onClick={c.stop}>stop</button>
      <button onClick={() => void c.selectConversation("conv-2")}>switchConversation</button>
      <button
        onClick={() =>
          void c.sendMessage({ parts: [{ type: "text", text: "hello" }] } as any)
        }
      >
        sendMessage
      </button>
      <button onClick={() => c.seedExchange("Add a job posting", "canned")}>
        seedExchange
      </button>
      <button
        onClick={() =>
          c.setDraftModel({ connectionId: "conn-1", model: "model-x" })
        }
      >
        setDraftModel
      </button>
      <button
        onClick={() =>
          c.addContextItem({
            kind: "job",
            entityId: "job-1",
            labelSnapshot: "Acme Engineer",
            source: "AUTO",
          })
        }
      >
        addContext
      </button>
      <span data-testid="conversation-id">{c.conversationId ?? ""}</span>
      <span data-testid="action-error">{c.actionError?.code ?? ""}</span>
      <span data-testid="recovery-failure">{c.recoveryFailure ? `${c.recoveryFailure.conversationId}:${c.recoveryFailure.operation}` : ""}</span>
      <span data-testid="message-roles">
        {c.messages.map((message) => message.role).join(",")}
      </span>
      <span data-testid="context-items">
        {c.context.items.map((item) => `${item.kind}:${item.entityId}`).join(",")}
      </span>
      <span data-testid="explicit-model">
        {c.explicit ? `${c.explicit.connectionId}/${c.explicit.model}` : ""}
      </span>
      <span data-testid="history-version">{c.historyVersion}</span>
      <span data-testid="brand-completion">{c.brandCompletion}</span>
      <button onClick={() => void c.addToolApprovalResponse({ id: "ap1", approved: true })}>approve</button>
      <button onClick={() => void c.addToolApprovalResponse({ id: "ap2", approved: false })}>rejectSecond</button>
      <button onClick={c.clearError}>clearError</button>
      <button onClick={c.clearQueued}>clearQueued</button>
      <span data-testid="queued">
        {c.queued ? (c.queued.parts[0] as any).text : ""}
      </span>
      <button onClick={c.togglePanelExpand}>togglePanelExpand</button>
      <button onClick={toggle}>toggleSidebar</button>
      <span data-testid="sidebar">{String(expanded)}</span>
      <span data-testid="state">{`${c.isOpen}|${c.approvalPending}|${c.interruptedTurn}|${holder}|${c.preflight.ok}`}</span>
      <span data-testid="preflight-dismissed">{String(c.preflight.dismissed)}</span>
      <span data-testid="identity">{JSON.stringify(c.identity)}</span>
      <span data-testid="composer-nonce">{c.composerNonce}</span>
      <span data-testid="panel-expanded">{String(c.isPanelExpanded)}</span>
      <span data-testid="review-stream">{c.toolStreams["rv1"] ?? ""}</span>
      <span data-testid="job-writes">{c.jobWrites}</span>
    </div>
  );
}

const conversation = (messages: any[] = []) => ({
  revision: 0,
  id: "conv-1",
  title: null,
  titleFallback: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  messages,
  context: { version: 1 as const, items: [] },
  lockKind: "legacy" as const,
  resolvedConnectionId: null,
  resolvedModel: null,
  archivedAt: null,
});

const tree = (initialMessages: any[] = []) => (
  <SidebarProvider initialExpanded>
    <RightRailProvider>
      <AgentChatProvider initialConversation={conversation(initialMessages)}>
        <Probe />
      </AgentChatProvider>
    </RightRailProvider>
  </SidebarProvider>
);

const draftTree = () => (
  <SidebarProvider initialExpanded>
    <RightRailProvider>
      <AgentChatProvider>
        <Probe />
      </AgentChatProvider>
    </RightRailProvider>
  </SidebarProvider>
);

const setup = (initialMessages: any[] = []) => render(tree(initialMessages));

const createdSnapshot = (id: string) => ({
  success: true,
  data: {
    id,
    revision: 0,
    title: null,
    titleFallback: "Add a job posting",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    messages: [],
    context: { version: 1 as const, items: [] },
    lockKind: "legacy" as const,
    resolvedConnectionId: null,
    resolvedModel: null,
    archivedAt: null,
  },
});

const approvalMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "tool-add_job",
      toolCallId: "c1",
      state: "approval-requested",
      input: { company: "Acme" },
      approval: { id: "ap1" },
    },
  ],
};

describe("AgentChatProvider", () => {
  it("signals brand completion only for successful finished turns and resets on a new conversation", async () => {
    setup();
    beginExecution();
    const finish = chatInit().onFinish;
    for (const flags of [{ isAbort: true }, { isError: true }]) {
      act(() => finish({ message: { parts: [] }, ...flags }));
    }
    act(() => finish({ message: approvalMessage, isAbort: false, isError: false }));
    expect(screen.getByTestId("brand-completion")).toHaveTextContent("0");
    act(() => finish({ message: { parts: [{ type: "text", text: "Done" }] }, isAbort: false, isError: false }));
    expect(screen.getByTestId("brand-completion")).toHaveTextContent("1");
    act(() => finish({ message: { parts: [] }, isAbort: false, isError: false }));
    expect(screen.getByTestId("brand-completion")).toHaveTextContent("2");
    await userEvent.click(screen.getByText("newConversation"));
    expect(screen.getByTestId("brand-completion")).toHaveTextContent("0");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    chat.messages = [];
    chat.status = "ready";
    chat.error = undefined;
    currentPathname = "/dashboard/myjobs";
  });

  it("seeds useChat with the persisted transcript", () => {
    setup([{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
    expect(chatInit().messages).toHaveLength(1);
  });

  // The canned exchange never reaches the route, so it is the one pair that
  // has to persist itself or it disappears on the next reload.
  it("refuses an existing-conversation seed without touching the transcript", async () => {
    chat.messages = [{ id: "m1", role: "user", parts: [] }];
    setup();
    await userEvent.click(screen.getByText("seedExchange"));
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(saveChatConversation).not.toHaveBeenCalled();
    expect(screen.getByTestId("action-error")).toHaveTextContent("CONVERSATION_TURN_CONFLICT");
  });

  it("wires sendAutomaticallyWhen, without which an approved tool never executes", () => {
    setup();
    expect(chatInit().sendAutomaticallyWhen).toBeTypeOf("function");
  });

  it("claims the right rail on open and releases it on close", async () => {
    setup();
    await userEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("state").textContent).toContain(
      "true|false|false|chat",
    );
    await userEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("state").textContent).toContain(
      "false|false|false|null",
    );
  });

  it("collapses the sidebar on open and leaves it collapsed on close", async () => {
    setup();
    expect(screen.getByTestId("sidebar").textContent).toBe("true");
    await userEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("sidebar").textContent).toBe("false");
    await userEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("sidebar").textContent).toBe("false");
  });

  it("stops the stream on close and flags the turn interrupted", async () => {
    chat.status = "streaming";
    setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("close"));
    expect(chat.stop).toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain("|true|");
  });

  it("does not flag an interrupted turn when nothing was streaming", async () => {
    setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("state").textContent).toContain(
      "false|false|false|null",
    );
  });

  // The interrupted notice describes a turn that is no longer interrupted the
  // moment the user resumes it, so it must not outlive the reply it asked for.
  // close() aborts through stop(), so the chat is idle by the time the user
  // sees the Continue button — the rerender is what the real status callback
  // does here.
  it("clears the interrupted flag when the turn is resumed with Continue", async () => {
    chat.status = "streaming";
    const { rerender } = setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("state").textContent).toContain("|true|");

    chat.status = "ready";
    // A stopped turn leaves the transcript on the user's own message — that
    // is the tail a Continue actually reruns.
    chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "add a job" }] }];
    rerender(tree());
    await userEvent.click(screen.getByText("regenerate"));
    expect(chat.regenerate).toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain(
      "false|false|false|null",
    );
  });

  it("clears the interrupted flag when the user sends a new message instead", async () => {
    chat.status = "streaming";
    const { rerender } = setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("state").textContent).toContain("|true|");

    chat.status = "ready";
    rerender(tree());
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain(
      "false|false|false|null",
    );
  });

  // The duplicate-key bug: a send during a live turn opened a second request,
  // useChat aborted neither, and the two streams took turns appending copies
  // of each other's message under the same id.
  it("holds a send instead of opening a second overlapping request", async () => {
    chat.status = "streaming";
    setup();
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("queued").textContent).toBe("hello");
  });

  it("dispatches the held message once the turn finishes", async () => {
    chat.status = "streaming";
    const { rerender } = setup();
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).not.toHaveBeenCalled();

    chat.status = "ready";
    await act(async () => {
      rerender(tree());
    });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendMessage.mock.calls[0][0].parts[0].text).toBe("hello");
    expect(screen.getByTestId("queued").textContent).toBe("");
  });

  it("holds a send while an approval is pending", async () => {
    chat.messages = [approvalMessage];
    setup([approvalMessage]);
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("queued").textContent).toBe("hello");
  });

  // approvalPending clears at the same instant sendAutomaticallyWhen fires the
  // POST that executes the approved tool. Releasing on that alone would race
  // it and cut the tool off mid-execution server-side.
  it("keeps holding while the approval's follow-up POST is streaming", async () => {
    chat.messages = [approvalMessage];
    const { rerender } = setup([approvalMessage]);
    await userEvent.click(screen.getByText("sendMessage"));

    chat.messages = [];
    chat.status = "streaming";
    await act(async () => {
      rerender(tree());
    });
    expect(chat.sendMessage).not.toHaveBeenCalled();

    chat.status = "ready";
    await act(async () => {
      rerender(tree());
    });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a held message when the conversation is cleared", async () => {
    chat.status = "streaming";
    const { rerender } = setup();
    await userEvent.click(screen.getByText("sendMessage"));
    await userEvent.click(screen.getByText("newConversation"));

    chat.status = "ready";
    await act(async () => {
      rerender(tree());
    });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("queued").textContent).toBe("");
  });

  it("lets the held message be discarded", async () => {
    chat.status = "streaming";
    setup();
    await userEvent.click(screen.getByText("sendMessage"));
    await userEvent.click(screen.getByText("clearQueued"));
    expect(screen.getByTestId("queued").textContent).toBe("");
  });

  // Continue only renders while idle, so this is defence — but it is the same
  // second-request hazard, and regenerate has no queue to fall back on.
  it("ignores Continue while a turn is still streaming", async () => {
    chat.status = "streaming";
    setup();
    await userEvent.click(screen.getByText("regenerate"));
    expect(chat.regenerate).not.toHaveBeenCalled();
  });

  it("reports a pending approval from a rehydrated transcript", () => {
    chat.messages = [approvalMessage];
    setup([approvalMessage]);
    expect(screen.getByTestId("state").textContent).toContain("|true|");
  });

  it("does not report a pending approval for an ordinary reply", () => {
    chat.messages = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "sure" }] },
    ];
    setup();
    expect(screen.getByTestId("state").textContent).toContain("|false|");
  });

  it("starts a new conversation without deleting history", async () => {
    chat.status = "streaming";
    setup();
    await userEvent.click(screen.getByText("newConversation"));
    const stopOrder = chat.stop.mock.invocationCallOrder[0];
    const resetOrder = chat.setMessages.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(resetOrder);
    expect(deleteChatConversation).not.toHaveBeenCalled();
  });

  it("signals the composer to reset on clear", async () => {
    setup();
    expect(screen.getByTestId("composer-nonce").textContent).toBe("0");
    await userEvent.click(screen.getByText("newConversation"));
    expect(screen.getByTestId("composer-nonce").textContent).toBe("1");
  });

  it("preflights Ollama on open and reports a failure", async () => {
    (checkOllamaConnection as any).mockResolvedValue({
      isConnected: false,
      error: "Ollama is not reachable.",
    });
    setup();
    await act(async () => {
      await userEvent.click(screen.getByText("open"));
    });
    expect(screen.getByTestId("state").textContent).toMatch(/false$/);
  });

  it("dismisses the preflight banner only until the next check", async () => {
    (checkOllamaConnection as any).mockResolvedValue({
      isConnected: false,
      error: "Ollama is not reachable.",
    });
    setup();
    await act(async () => {
      await userEvent.click(screen.getByText("open"));
    });
    expect(screen.getByTestId("preflight-dismissed")).toHaveTextContent("false");
    await act(async () => {
      await userEvent.click(screen.getByText("clearError"));
    });
    expect(chat.clearError).toHaveBeenCalled();
    expect(screen.getByTestId("preflight-dismissed")).toHaveTextContent("true");
    // Re-running the check re-announces a still-failing state.
    await act(async () => {
      await userEvent.click(screen.getByText("open"));
    });
    expect(screen.getByTestId("preflight-dismissed")).toHaveTextContent("false");
  });

  it("announces a completed failure even when the old banner was dismissed during the check", async () => {
    vi.mocked(checkOllamaConnection).mockResolvedValue({ isConnected: false });
    setup();
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toMatch(/false$/));
    let finish!: (result: { isConnected: boolean }) => void;
    vi.mocked(checkOllamaConnection).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(finish).toBeDefined());
    await userEvent.click(screen.getByText("clearError"));
    expect(screen.getByTestId("preflight-dismissed")).toHaveTextContent("true");
    await act(async () => { finish({ isConnected: false }); });
    expect(screen.getByTestId("preflight-dismissed")).toHaveTextContent("false");
    expect(screen.getByTestId("state").textContent).toMatch(/false$/);
  });

  it("fails the preflight when no model is configured, without probing Ollama", async () => {
    (getUserSettings as any).mockResolvedValue({
      success: true,
      data: { settings: { ai: { provider: "ollama", model: undefined } } },
    });
    setup();
    await act(async () => {
      await userEvent.click(screen.getByText("open"));
    });
    expect(screen.getByTestId("state").textContent).toMatch(/false$/);
    expect(checkOllamaConnection).not.toHaveBeenCalled();
  });

  it("retains the assigned model when runtime verification blocks a new draft", async () => {
    vi.mocked(getAgentChatPreflight).mockResolvedValueOnce({ success: true, data: {
      kind: "blocked", code: "STREAMING_NOT_VERIFIED", model: "gpt-5.6-luna", displayName: "ChatGPT", locked: false,
    } });
    render(draftTree());
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("gpt-5.6-luna"));
    expect(screen.getByTestId("identity")).toHaveTextContent("ChatGPT");
    expect(screen.getByTestId("state").textContent).toMatch(/false$/);
    expect(getUserSettings).not.toHaveBeenCalled();
    expect(checkOllamaConnection).not.toHaveBeenCalled();
  });

  it("does not invent Ollama when no AI is configured", async () => {
    vi.mocked(getAgentChatPreflight).mockResolvedValueOnce({ success: true, data: { kind: "legacy", model: null, persisted: false } });
    render(draftTree());
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("AI_NOT_CONFIGURED"));
    expect(screen.getByTestId("identity")).not.toHaveTextContent("ollama");
    expect(getUserSettings).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy settings after a failed authoritative preflight", async () => {
    vi.mocked(getAgentChatPreflight).mockRejectedValueOnce(new Error("offline"));
    render(draftTree());
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("BACKEND_UNAVAILABLE"));
    expect(getUserSettings).not.toHaveBeenCalled();
    expect(checkOllamaConnection).not.toHaveBeenCalled();
  });

  it("refreshes an open draft after AI settings change", async () => {
    vi.mocked(getAgentChatPreflight)
      .mockResolvedValueOnce({ success: true, data: { kind: "legacy", model: null, persisted: false } })
      .mockResolvedValueOnce({ success: true, data: { kind: "account", connectionId: "conn-1", provider: "OPENAI", backendKind: "CODEX_RUNTIME", model: "gpt-5.6-luna", displayName: "ChatGPT", locked: false } });
    render(draftTree());
    await userEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("AI_NOT_CONFIGURED"));
    act(() => { window.dispatchEvent(new Event(AI_CONFIGURATION_CHANGED_EVENT)); });
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("gpt-5.6-luna"));
    expect(screen.getByTestId("state").textContent).toMatch(/true$/);
  });

  it("puts the page context in the request body", () => {
    render(
      <SidebarProvider initialExpanded>
        <RightRailProvider>
          <AgentChatProvider initialConversation={conversation()}>
            <Probe />
          </AgentChatProvider>
        </RightRailProvider>
      </SidebarProvider>,
    );
    // prepareSendMessagesRequest is `protected` on HttpChatTransport: it is
    // there at runtime and only tsc objects. Cast rather than drop the test —
    // this is what proves the derived resumeId reaches the server, as opposed
    // to pageContextFor, which proves only the regex.
    const transport = chatInit().transport as any;
    const { body } = transport.prepareSendMessagesRequest({ messages: [] });
    expect(body.conversationId).toBe("conv-1");
    expect(body.pageContext).toBeUndefined();
  });

  const reviewToolMessage = {
    id: "a2",
    role: "assistant",
    parts: [
      {
        type: "tool-review_resume",
        toolCallId: "rv1",
        state: "output-available",
        input: {},
        output: {
          status: "ok",
          resumeId: "r1",
          title: "Senior Engineer Resume",
          scores: { overall: 78, impact: 72, clarity: 81, atsCompatibility: 69 },
          body: "## Summary",
          saved: true,
        },
      },
    ],
  } as any;

  // The save lives in review_resume's execute now: it holds the resumeId and
  // the finished text, so nothing client-side has to infer either. What is
  // left here is the refresh, so a stale saved-review card behind the panel
  // does not survive a review the user just watched land.
  it("refreshes the page after a completed review", async () => {
    setup();
    await act(async () => {
      beginExecution();
      chatInit().onFinish({
        message: reviewToolMessage,
        messages: [reviewToolMessage],
      });
    });
    expect(refresh).toHaveBeenCalled();
  });

  const createdToolMessage = {
    id: "a3",
    role: "assistant",
    parts: [
      {
        type: "tool-add_job",
        toolCallId: "c1",
        state: "output-available",
        input: { company: "Acme", jobTitle: "Engineer" },
        output: { created: true },
      },
    ],
  } as any;

  // add_job's approval splits the call and the execution across two POSTs, so
  // stopWhen cannot end the second one — the model narrates the write in a
  // full extra generation. Waiting for onFinish left the list stale for it.
  it("announces a job write as soon as add_job returns, mid-stream", async () => {
    const { rerender } = setup();
    expect(screen.getByTestId("job-writes").textContent).toBe("0");

    chat.messages = [createdToolMessage];
    await act(async () => {
      rerender(tree());
    });

    expect(screen.getByTestId("job-writes").textContent).toBe("1");
    expect(refresh).toHaveBeenCalledTimes(1);

    // The completed part stays in the transcript for every later token, so
    // without the tool-call-id guard the prose would re-announce it.
    chat.messages = [createdToolMessage, { id: "a4", role: "assistant", parts: [] }];
    await act(async () => {
      rerender(tree());
    });
    expect(screen.getByTestId("job-writes").textContent).toBe("1");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // The panel is mounted with the persisted conversation on every page load.
  it("does not announce a job write seeded from the persisted transcript", async () => {
    chat.messages = [createdToolMessage];
    setup([createdToolMessage]);

    expect(screen.getByTestId("job-writes").textContent).toBe("0");
    expect(refresh).not.toHaveBeenCalled();
  });

  // The route stubs only the copy it writes to the DB. Without the client
  // doing the same to its own transcript, the next thing the user types
  // re-injects the posting and calls add_job again on the job just saved.
  it("stubs the client-side paste after a successful add_job", async () => {
    setup();
    await act(async () => {
      beginExecution();
      chatInit().onFinish({
        message: createdToolMessage,
        messages: [createdToolMessage],
      });
    });
    const update = chat.setMessages.mock.calls.at(-1)![0] as any;
    const stubbed = update([
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "data-paste",
            id: "p1",
            data: {
              id: "p1",
              text: "SECRET_POSTING_BODY",
              chars: 19,
              truncated: false,
              consumed: false,
            },
          },
        ],
      },
      createdToolMessage,
    ]);
    expect(stubbed[0].parts[0].data.consumed).toBe(true);
    expect(JSON.stringify(stubbed)).not.toContain("SECRET_POSTING_BODY");
  });

  it("does not stub the client-side paste when no job was created", async () => {
    setup();
    await act(async () => {
      beginExecution();
      chatInit().onFinish({
        message: reviewToolMessage,
        messages: [reviewToolMessage],
      });
    });
    expect(chat.setMessages).not.toHaveBeenCalled();
  });

  it("accumulates transient review deltas keyed by tool call id", async () => {
    setup();
    beginExecution(false);
    await act(async () => {
      chatInit().onData({
        type: "data-nested-stream",
        id: "rv1",
        data: { delta: "SCO" },
      });
      chatInit().onData({
        type: "data-nested-stream",
        id: "rv1",
        data: { delta: "RES:" },
      });
      chatInit().onData({ type: "data-paste", id: "rv1", data: { delta: "nope" } });
    });
    expect(screen.getByTestId("review-stream")).toHaveTextContent("SCORES:");
  });

  it("restores an expanded panel when the sidebar re-expands", async () => {
    setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("togglePanelExpand"));
    expect(screen.getByTestId("panel-expanded").textContent).toBe("true");
    await userEvent.click(screen.getByText("toggleSidebar"));
    expect(screen.getByTestId("panel-expanded").textContent).toBe("false");
  });

  // The docked-flush width only makes sense on the page it was expanded on;
  // navigating away (e.g. clicking Dashboard/Jobs in the sidebar) leaves the
  // sidebar collapsed, so only a pathname change can catch this case.
  it("restores an expanded panel when the page navigates to a different route", async () => {
    const { rerender } = setup();
    await userEvent.click(screen.getByText("open"));
    await userEvent.click(screen.getByText("togglePanelExpand"));
    expect(screen.getByTestId("panel-expanded").textContent).toBe("true");
    currentPathname = "/dashboard/jobs";
    rerender(tree());
    expect(screen.getByTestId("panel-expanded").textContent).toBe("false");
  });

  it("persists one conversation when a draft suggestion is seeded", async () => {
    (createChatConversation as any).mockResolvedValueOnce(createdSnapshot("conv-new"));
    render(draftTree());

    await userEvent.click(screen.getByText("seedExchange"));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-new");
    });
    expect(createChatConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("message-roles").textContent).toBe("user,assistant");
    expect(screen.getByTestId("history-version").textContent).toBe("1");
    expect(screen.getByTestId("action-error").textContent).toBe("");
    const persisted = (createChatConversation as any).mock.calls[0][0];
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages[0].parts[0].text).toBe("Add a job posting");
    expect(persisted.messages[1].parts[0].text).toBe("canned");
  });

  it("rolls a rejected draft seed back to the pre-seed draft", async () => {
    (createChatConversation as any).mockRejectedValueOnce(
      new Error('{"error":"database is locked"}'),
    );
    render(draftTree());
    await userEvent.click(screen.getByText("addContext"));
    await userEvent.click(screen.getByText("setDraftModel"));

    await userEvent.click(screen.getByText("seedExchange"));

    await waitFor(() => {
      expect(screen.getByTestId("action-error").textContent).toBe("GENERIC");
    });
    expect(screen.getByTestId("message-roles").textContent).toBe("");
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("context-items").textContent).toBe("job:job-1");
    expect(screen.getByTestId("explicit-model").textContent).toBe("conn-1/model-x");
    expect(screen.getByTestId("history-version").textContent).toBe("0");
    expect(screen.queryByText("database is locked")).toBeNull();
    expect(screen.queryByText('{"error":"database is locked"}')).toBeNull();
    expect(deleteChatConversation).not.toHaveBeenCalled();
    expect(saveChatConversation).not.toHaveBeenCalled();
  });

  it("keeps the typed action code when creating the seeded conversation fails", async () => {
    (createChatConversation as any).mockResolvedValueOnce({
      success: false,
      code: "AI_NOT_CONFIGURED",
      message: '{"error":"provider down"}',
    });
    render(draftTree());
    await userEvent.click(screen.getByText("addContext"));

    await userEvent.click(screen.getByText("seedExchange"));

    await waitFor(() => {
      expect(screen.getByTestId("action-error").textContent).toBe(
        "AI_NOT_CONFIGURED",
      );
    });
    expect(screen.getByTestId("message-roles").textContent).toBe("");
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("context-items").textContent).toBe("job:job-1");
    expect(screen.getByTestId("history-version").textContent).toBe("0");
    expect(screen.queryByText("provider down")).toBeNull();
  });

  it("creates exactly one conversation when a failed seed is retried", async () => {
    (createChatConversation as any)
      .mockRejectedValueOnce(new Error("first create failed"))
      .mockResolvedValueOnce(createdSnapshot("conv-retry"));
    render(draftTree());

    await userEvent.click(screen.getByText("seedExchange"));
    await waitFor(() => {
      expect(screen.getByTestId("action-error").textContent).toBe("GENERIC");
    });
    expect(screen.getByTestId("message-roles").textContent).toBe("");

    await userEvent.click(screen.getByText("seedExchange"));
    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-retry");
    });
    expect(createChatConversation).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("message-roles").textContent).toBe("user,assistant");
    expect(screen.getByTestId("history-version").textContent).toBe("1");
    expect(screen.getByTestId("action-error").textContent).toBe("");
    const persisted = (createChatConversation as any).mock.calls[1][0];
    expect(persisted.messages).toHaveLength(2);
    expect(deleteChatConversation).not.toHaveBeenCalled();
  });

  it("leaves an existing conversation untouched when a new draft seed fails", async () => {
    (createChatConversation as any).mockRejectedValueOnce(new Error("nope"));
    setup();
    await userEvent.click(screen.getByText("newConversation"));
    expect(screen.getByTestId("conversation-id").textContent).toBe("");

    await userEvent.click(screen.getByText("seedExchange"));

    await waitFor(() => {
      expect(screen.getByTestId("action-error").textContent).toBe("GENERIC");
    });
    expect(deleteChatConversation).not.toHaveBeenCalled();
    expect(saveChatConversation).not.toHaveBeenCalled();
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("message-roles").textContent).toBe("");
    expect(screen.getByTestId("history-version").textContent).toBe("0");
    expect(createChatConversation).toHaveBeenCalledTimes(1);
  });

  it("sends one create for a double-clicked draft suggestion", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    (createChatConversation as any).mockImplementationOnce(() => pending);
    render(draftTree());

    await userEvent.click(screen.getByText("seedExchange"));
    await userEvent.click(screen.getByText("seedExchange"));

    expect(createChatConversation).toHaveBeenCalledTimes(1);
    expect(chat.setMessages).toHaveBeenCalledTimes(1);
    expect(chat.messages.map((message) => message.role).join(",")).toBe(
      "user,assistant",
    );

    await act(async () => {
      release({ success: false, code: "GENERIC" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("message-roles").textContent).toBe("");
    });
  });

  it("queues a send that races an in-flight draft seed instead of creating twice", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    (createChatConversation as any).mockImplementationOnce(() => pending);
    render(draftTree());

    await userEvent.click(screen.getByText("seedExchange"));
    await userEvent.click(screen.getByText("sendMessage"));

    expect(createChatConversation).toHaveBeenCalledTimes(1);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("queued").textContent).toBe("hello");

    await act(async () => {
      release({ success: false, code: "GENERIC" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("action-error").textContent).toBe("GENERIC");
    });
  });
});


describe("conversation client concurrency protocol", () => {
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = "ready"; });
  it("sends a unique requestId and the acknowledged revision, without a full transcript", () => {
    setup();
    const first = beginExecution();
    const body = chatInit().transport.prepareSendMessagesRequest({ messages: [{ id: "second", role: "user", parts: [{ type: "text", text: "second" }] }], trigger: "submit-message" }).body;
    expect(body).toMatchObject({ conversationId: "conv-1", expectedRevision: 2, operation: "send" });
    expect(body.requestId).not.toBe(first.requestId);
    expect(body.messages).toBeUndefined();
  });
  it("does not approve a streamed proposal until its durable release acknowledgement", async () => {
    setup([approvalMessage]);
    const execution = beginExecution(false);
    await userEvent.click(screen.getByText("approve"));
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    act(() => chatInit().onData({ type: "data-conversation", data: { ...execution, durable: true, released: true, revision: 2 } }));
    await userEvent.click(screen.getByText("approve"));
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "ap1", approved: true });
  });
  it("continues exactly the selected approval while preserving another pending proposal", async () => {
    const second = { ...approvalMessage, parts: [{ ...approvalMessage.parts[0], toolCallId: "c2", approval: { id: "ap2" } }] };
    const message = { ...approvalMessage, parts: [...approvalMessage.parts, ...second.parts] };
    setup([message]);
    await userEvent.click(screen.getByText("approve"));
    const responded = { ...message, parts: [{ ...message.parts[0], state: "approval-responded", approval: { id: "ap1", approved: true } }, message.parts[1]] };
    expect(chatInit().sendAutomaticallyWhen({ messages: [responded] })).toBe(true);
    const body = chatInit().transport.prepareSendMessagesRequest({ messages: [responded], trigger: "submit-message" }).body;
    expect(body).toMatchObject({ operation: "approval", approvalId: "ap1", decision: true });
    await userEvent.click(screen.getByText("rejectSecond"));
    expect(chat.addToolApprovalResponse).toHaveBeenCalledTimes(1);
  });
  it("reloads conflict authority and permits a new explicit approval without replaying it automatically", async () => {
    setup([approvalMessage]);
    const execution = beginExecution(false);
    vi.mocked(getChatConversation).mockResolvedValueOnce({ success: true, data: { ...conversation([approvalMessage]), revision: 7 } });
    await act(async () => chatInit().onError(Object.assign(new Error("conflict"), { code: "CONVERSATION_STALE_WRITE", conversationRequestId: execution.requestId })));
    expect(getChatConversation).toHaveBeenCalledWith("conv-1");
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chatInit().sendAutomaticallyWhen({ messages: [approvalMessage] })).toBe(false);
    await userEvent.click(screen.getByText("approve"));
    expect(chat.addToolApprovalResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["reject", "typed"])("handles %s reload failure and leaves local authority blocked", async (failure) => {
    setup([approvalMessage]);
    const execution = beginExecution(false);
    if (failure === "reject") vi.mocked(getChatConversation).mockRejectedValueOnce(new Error("transport failed"));
    else vi.mocked(getChatConversation).mockResolvedValueOnce({ success: false, code: "CONVERSATION_NOT_FOUND" });
    chat.setMessages.mockClear();
    await act(async () => chatInit().onError(Object.assign(new Error("old AI error"), { code: "AI_EXECUTION_FAILED", conversationRequestId: execution.requestId })));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("CONVERSATION_REFRESH_FAILED"));
    expect(chat.setMessages).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("sendMessage"));
    await userEvent.click(screen.getByText("regenerate"));
    await userEvent.click(screen.getByText("approve"));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chat.regenerate).not.toHaveBeenCalled();
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("handles a rejected cancel, cleans the request identity and requires reopening", async () => {
    setup();
    const execution = beginExecution(false);
    vi.mocked(cancelChatConversationRequest).mockRejectedValueOnce(new Error("cancel transport failed"));
    await userEvent.click(screen.getByText("stop"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("CONVERSATION_CANCEL_FAILED"));
    expect(cancelChatConversationRequest).toHaveBeenCalledWith("conv-1", execution.requestId);
    act(() => chatInit().onData({ type: "data-conversation", data: { ...execution, revision: 99, durable: true, released: true } }));
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-failure")).toHaveTextContent("conv-1:cancel");
  });

  it("can send in a new conversation while the old conversation's cancel is unresolved", async () => {
    setup();
    beginExecution(false);
    let reject!: (error: Error) => void;
    vi.mocked(cancelChatConversationRequest).mockReturnValueOnce(new Promise<never>((_, fail) => { reject = fail; }));
    vi.mocked(createChatConversation).mockResolvedValueOnce(createdSnapshot("conv-new"));
    await userEvent.click(screen.getByText("newConversation"));
    await userEvent.click(screen.getByText("sendMessage"));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    await act(async () => reject(new Error("old cancel failed")));
    expect(screen.getByTestId("conversation-id")).toHaveTextContent("conv-new");
    expect(screen.getByTestId("action-error")).toBeEmptyDOMElement();
  });

  it.each(["reload", "cancel"])("ignores a late successful %s after a newer conversation selection", async (operation) => {
    setup();
    const execution = beginExecution(false);
    let resolve!: (result: Awaited<ReturnType<typeof cancelChatConversationRequest>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof cancelChatConversationRequest>>>(done => { resolve = done; });
    if (operation === "reload") {
      vi.mocked(getChatConversation).mockReturnValueOnce(pending);
      act(() => chatInit().onError(Object.assign(new Error("conflict"), { code: "CONVERSATION_STALE_WRITE", conversationRequestId: execution.requestId })));
    } else {
      vi.mocked(cancelChatConversationRequest).mockReturnValueOnce(pending);
      await userEvent.click(screen.getByText("stop"));
    }
    vi.mocked(getChatConversation).mockResolvedValueOnce({ success: true, data: { ...conversation(), id: "conv-2", revision: 8 } });
    await userEvent.click(screen.getByText("switchConversation"));
    chat.setMessages.mockClear();
    await act(async () => resolve({ success: true, data: { ...conversation(), revision: 99 } }));
    expect(screen.getByTestId("conversation-id")).toHaveTextContent("conv-2");
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId("action-error")).toBeEmptyDOMElement();
  });

  it.each(["reload", "cancel"])("ignores late rejected C1 %s after switching to C2, preserving diagnostics", async (operation) => {
    setup();
    const execution = beginExecution(false);
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    if (operation === "reload") {
      vi.mocked(getChatConversation).mockReturnValueOnce(pending);
      act(() => chatInit().onError(Object.assign(new Error("conflict"), { code: "CONVERSATION_STALE_WRITE", conversationRequestId: execution.requestId })));
    } else {
      vi.mocked(cancelChatConversationRequest).mockReturnValueOnce(pending);
      await userEvent.click(screen.getByText("stop"));
    }
    vi.mocked(getChatConversation).mockResolvedValueOnce({ success: true, data: { ...conversation([{ id: "c2-message", role: "user", parts: [] }]), id: "conv-2", revision: 8 } });
    await userEvent.click(screen.getByText("switchConversation"));
    await waitFor(() => expect(screen.getByTestId("conversation-id")).toHaveTextContent("conv-2"));
    chat.setMessages.mockClear();
    await act(async () => reject(new Error("late failure")));
    expect(screen.getByTestId("action-error")).toBeEmptyDOMElement();
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-failure")).toHaveTextContent(`conv-1:${operation}`);
    await userEvent.click(screen.getByText("sendMessage"));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });
  // The answer action row names its own message; the request it produces must
  // carry that id, not whatever happens to sit last when the POST is prepared.
  it("sends the named answer as the regenerate target", async () => {
    chat.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "older" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "latest" }] },
    ];
    setup();
    await userEvent.click(screen.getByText("regenerateTarget"));
    expect(chat.regenerate).toHaveBeenCalledWith({ messageId: "a2" });
    const body = chatInit().transport.prepareSendMessagesRequest({
      messages: chat.messages.slice(0, -1),
      trigger: "regenerate-message",
      messageId: "a2",
    }).body;
    expect(body).toMatchObject({ operation: "regenerate", targetMessageId: "a2" });
  });

  // Regenerate has no queue; status only flips after the SDK has prepared the
  // request, so the in-flight ref is what keeps a fast repeat click off the
  // wire. Once the request settles, the next click is a fresh operation.
  it("ignores a repeat regenerate until the in-flight request settles", async () => {
    chat.messages = [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "latest" }] }];
    let release!: () => void;
    chat.regenerate.mockImplementationOnce(
      () => new Promise<void>((done) => { release = done; }),
    );
    setup();
    await userEvent.click(screen.getByText("regenerate"));
    await userEvent.click(screen.getByText("regenerate"));
    expect(chat.regenerate).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await userEvent.click(screen.getByText("regenerate"));
    expect(chat.regenerate).toHaveBeenCalledTimes(2);
  });

  it("clears a recovered action error when regenerating the restored answer", async () => {
    const messages = [
      { id: "u2", role: "user", parts: [{ type: "text", text: "question" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "saved answer" }] },
    ];
    chat.messages = messages;
    vi.mocked(getChatConversation).mockResolvedValueOnce({ success: true, data: conversation(messages) });
    setup(messages);
    beginExecution();
    act(() => chatInit().onError(new Error("generation failed")));
    await waitFor(() => expect(screen.getByTestId("action-error").textContent).not.toBe(""));

    await userEvent.click(screen.getByText("regenerateTarget"));

    expect(chat.regenerate).toHaveBeenCalledWith({ messageId: "a2" });
    expect(screen.getByTestId("action-error")).toHaveTextContent(/^$/);
  });

  // Nothing to regenerate against: an empty transcript has no target, and a
  // request built on a missing id could never be admitted anyway.
  it("does not open a regenerate request on an empty transcript", async () => {
    setup();
    await userEvent.click(screen.getByText("regenerate"));
    expect(chat.regenerate).not.toHaveBeenCalled();
  });

  it("cancels captured C1 identity on New Conversation and ignores its late durable finish", async () => {
    setup();
    const execution = beginExecution(false);
    await userEvent.click(screen.getByText("newConversation"));
    expect(cancelChatConversationRequest).toHaveBeenCalledWith("conv-1", execution.requestId);
    const before = screen.getByTestId("history-version").textContent;
    act(() => {
      chatInit().onData({ type: "data-conversation", data: { ...execution, revision: 99, durable: true, released: true } });
      chatInit().onFinish({ message: { parts: [] }, isAbort: false, isError: false });
    });
    expect(screen.getByTestId("conversation-id")).toHaveTextContent("");
    expect(screen.getByTestId("history-version").textContent).toBe(before);
    expect(refresh).not.toHaveBeenCalled();
  });
});
