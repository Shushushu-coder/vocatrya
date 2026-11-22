import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listAgentTaskCards = vi.fn();
const resumeAgentTask = vi.fn();
const openTaskSession = vi.fn();
let chat: Record<string, unknown>;

vi.mock("@/actions/agentTask.actions", () => ({
  listAgentTaskCards: (...a: unknown[]) => listAgentTaskCards(...a),
  resumeAgentTask: (...a: unknown[]) => resumeAgentTask(...a),
}));
vi.mock("@/components/agent/AgentChatProvider", async () => {
  const { useState } = await import("react");
  return {
    useAgentChat: () => {
      const [selectedTaskId, setSelectedTaskId] = useState(null);
      return { ...chat, selectedTaskId, setSelectedTaskId };
    },
  };
});
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { AgentTaskCard } from "@/components/agent/AgentTaskCard";
import { toastError } from "@/lib/toast";

function card(id: string, over: Record<string, unknown> = {}, nextAction: string | null = null) {
  return {
    task: {
      id,
      title: `Sprint ${id}`,
      milestone: "PRACTICING",
      status: "ACTIVE",
      blockedReason: null,
      acceptanceItems: [
        { key: "a", label: "Goal set", passes: true, evidenceRef: "g1" },
        { key: "b", label: "Mock round", passes: false },
      ],
      ...over,
    },
    nextAction,
  };
}

describe("AgentTaskCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTaskSession.mockResolvedValue(true);
    chat = {
      isOpen: true,
      conversationId: null,
      activeTaskId: null,
      status: "ready",
      openTaskSession,
    };
  });

  it("renders nothing without in-progress tasks", async () => {
    listAgentTaskCards.mockResolvedValue({ success: true, data: [] });
    const { container } = render(<AgentTaskCard />);
    await waitFor(() => expect(listAgentTaskCards).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows name, stage and done count collapsed, details on expand", async () => {
    listAgentTaskCards.mockResolvedValue({
      success: true,
      data: [card("t1", { status: "BLOCKED", blockedReason: "MISSING_FACTS" }, "Answer question 2")],
    });
    render(<AgentTaskCard />);
    expect(await screen.findByText("Sprint t1")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-stage")).toHaveTextContent("Practicing");
    expect(screen.getByTestId("agent-task-count")).toHaveTextContent("1/2");
    expect(screen.queryByTestId("agent-task-details")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /task details/i }));
    expect(screen.getByText("Goal set")).toBeInTheDocument();
    expect(screen.getByText("Mock round")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-blocked")).toHaveTextContent("Missing information");
    expect(screen.getByTestId("agent-task-next")).toHaveTextContent("Answer question 2");
  });

  it("continue claims the session and opens it; a new session sends the kickoff", async () => {
    listAgentTaskCards.mockResolvedValue({ success: true, data: [card("t1")] });
    resumeAgentTask.mockResolvedValue({
      success: true,
      data: { conversationId: "c9", created: true, kickoffText: "Continue this task." },
    });
    render(<AgentTaskCard />);
    await screen.findByText("Sprint t1");
    await userEvent.click(screen.getByRole("button", { name: /task details/i }));
    await userEvent.click(screen.getByTestId("agent-task-continue"));
    await waitFor(() =>
      expect(openTaskSession).toHaveBeenCalledWith({
        conversationId: "c9",
        kickoffText: "Continue this task.",
      }),
    );
    expect(resumeAgentTask).toHaveBeenCalledWith("t1", undefined);
  });

  it("reusing a session does not resend the kickoff; HELD reports an error", async () => {
    chat.activeTaskId = "t1";
    chat.conversationId = "c1";
    listAgentTaskCards.mockResolvedValue({ success: true, data: [card("t1")] });
    resumeAgentTask.mockResolvedValueOnce({
      success: true,
      data: { conversationId: "c1", created: false, kickoffText: "Continue this task." },
    });
    render(<AgentTaskCard />);
    await screen.findByText("Sprint t1");
    await userEvent.click(screen.getByRole("button", { name: /task details/i }));
    await userEvent.click(screen.getByTestId("agent-task-continue"));
    await waitFor(() =>
      expect(openTaskSession).toHaveBeenCalledWith({ conversationId: "c1", kickoffText: undefined }),
    );
    expect(resumeAgentTask).toHaveBeenCalledWith("t1", { conversationId: "c1" });

    resumeAgentTask.mockResolvedValueOnce({ success: false, message: "HELD", code: "HELD" });
    await userEvent.click(screen.getByTestId("agent-task-continue"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Another session")));
  });

  it("switches between tasks with the dropdown, preferring the bound session's task", async () => {
    chat.activeTaskId = "t2";
    listAgentTaskCards.mockResolvedValue({ success: true, data: [card("t1"), card("t2")] });
    render(<AgentTaskCard />);
    const select = (await screen.findByTestId("agent-task-switch")) as HTMLSelectElement;
    expect(select.value).toBe("t2");
  });
  it("a manual pick overrides the bound task until the conversation changes", async () => {
    chat.activeTaskId = "t2";
    listAgentTaskCards.mockResolvedValue({ success: true, data: [card("t1"), card("t2")] });
    const { rerender } = render(<AgentTaskCard />);
    const select = (await screen.findByTestId("agent-task-switch")) as HTMLSelectElement;
    await userEvent.selectOptions(select, "t1");
    expect(select.value).toBe("t1");
    chat = { ...chat, activeTaskId: "t1" };
    rerender(<AgentTaskCard />);
    await waitFor(() => expect((screen.getByTestId("agent-task-switch") as HTMLSelectElement).value).toBe("t1"));
  });

  it("falls back to the first task when the open conversation has no task", async () => {
    chat.activeTaskId = null;
    listAgentTaskCards.mockResolvedValue({ success: true, data: [card("t1"), card("t2")] });
    render(<AgentTaskCard />);
    expect(((await screen.findByTestId("agent-task-switch")) as HTMLSelectElement).value).toBe("t1");
  });
});
