import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("@/components/brand/motion", () => ({
  mountVocatryaMotion: () => ({ setState: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("@/components/agent/empty-state-motion", () => ({
  mountEmptyStateMotion: () => ({ setState: vi.fn(), dispose: vi.fn() }),
}));

const chat = {
  messages: [] as any[],
  status: "ready" as string,
  error: undefined as Error | undefined,
  sendMessage: vi.fn(),
  stop: vi.fn(),
  regenerate: vi.fn(),
  clearError: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  setMessages: vi.fn(),
};
vi.mock("@ai-sdk/react", () => ({
  useChat: () => chat,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/dashboard/myjobs",
}));

vi.mock("@/actions/agentChat.actions", () => ({
  clearChatConversation: vi.fn(async () => ({ success: true })),
  deleteChatConversation: vi.fn(async () => ({ success: true })),
  saveChatConversation: vi.fn(async () => ({ success: true })),
  createChatConversation: vi.fn(async () => ({ success: false })),
  getChatConversation: vi.fn(async () => ({ success: false })),
  listChatConversations: vi.fn(async () => ({ success: true, data: [] })),
  listAgentContextOptions: vi.fn(async () => ({
    success: true,
    data: { jobs: [], resumes: [] },
  })),
  listEligibleChatModels: vi.fn(async () => ({ success: true, data: [] })),
  updateChatConversationContext: vi.fn(async () => ({ success: true })),
  resolveDraftPageContext: vi.fn(async () => ({
    success: true,
    data: { version: 1, items: [] },
  })),
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
vi.mock("@/lib/toast", () => ({ toastInfo: vi.fn() }));

import { AgentChatProvider } from "@/components/agent/AgentChatProvider";
import { AgentChatPanel } from "@/components/agent/AgentChatPanel";
import { AgentChatTrigger } from "@/components/AgentChatTrigger";
import { RightRailProvider, useRightRail } from "@/context/RightRailContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { toastInfo } from "@/lib/toast";

function OtherPanel() {
  const { requestOpen } = useRightRail();
  return <button onClick={() => requestOpen("review")}>open review</button>;
}

const setup = (initialMessages: any[] = []) =>
  render(
    <SidebarProvider initialExpanded>
      <RightRailProvider>
        <AgentChatProvider initialMessages={initialMessages}>
          <AgentChatTrigger />
          <OtherPanel />
          <AgentChatPanel />
        </AgentChatProvider>
      </RightRailProvider>
    </SidebarProvider>,
  );

const openPanel = async () => {
  await act(async () => {
    await userEvent.click(screen.getByRole("button", { name: /open assistant/i }));
  });
};

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

const reviewRunningMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "tool-review_resume",
      toolCallId: "rv1",
      state: "input-available",
      input: {},
    },
  ],
};

describe("agent chat close paths", () => {
  it("gives idle motion only to the central presence while the transcript is empty", async () => {
    chat.status = "ready";
    setup();
    await openPanel();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("svg[width='26']")).toHaveAttribute("data-animated", "false");
    expect(dialog.querySelector("svg[width='26']")).toHaveAttribute("data-state", "idle");
    expect(dialog.querySelector("svg[width='72']")).toHaveAttribute("data-state", "idle");
  });

  it("hides the central presence after a user message and gives thinking to the header", async () => {
    const message = { id: "first", role: "user", parts: [{ type: "text", text: "Hello" }] };
    chat.messages = [message];
    setup([message]);
    await openPanel();
    const dialog = screen.getByRole("dialog");
    expect(screen.queryByTestId("agent-empty-state")).not.toBeInTheDocument();
    expect(dialog.querySelector("svg[width='26']")).toHaveAttribute("data-animated", "true");
    expect(dialog.querySelector("svg[width='26']")).toHaveAttribute("data-state", "thinking");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    chat.messages = [];
    chat.status = "streaming";
    chat.error = undefined;
  });

  // Collapsing the panel is only a view change: the provider stays mounted
  // at the layout root, so an in-flight turn keeps streaming in the
  // background. Stop is solely the explicit Stop button.
  it("keeps the stream running when the panel's close button is used", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    });
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it("keeps the stream running on Escape", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it("keeps the stream running when another panel takes the right rail", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByText("open review"));
    });
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it("keeps the stream running when the Header trigger toggles it shut", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: /close assistant/i }),
      );
    });
    expect(chat.stop).not.toHaveBeenCalled();
  });

  it("shows the still-running turn when the panel reopens mid-stream", async () => {
    const message = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
    chat.messages = [message];
    setup([message]);
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    });
    expect(chat.stop).not.toHaveBeenCalled();
    await openPanel();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("svg[width='26']")).toHaveAttribute("data-state", "thinking");
  });

  it("flags a pending approval on the trigger", () => {
    chat.messages = [approvalMessage];
    setup([approvalMessage]);
    expect(screen.getByLabelText("Approval pending")).toBeInTheDocument();
  });

  // The trigger carries no streaming badge — generation continuing in the
  // background changes nothing about its face.
  it("never advertises streaming on the trigger", () => {
    chat.status = "streaming";
    setup();
    expect(screen.queryByLabelText("Approval pending")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open assistant/i }).textContent,
    ).toBe("Chat AI");
  });

  // Closing no longer aborts anything, so it must stay silent.
  it("stays silent when a running stream keeps going after close", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("toasts when Clear aborts a stream", async () => {
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    });
    expect(vi.mocked(toastInfo).mock.calls[0]![0]).toMatch(/stopped/i);
  });

  // Both toasts are gated on an actual abort — closing or clearing an idle
  // panel interrupted nothing and must stay silent.
  it("stays silent when nothing was streaming", async () => {
    chat.status = "ready";
    setup();
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
      await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  // The nested generation lives inside the outer stream, and closing only
  // hides the panel — the review keeps running until it finishes.
  it("keeps a running nested review alive when the panel closes", async () => {
    chat.messages = [reviewRunningMessage];
    chat.status = "streaming";
    setup([reviewRunningMessage]);
    await openPanel();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    });
    expect(chat.stop).not.toHaveBeenCalled();
  });
});
