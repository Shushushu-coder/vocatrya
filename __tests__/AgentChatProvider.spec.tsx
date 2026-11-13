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
import type { AgentRole } from "@/lib/agent/agentRoles";
import { RightRailProvider, useRightRail } from "@/context/RightRailContext";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import {
  createChatConversation,
  deleteChatConversation,
  saveChatConversation,
  cancelChatConversationRequest,
  getChatConversation,
  getAgentChatPreflight,
  resolveDraftPageContext,
  updateChatConversationContext,
} from "@/actions/agentChat.actions";
import { AI_CONFIGURATION_CHANGED_EVENT } from "@/lib/ai/client-events";
import {
  currentAgentSlotGeneration,
  resetAgentSlotPersistenceForTests,
  restoreDurableAgentSlots,
} from "@/lib/agent/roleSlotPersistence";
import { bindAgentSlotOwner } from "@/lib/agent/activeAgentRole";
import { getUserSettings } from "@/actions/userSettings.actions";
import { checkOllamaConnection } from "@/utils/ai.utils";

function Probe() {
  const c = useAgentChat();
  const { holder } = useRightRail();
  const { expanded, toggle } = useSidebar();
  return (
    <div>
      <button onClick={() => c.open()}>open</button>
      <button onClick={() => c.open({ role: "reflect" })}>openReflect</button>
      <button onClick={() => void c.switchRole("insight")}>switchInsight</button>
      <button onClick={() => void c.switchRole("pilot")}>switchPilot</button>
      <button onClick={() => void c.switchRole("reflect")}>switchReflect</button>
      <button onClick={() => c.fillComposer("filled draft")}>fillComposer</button>
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
      <span data-testid="active-role">{c.activeRole}</span>
      <span data-testid="composer-seed">{c.composerSeed}</span>
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
      {c.context.items.map((item) => (
        <button
          key={`${item.kind}:${item.entityId}`}
          onClick={() => c.removeContextItem(item.kind, item.entityId)}
        >
          {`remove:${item.entityId}`}
        </button>
      ))}
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
      <button
        onClick={() =>
          c.setPasteChip({ id: "p1", text: "body", chars: 4, truncated: false })
        }
      >
        setPaste
      </button>
      <button
        onClick={() =>
          void c.startNewConversation({
            explicit: { connectionId: "c9", model: "m9" },
            carry: true,
          })
        }
      >
        carryModel
      </button>
      <span data-testid="sidebar">{String(expanded)}</span>
      <span data-testid="state">{`${c.isOpen}|${c.approvalPending}|${c.interruptedTurn}|${holder}|${c.preflight.ok}`}</span>
      <span data-testid="preflight-dismissed">{String(c.preflight.dismissed)}</span>
      <span data-testid="identity">{JSON.stringify(c.identity)}</span>
      <span data-testid="composer-nonce">{c.composerNonce}</span>
      <span data-testid="panel-expanded">{String(c.isPanelExpanded)}</span>
      <span data-testid="review-stream">{c.toolStreams["rv1"] ?? ""}</span>
      <span data-testid="job-writes">{c.jobWrites}</span>
      <span data-testid="paste-chip">{c.pasteChip?.text ?? ""}</span>
      <span data-testid="context-usage">
        {c.contextUsage ? `${c.contextUsage.estimatedInputTokens}:${c.contextUsage.droppedTurnCount}` : ""}
      </span>
    </div>
  );
}

