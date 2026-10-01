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

const refresh = vi.fn();
let currentPathname = "/dashboard/myjobs";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => currentPathname,
}));

vi.mock("@/actions/agentChat.actions", () => ({
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
} from "@/actions/agentChat.actions";
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
      <button onClick={c.clearQueued}>clearQueued</button>
      <span data-testid="queued">
        {c.queued ? (c.queued.parts[0] as any).text : ""}
      </span>
      <button onClick={c.togglePanelExpand}>togglePanelExpand</button>
      <button onClick={toggle}>toggleSidebar</button>
      <span data-testid="sidebar">{String(expanded)}</span>
      <span data-testid="state">{`${c.isOpen}|${c.approvalPending}|${c.interruptedTurn}|${holder}|${c.preflight.ok}`}</span>
      <span data-testid="composer-nonce">{c.composerNonce}</span>
      <span data-testid="panel-expanded">{String(c.isPanelExpanded)}</span>
      <span data-testid="review-stream">{c.toolStreams["rv1"] ?? ""}</span>
      <span data-testid="job-writes">{c.jobWrites}</span>
    </div>
  );
}

const conversation = (messages: any[] = []) => ({
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
    title: null,
    titleFallback: "Add a job posting",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    messages: [],
    context: { version: 1 as const, items: [] },
    lockKind: "legacy" as const,
    resolvedConnectionId: null,
    resolvedModel: null,
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
  it("appends a seeded exchange to the transcript and persists it", async () => {
    chat.messages = [{ id: "m1", role: "user", parts: [] }];
    setup();
    await userEvent.click(screen.getByText("seedExchange"));

    expect(chat.sendMessage).not.toHaveBeenCalled();
    const next = chat.setMessages.mock.calls[0][0];
    expect(next).toHaveLength(3);
    expect(next[1]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Add a job posting" }],
    });
    expect(next[2]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "canned" }],
    });
    expect(next[1].id).not.toBe(next[2].id);
    expect(saveChatConversation).toHaveBeenCalledWith("conv-1", next);
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
      chatInit().onFinish({
        message: reviewToolMessage,
        messages: [reviewToolMessage],
      });
    });
    expect(chat.setMessages).not.toHaveBeenCalled();
  });

  it("accumulates transient review deltas keyed by tool call id", async () => {
    setup();
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
