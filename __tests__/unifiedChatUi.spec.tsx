import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRole } from "@/lib/agent/agentRoles";
import type { AgentUnifiedStatusData } from "@/lib/agent/unifiedChatTypes";

const mockChat = {
  messages: [] as UIMessage[],
  toolStreams: {} as Record<string, string>,
  status: "ready" as "ready" | "submitted" | "streaming" | "error",
  regenerate: vi.fn(),
  reanswer: vi.fn(),
  retryStep: vi.fn(),
  nativeSession: false,
  addToolApprovalResponse: vi.fn(),
  approvalPending: false,
  conversationId: "conv-u4" as string | null,
  conversationTitle: "后端岗位求职咨询" as string | null,
  contextUsage: null,
  activeRole: "pilot" as AgentRole,
  unifiedStatus: null as AgentUnifiedStatusData | null,
  failedStep: null as {
    turnId: string;
    stepIndex: number;
    role: AgentRole;
    message?: string;
  } | null,
  isOpen: true,
  close: vi.fn(),
  startNewConversation: vi.fn(),
  restartNativeSession: vi.fn(),
  nativeStatus: "waiting" as const,
  brandCompletion: 0,
  error: undefined,
  actionError: null,
  panelWidth: 520,
  startResize: vi.fn(),
  isPanelExpanded: false,
  togglePanelExpand: vi.fn(),
};

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => mockChat,
}));

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}));

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";

describe("Unified Chat UI (Slice U4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChat.messages = [];
    mockChat.status = "ready";
    mockChat.approvalPending = false;
    mockChat.unifiedStatus = null;
    mockChat.failedStep = null;
  });

  it("renders per-message distinct avatars & role labels for compound multi-step turns", () => {
    mockChat.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "评估匹配度并建议待办" }] },
      {
        id: "a1",
        role: "assistant",
        metadata: { agentRole: "insight", turnId: "t1", stepIndex: 0, stepCount: 2 },
        parts: [{ type: "text", text: "匹配度 82 分，核心差距在分布式经验。" }],
      },
      {
        id: "a2",
        role: "assistant",
        metadata: { agentRole: "pilot", turnId: "t1", stepIndex: 1, stepCount: 2 },
        parts: [{ type: "text", text: "已整理今日待办建议供确认。" }],
      },
    ] as UIMessage[];

    render(<AgentChatMessages />);

    const headers = screen.getAllByTestId("agent-message-attribution");
    expect(headers).toHaveLength(2);
    expect(screen.getByTestId("agent-avatar-insight")).toBeInTheDocument();
    expect(screen.getByTestId("agent-avatar-pilot")).toBeInTheDocument();
    expect(headers[0]).toHaveTextContent("Insight");
    expect(headers[1]).toHaveTextContent("Pilot");
  });

  it("exposes reanswer menu with 3 action+role options and invokes reanswer(messageId, role)", async () => {
    const user = userEvent.setup();
    mockChat.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "聊聊这次面试" }] },
      {
        id: "a1",
        role: "assistant",
        metadata: { agentRole: "insight" },
        parts: [{ type: "text", text: "先从能力匹配角度看..." }],
      },
    ] as UIMessage[];

    render(<AgentChatMessages />);

    await user.click(screen.getByTestId("agent-reanswer-trigger"));
    expect(screen.getByTestId("agent-reanswer-pilot")).toBeInTheDocument();
    expect(screen.getByTestId("agent-reanswer-insight")).toBeInTheDocument();
    expect(screen.getByTestId("agent-reanswer-reflect")).toBeInTheDocument();

    await user.click(screen.getByTestId("agent-reanswer-reflect"));
    expect(mockChat.reanswer).toHaveBeenCalledWith("a1", "reflect");
  });

  it("renders neutral routing status (no role avatar), approval stop notice, and Step 2 retry banner", async () => {
    const user = userEvent.setup();
    mockChat.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "先记职位再分析" }] },
      {
        id: "a1",
        role: "assistant",
        metadata: {
          agentRole: "pilot",
          stepStatus: "BLOCKED_APPROVAL",
          skippedNextRole: "insight",
        },
        parts: [{ type: "text", text: "请先确认添加该职位。" }],
      },
    ] as UIMessage[];
    mockChat.failedStep = {
      turnId: "turn-99",
      stepIndex: 1,
      role: "pilot",
      message: "Upstream timeout",
    };

    const { rerender } = render(<AgentChatMessages />);

    expect(screen.getByTestId("agent-step-blocked-notice")).toBeInTheDocument();
    expect(screen.getByTestId("agent-step-failed-banner")).toBeInTheDocument();
    await user.click(screen.getByTestId("agent-retry-step"));
    expect(mockChat.retryStep).toHaveBeenCalledWith("turn-99", 1);

    // During Layer 1 routing, no new role avatar is pre-attached to the status row.
    mockChat.messages = [{ id: "u2", role: "user", parts: [{ type: "text", text: "帮我看看" }] }];
    mockChat.status = "streaming";
    mockChat.failedStep = null;
    mockChat.unifiedStatus = { phase: "routing" };
    rerender(<AgentChatMessages />);
    expect(screen.queryByTestId("agent-avatar-pilot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-avatar-insight")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-avatar-reflect")).not.toBeInTheDocument();
  });
});