const conversation = (messages: any[] = [], agentRole: AgentRole | null = null) => ({
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
  agentRole,
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
    agentRole: "pilot" as const,
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
    // mockReset also drops queued once-implementations — a resolve that a
    // previous test armed but never fired must not answer this test's call.
    vi.mocked(resolveDraftPageContext).mockReset();
    // Slot storage is per-test state; leftovers would silently pick the
    // mount role and stored contexts the test never set up.
    window.localStorage.clear();
    chat.messages = [];
    chat.status = "ready";
    chat.error = undefined;
    currentPathname = "/dashboard/myjobs";
  });

  it("seeds useChat with the persisted transcript", () => {
    setup([{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
    expect(chatInit().messages).toHaveLength(1);
  });

  // The mount slot comes from the loaded conversation's persisted role;
  // NULL rows slot under Pilot.
  it("activates the Pilot slot for a pre-multi-agent conversation", () => {
    setup();
    expect(screen.getByTestId("active-role").textContent).toBe("pilot");
  });

  it("activates the conversation's own role slot on mount", () => {
    render(
      <SidebarProvider initialExpanded>
        <RightRailProvider>
          <AgentChatProvider initialConversation={conversation([], "insight")}>
            <Probe />
          </AgentChatProvider>
        </RightRailProvider>
      </SidebarProvider>,
    );
    expect(screen.getByTestId("active-role").textContent).toBe("insight");
  });

  // Each role keeps its own conversation slot: switching away and back
  // restores the conversation that slot last had active.
  it("restores each role's own slot across a switch", async () => {
    // conv-1 (role reflect) mounts into the reflect slot; the switch away
    // snapshots it, and the switch back reloads the same row.
    render(
      <SidebarProvider initialExpanded>
        <RightRailProvider>
          <AgentChatProvider initialConversation={conversation([], "reflect")}>
            <Probe />
          </AgentChatProvider>
        </RightRailProvider>
      </SidebarProvider>,
    );
    vi.mocked(getChatConversation).mockResolvedValueOnce({
      success: true,
      data: conversation([], "reflect"),
    });
    await userEvent.click(screen.getByText("switchInsight"));
    expect(screen.getByTestId("active-role").textContent).toBe("insight");
    expect(screen.getByTestId("conversation-id").textContent).toBe("");

    await userEvent.click(screen.getByText("switchReflect"));
    await waitFor(() =>
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-1"),
    );
    expect(getChatConversation).toHaveBeenCalledWith("conv-1");
  });

  it("switches to a role's empty slot as a draft without touching history", async () => {
    setup();
    await userEvent.click(screen.getByText("switchInsight"));
    expect(screen.getByTestId("active-role").textContent).toBe("insight");
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(getChatConversation).not.toHaveBeenCalled();
  });

  // open({role}) is the homepage wiring point — it opens the panel and
  // moves to that role's slot, without sending or creating anything.
  it("open({role}) activates that role's slot without a send or a create", async () => {
    setup();
    await userEvent.click(screen.getByText("openReflect"));
    expect(screen.getByTestId("active-role").textContent).toBe("reflect");
    expect(screen.getByTestId("state").textContent).toContain("true|");
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(createChatConversation).not.toHaveBeenCalled();
  });

  // Selecting a NULL conversation from history activates the general slot.
  it("selecting a legacy conversation activates the Pilot slot", async () => {
    render(
      <SidebarProvider initialExpanded>
        <RightRailProvider>
          <AgentChatProvider initialConversation={conversation([], "insight")}>
            <Probe />
          </AgentChatProvider>
        </RightRailProvider>
      </SidebarProvider>,
    );
    expect(screen.getByTestId("active-role").textContent).toBe("insight");
    vi.mocked(getChatConversation).mockResolvedValueOnce({
      success: true,
      data: { ...conversation(), id: "conv-2", revision: 8 },
    });
    await userEvent.click(screen.getByText("switchConversation"));
    await waitFor(() =>
      expect(screen.getByTestId("active-role").textContent).toBe("pilot"),
    );
  });

  // A slot that never stored a context is a fresh draft: switching to it on
  // an object page resolves that page's AUTO item (contract §5.3/§6.2).
  it("auto-attaches the current page object when switching to a fresh role slot", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const { rerender } = render(draftTree());
    currentPathname = "/dashboard/myjobs/job-9";
    act(() => rerender(draftTree()));
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        items: [
          {
            kind: "job",
            entityId: "job-9",
            labelSnapshot: "Job 9",
            source: "AUTO",
          },
        ],
      },
    } as never);
    await userEvent.click(screen.getByText("switchInsight"));
    await waitFor(() =>
      expect(screen.getByTestId("context-items").textContent).toContain(
        "job:job-9",
      ),
    );
    window.localStorage.clear();
  });

  it("does not activate or send a conversation created after switching roles", async () => {
    let resolve!: (value: ReturnType<typeof createdSnapshot>) => void;
    vi.mocked(createChatConversation).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(draftTree());
    await userEvent.click(screen.getByText("switchInsight"));
    await userEvent.click(screen.getByText("sendMessage"));
    await userEvent.click(screen.getByText("switchReflect"));
    await act(async () => resolve(createdSnapshot("late-insight")));
    expect(screen.getByTestId("active-role")).toHaveTextContent("reflect");
    expect(screen.getByTestId("conversation-id")).toBeEmptyDOMElement();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a superseded role load and preserves its saved conversation pointer", async () => {
    window.localStorage.setItem("agent-chat-role-slots", JSON.stringify({
      insight: { conversationId: "conv-insight", draft: "insight draft" },
    }));
    let resolve!: (value: Awaited<ReturnType<typeof getChatConversation>>) => void;
    vi.mocked(getChatConversation).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    setup();
    await userEvent.click(screen.getByText("switchInsight"));
    await userEvent.click(screen.getByText("switchReflect"));
    await userEvent.click(screen.getByText("fillComposer"));
    await act(async () => resolve({ success: true, data: { ...conversation([], "insight"), id: "conv-insight" } }));
    expect(screen.getByTestId("active-role")).toHaveTextContent("reflect");
    expect(screen.getByTestId("composer-seed")).toHaveTextContent("filled draft");
    expect(screen.getByTestId("conversation-id")).toBeEmptyDOMElement();
    expect(JSON.parse(localStorage.getItem("agent-chat-role-slots")!).insight.conversationId).toBe("conv-insight");
  });

  it("restores the active draft role after refresh without a persisted initial row", async () => {
    const mounted = setup();
    await userEvent.click(screen.getByText("switchReflect"));
    expect(document.cookie).toContain("agent-chat-active-id=__draft__");
    mounted.unmount();
    render(draftTree());
    expect(screen.getByTestId("active-role")).toHaveTextContent("reflect");
    expect(screen.getByTestId("conversation-id")).toBeEmptyDOMElement();
  });

  it.each(["mount", "new"])("ignores late %s AUTO context after a role switch", async (mode) => {
    currentPathname = mode === "mount" ? "/dashboard/myjobs/job-old" : "/dashboard/myjobs";
    let resolve!: (value: Awaited<ReturnType<typeof resolveDraftPageContext>>) => void;
    vi.mocked(resolveDraftPageContext).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { rerender } = render(draftTree());
    if (mode === "new") {
      currentPathname = "/dashboard/myjobs/job-old";
      // pathnameRef only follows renders — rerender after changing the
      // mocked pathname so the new draft resolves against the new route.
      act(() => rerender(draftTree()));
      await userEvent.click(screen.getByText("newConversation"));
    }
    currentPathname = "/dashboard/myjobs";
    act(() => rerender(draftTree()));
    await userEvent.click(screen.getByText("switchReflect"));
    await act(async () => resolve({ success: true, data: { version: 1, items: [{ kind: "job", entityId: "job-old", labelSnapshot: "Old", source: "AUTO" }] } }));
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
  });

  it.each([true, false])("ignores late context update success=%s after switching roles", async (success) => {
    let resolve!: (value: Awaited<ReturnType<typeof updateChatConversationContext>>) => void;
    vi.mocked(updateChatConversationContext).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    setup();
    await userEvent.click(screen.getByText("addContext"));
    await userEvent.click(screen.getByText("switchReflect"));
    await act(async () => resolve(success
      ? { success: true, data: { version: 1, items: [{ kind: "job", entityId: "late-job", labelSnapshot: "Late", source: "MANUAL" }] } }
      : { success: false, code: "GENERIC" }));
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(screen.getByTestId("action-error")).toBeEmptyDOMElement();
  });

  // A restored draft already owns its objects — mounting it must not
  // re-resolve the current page over the stored context.
  it("keeps a restored slot context instead of re-resolving the page", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("agent-chat-active-role", "insight");
    window.localStorage.setItem(
      "agent-chat-role-slots",
      JSON.stringify({
        insight: {
          conversationId: null,
          draft: null,
          context: {
            version: 1,
            items: [
              {
                kind: "job",
                entityId: "kept-job",
                labelSnapshot: "Kept",
                source: "MANUAL",
              },
            ],
          },
        },
      }),
    );
    currentPathname = "/dashboard/myjobs/job-9";
    render(draftTree());
    expect(screen.getByTestId("context-items").textContent).toContain(
      "job:kept-job",
    );
    expect(vi.mocked(resolveDraftPageContext)).not.toHaveBeenCalled();
    window.localStorage.clear();
  });

  // DEFECT-001: a passive snapshot must not persist an unresolved draft's
  // EMPTY context — a stored context is what marks a slot resolved, so the
  // placeholder permanently disarmed AUTO attach on every later mount.
  it("resolves the page object for an unresolved draft after a passive snapshot", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const mounted = render(draftTree());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    // The snapshot ran, but an unresolved draft owns no context — the slot
    // stays fresh (pre-fix it stored {version:1,items:[]}).
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.pilot?.context).toBeUndefined();
    mounted.unmount();

    currentPathname = "/dashboard/myjobs/job-9";
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        items: [
          {
            kind: "job",
            entityId: "job-9",
            labelSnapshot: "Job 9",
            source: "AUTO",
          },
        ],
      },
    } as never);
    render(draftTree());
    await waitFor(() =>
      expect(screen.getByTestId("context-items")).toHaveTextContent(
        "job:job-9",
      ),
    );
    expect(resolveDraftPageContext).toHaveBeenCalledWith({
      jobId: "job-9",
      resumeId: null,
    });
    window.localStorage.clear();
  });

  // The same poisoning ran through switchRole's outgoing snapshot and its
  // incoming slot rewrite — an unresolved draft round-trips fresh.
  it("keeps an unresolved draft fresh across a role switch so switching back resolves", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const { rerender } = render(draftTree());
    await userEvent.click(screen.getByText("switchInsight"));
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    currentPathname = "/dashboard/myjobs/job-9";
    act(() => rerender(draftTree()));
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        items: [
          {
            kind: "job",
            entityId: "job-9",
            labelSnapshot: "Job 9",
            source: "AUTO",
          },
        ],
      },
    } as never);
    await userEvent.click(screen.getByText("switchPilot"));
    await waitFor(() =>
      expect(screen.getByTestId("context-items")).toHaveTextContent(
        "job:job-9",
      ),
    );
    expect(screen.getByTestId("active-role")).toHaveTextContent("pilot");
    window.localStorage.clear();
  });

  // "User cleared every chip" is a settled empty context, not an unresolved
  // draft — refresh and a slot round-trip must not re-attach the page object.
  it("does not re-resolve after the user explicitly clears a draft's context", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard/myjobs/job-9";
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        items: [
          {
            kind: "job",
            entityId: "job-9",
            labelSnapshot: "Job 9",
            source: "AUTO",
          },
        ],
      },
    } as never);
    const mounted = render(draftTree());
    await waitFor(() =>
      expect(screen.getByTestId("context-items")).toHaveTextContent(
        "job:job-9",
      ),
    );
    await userEvent.click(screen.getByText("remove:job-9"));
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    mounted.unmount();

    render(draftTree());
    await act(async () => {});
    expect(resolveDraftPageContext).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    await userEvent.click(screen.getByText("switchReflect"));
    await userEvent.click(screen.getByText("switchPilot"));
    // Reflect was fresh and resolved once; the pilot slot kept its cleared
    // context and never re-resolved.
    expect(resolveDraftPageContext).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("active-role")).toHaveTextContent("pilot");
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    window.localStorage.clear();
  });

  // A user-attached item is owned by the draft: it survives the passive
  // snapshot and blocks page resolution like any settled context.
  it("persists a manually attached draft context across snapshots without re-resolving", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const mounted = render(draftTree());
    await userEvent.click(screen.getByText("addContext"));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.pilot?.context?.items?.[0]?.entityId).toBe("job-1");
    mounted.unmount();

    currentPathname = "/dashboard/myjobs/job-9";
    render(draftTree());
    await act(async () => {});
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-1");
    window.localStorage.clear();
  });

  // Persisted conversations still snapshot their stored context — the
  // unsettled gate only applies to drafts that never resolved.
  it("still snapshots a persisted conversation's context", async () => {
    window.localStorage.clear();
    setup();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.pilot?.conversationId).toBe("conv-1");
    expect(slots.pilot?.context).toEqual({ version: 1, items: [] });
    window.localStorage.clear();
  });

  // A resolve in flight when the slot is superseded lands on the epoch
  // guard — it neither repaints the new state nor back-fills the slot.
  it("ignores a late AUTO resolve after switching to another fresh role", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const { rerender } = render(draftTree());
    currentPathname = "/dashboard/myjobs/job-9";
    act(() => rerender(draftTree()));
    let resolveInsight!: (
      value: Awaited<ReturnType<typeof resolveDraftPageContext>>,
    ) => void;
    vi.mocked(resolveDraftPageContext).mockReturnValueOnce(
      new Promise((done) => {
        resolveInsight = done;
      }),
    );
    await userEvent.click(screen.getByText("switchInsight"));
    await userEvent.click(screen.getByText("switchReflect"));
    await waitFor(() =>
      expect(screen.getByTestId("active-role")).toHaveTextContent("reflect"),
    );
    await act(async () =>
      resolveInsight({
        success: true,
        data: {
          version: 1,
          items: [
            {
              kind: "job",
              entityId: "job-9",
              labelSnapshot: "Late",
              source: "AUTO",
            },
          ],
        },
      }),
    );
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.insight?.context).toBeUndefined();
    window.localStorage.clear();
  });

  // Same guard, different successor: a conversation load wins the epoch and
  // keeps its own context, and the superseded draft stores nothing.
  it("ignores a late AUTO resolve after selecting a conversation", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard";
    const { rerender } = render(draftTree());
    currentPathname = "/dashboard/myjobs/job-9";
    act(() => rerender(draftTree()));
    let resolveInsight!: (
      value: Awaited<ReturnType<typeof resolveDraftPageContext>>,
    ) => void;
    vi.mocked(resolveDraftPageContext).mockReturnValueOnce(
      new Promise((done) => {
        resolveInsight = done;
      }),
    );
    await userEvent.click(screen.getByText("switchInsight"));
    vi.mocked(getChatConversation).mockResolvedValueOnce({
      success: true,
      data: {
        ...conversation(),
        id: "conv-2",
        context: {
          version: 1,
          items: [
            {
              kind: "job",
              entityId: "conv-job",
              labelSnapshot: "Conv",
              source: "MANUAL",
            },
          ],
        },
      },
    });
    await userEvent.click(screen.getByText("switchConversation"));
    await waitFor(() =>
      expect(screen.getByTestId("conversation-id")).toHaveTextContent(
        "conv-2",
      ),
    );
    await act(async () =>
      resolveInsight({
        success: true,
        data: {
          version: 1,
          items: [
            {
              kind: "job",
              entityId: "job-9",
              labelSnapshot: "Late",
              source: "AUTO",
            },
          ],
        },
      }),
    );
    expect(screen.getByTestId("context-items")).toHaveTextContent(
      "job:conv-job",
    );
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.insight?.context).toBeUndefined();
    window.localStorage.clear();
  });

  // A stored id pointing at an archived row degrades to the role's draft —
  // the archived conversation never opens as the active slot.
  it("degrades to the role draft when the stored conversation is archived", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "agent-chat-role-slots",
      JSON.stringify({
        insight: { conversationId: "conv-arch", draft: "still here" },
      }),
    );
    render(draftTree());
    vi.mocked(getChatConversation).mockResolvedValueOnce({
      success: true,
      data: {
        ...conversation([], "insight"),
        id: "conv-arch",
        archivedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    await userEvent.click(screen.getByText("switchInsight"));
    await waitFor(() =>
      expect(screen.getByTestId("active-role").textContent).toBe("insight"),
    );
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("composer-seed").textContent).toBe("still here");
    window.localStorage.clear();
  });

  // Unsent composer text belongs to the slot, not the switch: it comes back
  // when the slot's conversation reloads.
  it("restores a conversation slot's unsent composer text on switch", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "agent-chat-role-slots",
      JSON.stringify({
        insight: { conversationId: "conv-9", draft: "unsent reply" },
      }),
    );
    render(draftTree());
    vi.mocked(getChatConversation).mockResolvedValueOnce({
      success: true,
      data: { ...conversation([], "insight"), id: "conv-9" },
    });
    await userEvent.click(screen.getByText("switchInsight"));
    await waitFor(() =>
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-9"),
    );
    expect(screen.getByTestId("composer-seed").textContent).toBe("unsent reply");
    window.localStorage.clear();
  });

  // A reload mounts the last active conversation — its stored unsent draft
  // comes back with it when the slot names the same row.
  it("restores the stored draft text for the conversation mounted on load", () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "agent-chat-role-slots",
      JSON.stringify({
        pilot: { conversationId: "conv-1", draft: "typed before reload" },
      }),
    );
    setup();
    expect(screen.getByTestId("composer-seed").textContent).toBe(
      "typed before reload",
    );
    window.localStorage.clear();
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

  // The composer fill channel only writes the input — nothing sends, and
  // nothing persists a conversation off the back of a suggestion click.
  it("fillComposer writes the composer seed without a request or a create", async () => {
    render(draftTree());
    await userEvent.click(screen.getByText("fillComposer"));
    expect(screen.getByTestId("composer-seed").textContent).toBe("filled draft");
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(createChatConversation).not.toHaveBeenCalled();
  });

  // createPersisted stamps the active slot's role on the new row — the one
  // place the client declares a role; after that the row is the authority.
  it("creates a draft-bound conversation stamped with the active role", async () => {
    (createChatConversation as any).mockResolvedValueOnce(createdSnapshot("conv-new"));
    render(draftTree());
    await userEvent.click(screen.getByText("switchReflect"));
    await userEvent.click(screen.getByText("sendMessage"));
    await waitFor(() => {
      expect(createChatConversation).toHaveBeenCalledTimes(1);
    });
    expect((createChatConversation as any).mock.calls[0][0].agentRole).toBe("reflect");
  });

  // AWU-MODEL (D1): a model pick on a persisted conversation is a carry —
  // the draft text, MANUAL context and paste chip move to the new draft
  // because none of them belonged to the old model. AUTO context is not
  // carried: it re-resolves against the page like any new draft.
  const manualContextConversation = () => ({
    ...conversation(),
    context: {
      version: 1 as const,
      items: [
        { kind: "job" as const, entityId: "job-1", labelSnapshot: "Acme", source: "MANUAL" as const },
      ],
    },
  });
  const manualContextTree = () => (
    <SidebarProvider initialExpanded>
      <RightRailProvider>
        <AgentChatProvider initialConversation={manualContextConversation()}>
          <Probe />
        </AgentChatProvider>
      </RightRailProvider>
    </SidebarProvider>
  );

  it("carries draft text, MANUAL context and the paste chip across a model switch", async () => {
    window.localStorage.clear();
    render(manualContextTree());
    await userEvent.click(screen.getByText("fillComposer"));
    await userEvent.click(screen.getByText("setPaste"));
    await userEvent.click(screen.getByText("carryModel"));

    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("composer-seed").textContent).toBe("filled draft");
    expect(screen.getByTestId("paste-chip").textContent).toBe("body");
    expect(screen.getByTestId("context-items").textContent).toBe("job:job-1");
    expect(screen.getByTestId("explicit-model").textContent).toBe("c9/m9");
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.pilot?.draft).toBe("filled draft");
    expect(slots.pilot?.paste?.text).toBe("body");
    expect(slots.pilot?.context?.items?.[0]?.entityId).toBe("job-1");
    expect(slots.pilot?.explicit).toEqual({ connectionId: "c9", model: "m9" });
    window.localStorage.clear();
  });

  // A carried MANUAL context merges with the AUTO resolution on the same
  // page instead of being replaced by it.
  it("merges carried MANUAL context with the page's AUTO resolution", async () => {
    window.localStorage.clear();
    currentPathname = "/dashboard/myjobs/job-9";
    render(manualContextTree());
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        items: [
          { kind: "job", entityId: "job-9", labelSnapshot: "Job 9", source: "AUTO" },
        ],
      },
    } as never);
    await userEvent.click(screen.getByText("carryModel"));
    await waitFor(() =>
      expect(screen.getByTestId("context-items").textContent).toContain("job:job-9"),
    );
    expect(screen.getByTestId("context-items").textContent).toContain("job:job-1");
    expect(resolveDraftPageContext).toHaveBeenCalledWith({ jobId: "job-9", resumeId: null });
    window.localStorage.clear();
  });

  // A plain New Conversation still starts empty — carry is opt-in.
  it("starts an empty draft when carry is not requested", async () => {
    window.localStorage.clear();
    setup();
    await userEvent.click(screen.getByText("fillComposer"));
    await userEvent.click(screen.getByText("setPaste"));
    await userEvent.click(screen.getByText("newConversation"));
    expect(screen.getByTestId("composer-seed").textContent).toBe("");
    expect(screen.getByTestId("paste-chip").textContent).toBe("");
    window.localStorage.clear();
  });

  // The chip serializes with the slot's draft so a role switch round-trips
  // it — the card belongs to the slot, not the composer's lifetime.
  it("round-trips the paste chip across a role switch", async () => {
    window.localStorage.clear();
    render(draftTree());
    await userEvent.click(screen.getByText("setPaste"));
    await userEvent.click(screen.getByText("switchInsight"));
    expect(screen.getByTestId("paste-chip").textContent).toBe("");
    const slots = JSON.parse(
      localStorage.getItem("agent-chat-role-slots") ?? "{}",
    );
    expect(slots.pilot?.paste?.text).toBe("body");
    await userEvent.click(screen.getByText("switchPilot"));
    expect(screen.getByTestId("paste-chip").textContent).toBe("body");
    window.localStorage.clear();
  });

  // A stored chip mounts with the slot's conversation — the unsent card
  // survives a reload exactly like the unsent draft text.
  it("restores a stored paste chip on mount", () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "agent-chat-role-slots",
      JSON.stringify({
        pilot: {
          conversationId: "conv-1",
          draft: "typed",
          paste: { id: "p9", text: "stored body", chars: 11, truncated: false },
        },
      }),
    );
    setup();
    expect(screen.getByTestId("paste-chip").textContent).toBe("stored body");
    expect(screen.getByTestId("composer-seed").textContent).toBe("typed");
    window.localStorage.clear();
  });

  // AWU-CONTEXT: the toolbar estimate comes straight off the wire — a
  // data-context-usage part for the active request. Legacy turns never
  // emit it, so the absence of a number is itself the honest answer.
  it("stores the streamed context usage for the toolbar", async () => {
    setup();
    const execution = beginExecution();
    await act(async () => {
      chatInit().onData({
        type: "data-context-usage",
        data: {
          conversationId: "conv-1",
          requestId: execution.requestId,
          profile: "fresh",
          estimatedInputTokens: 3200,
          recentTurnCount: 2,
          droppedTurnCount: 1,
          tokens: { system: 1, currentUser: 1, history: 1, explicitContext: 1, toolResult: 1, summary: 0, dynamic: 2 },
          budgets: { assembledInputTokens: 16000, dynamicTokens: 6000, explicitContextTokens: 2000, historyTokens: 3000, historicalToolTokens: 2000, currentUserTokens: 6000, summaryTokens: 1000 },
        },
      });
    });
    expect(screen.getByTestId("context-usage").textContent).toBe("3200:1");
    // A stale request's usage must not overwrite the live one.
    await act(async () => {
      chatInit().onData({
        type: "data-context-usage",
        data: {
          conversationId: "conv-1",
          requestId: "stale-request",
          profile: "fresh",
          estimatedInputTokens: 9999,
          recentTurnCount: 0,
          droppedTurnCount: 0,
          tokens: { system: 0, currentUser: 0, history: 0, explicitContext: 0, toolResult: 0, summary: 0, dynamic: 0 },
          budgets: { assembledInputTokens: 16000, dynamicTokens: 6000, explicitContextTokens: 2000, historyTokens: 3000, historicalToolTokens: 2000, currentUserTokens: 6000, summaryTokens: 1000 },
        },
      });
    });
    expect(screen.getByTestId("context-usage").textContent).toBe("3200:1");
    // And it clears with the conversation state on a new draft.
    await userEvent.click(screen.getByText("newConversation"));
    expect(screen.getByTestId("context-usage").textContent).toBe("");
  });
});


const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function slotBridge() {
  const users = new Map<string, string>();
  let failWrites = 0;
  const api = {
    read: (userId: string) => users.get(userId) ?? null,
    write: (userId: string, raw: string) => {
      if (failWrites > 0) {
        failWrites -= 1;
        return { ok: false as const, code: "unavailable" as const };
      }
      const next = JSON.parse(raw) as { generation: number };
      const existing = users.get(userId);
      if (existing && JSON.parse(existing).generation >= next.generation) {
        return { ok: false as const, code: "stale" as const };
      }
      users.set(userId, raw);
      return { ok: true as const };
    },
  };
  window.vocatryaAgentSlots = api;
  return {
    users,
    failNext() {
      failWrites += 1;
    },
    record(userId: string) {
      const raw = users.get(userId);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

const ownedTree = (userId: string) => (
  <SidebarProvider initialExpanded>
    <RightRailProvider>
      <AgentChatProvider userId={userId}>
        <Probe />
      </AgentChatProvider>
    </RightRailProvider>
  </SidebarProvider>
);

const autoJob = {
  success: true,
  data: {
    version: 1 as const,
    items: [{ kind: "job" as const, entityId: "job-9", labelSnapshot: "Job 9", source: "AUTO" as const }],
  },
};

describe("agent slots across a new loopback origin", () => {
  let bridge: ReturnType<typeof slotBridge>;

  beforeEach(() => {
    localStorage.clear();
    resetAgentSlotPersistenceForTests();
    bridge = slotBridge();
    currentPathname = "/dashboard/myjobs/job-9";
    vi.mocked(resolveDraftPageContext).mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    resetAgentSlotPersistenceForTests();
    delete window.vocatryaAgentSlots;
  });

  function newOrigin() {
    localStorage.clear();
  }

  it("restores an explicit clear on a new origin and does not AUTO-mount", async () => {
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce(autoJob as never);
    const mounted = render(ownedTree(USER_A));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    await userEvent.click(screen.getByText("remove:job-9"));
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(bridge.record(USER_A).slots.pilot.context).toEqual({ version: 1, items: [] });
    mounted.unmount();
    newOrigin();

    render(ownedTree(USER_A));
    await act(async () => {});
    expect(resolveDraftPageContext).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
  });

  it("still resolves a fresh draft, and New Conversation can attach AUTO again", async () => {
    currentPathname = "/dashboard";
    const first = render(ownedTree(USER_A));
    await act(async () => {});
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    first.unmount();
    newOrigin();
    currentPathname = "/dashboard/myjobs/job-9";
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce(autoJob as never);
    const second = render(ownedTree(USER_A));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    await userEvent.click(screen.getByText("remove:job-9"));
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce(autoJob as never);
    await userEvent.click(screen.getByText("newConversation"));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    expect(bridge.record(USER_A).slots.pilot.context.items).toEqual([
      expect.objectContaining({ entityId: "job-9", source: "AUTO" }),
    ]);
    second.unmount();
    newOrigin();
    render(ownedTree(USER_A));
    await act(async () => {});
    expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9");
  });

  it("keeps each role, a manual context, and a persisted session on the new origin", async () => {
    bridge.users.set(USER_A, JSON.stringify({
      generation: 3,
      activeRole: "pilot",
      slots: {
        pilot: {
          conversationId: "conv-9",
          draft: "pilot draft",
          context: { version: 1, items: [] },
          explicit: null,
        },
        insight: {
          conversationId: null,
          draft: "insight draft",
          context: {
            version: 1,
            items: [{ kind: "job", entityId: "job-manual", labelSnapshot: "Manual", source: "MANUAL" }],
          },
          explicit: null,
        },
      },
    }));
    render(ownedTree(USER_A));
    await act(async () => {});
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-role")).toHaveTextContent("pilot");
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(screen.getByTestId("composer-seed")).toHaveTextContent("pilot draft");
    await userEvent.click(screen.getByText("switchInsight"));
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-manual");
    expect(screen.getByTestId("composer-seed")).toHaveTextContent("insight draft");
    expect(JSON.parse(localStorage.getItem("agent-chat-role-slots") ?? "{}").pilot.conversationId).toBe("conv-9");
  });

  it("does not let a second user or a late restore replace the cleared slot", async () => {
    vi.mocked(resolveDraftPageContext).mockResolvedValue(autoJob as never);
    const first = render(ownedTree(USER_A));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    const beforeClear = currentAgentSlotGeneration();
    await userEvent.click(screen.getByText("remove:job-9"));
    const saved = bridge.users.get(USER_A);
    bridge.users.set(USER_A, JSON.stringify({
      generation: 99,
      activeRole: "pilot",
      slots: {
        pilot: {
          conversationId: null,
          draft: null,
          context: autoJob.data,
          explicit: null,
        },
      },
    }));
    bindAgentSlotOwner(USER_A);
    expect(restoreDurableAgentSlots(USER_A, beforeClear)).toBe("stale");
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(JSON.parse(localStorage.getItem("agent-chat-role-slots") ?? "{}").pilot.context.items).toEqual([]);
    bridge.users.set(USER_A, saved!);
    first.unmount();

    render(ownedTree(USER_B));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    expect(bridge.record(USER_A).slots.pilot.context.items).toEqual([]);
    expect(bridge.record(USER_B).slots.pilot.context.items[0].entityId).toBe("job-9");
  });

  it("keeps a legacy empty slot cleared and mirrors it for the next origin", async () => {
    localStorage.setItem("agent-chat-active-role", "pilot");
    localStorage.setItem("agent-chat-role-slots", JSON.stringify({
      pilot: { conversationId: null, draft: null, context: { version: 1, items: [] }, explicit: null },
    }));
    const first = render(ownedTree(USER_A));
    await act(async () => {});
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(bridge.record(USER_A).slots.pilot.context.items).toEqual([]);
    first.unmount();
    newOrigin();
    render(ownedTree(USER_A));
    await act(async () => {});
    expect(resolveDraftPageContext).not.toHaveBeenCalled();
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
  });

  it("retries the clear on quit after a failed mirror without rolling back the chips", async () => {
    vi.mocked(resolveDraftPageContext).mockResolvedValueOnce(autoJob as never);
    render(ownedTree(USER_A));
    await waitFor(() => expect(screen.getByTestId("context-items")).toHaveTextContent("job:job-9"));
    bridge.failNext();
    await userEvent.click(screen.getByText("remove:job-9"));
    expect(screen.getByTestId("context-items")).toBeEmptyDOMElement();
    expect(bridge.record(USER_A).slots.pilot.context.items[0].entityId).toBe("job-9");
    expect(JSON.parse(localStorage.getItem("agent-chat-role-slots") ?? "{}").pilot.context.items).toEqual([]);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(bridge.record(USER_A).slots.pilot.context).toEqual({ version: 1, items: [] });
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
