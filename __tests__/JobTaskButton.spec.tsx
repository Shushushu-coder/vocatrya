import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listAgentTasks = vi.fn();
const createAgentTask = vi.fn();
const resumeAgentTask = vi.fn();
const openTaskSession = vi.fn();

vi.mock("@/actions/agentTask.actions", () => ({
  listAgentTasks: (...a: unknown[]) => listAgentTasks(...a),
  createAgentTask: (...a: unknown[]) => createAgentTask(...a),
  resumeAgentTask: (...a: unknown[]) => resumeAgentTask(...a),
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ openTaskSession, conversationId: null, activeTaskId: null }),
}));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { JobTaskButton } from "@/components/myjobs/job-details/JobTaskButton";

describe("JobTaskButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTaskSession.mockResolvedValue(true);
    resumeAgentTask.mockResolvedValue({
      success: true,
      data: { conversationId: "c1", created: true, kickoffText: "Continue this task." },
    });
  });

  it("creates the task then opens its session when none is in progress", async () => {
    listAgentTasks.mockResolvedValue({ success: true, data: [{ id: "old", status: "DONE" }] });
    createAgentTask.mockResolvedValue({ success: true, data: { task: { id: "t1" }, created: true } });
    render(<JobTaskButton jobOpportunityId="j1" />);
    const button = await screen.findByRole("button", { name: "Create job-search task for this opportunity" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(openTaskSession).toHaveBeenCalled());
    expect(createAgentTask).toHaveBeenCalledWith({ jobOpportunityId: "j1" });
    expect(resumeAgentTask).toHaveBeenCalledWith("t1", undefined);
  });

  it("becomes Open task and does not create when one is in progress", async () => {
    listAgentTasks.mockResolvedValue({ success: true, data: [{ id: "t7", status: "PAUSED" }] });
    render(<JobTaskButton jobOpportunityId="j1" />);
    const button = await screen.findByRole("button", { name: "Open task" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(openTaskSession).toHaveBeenCalled());
    expect(createAgentTask).not.toHaveBeenCalled();
    expect(resumeAgentTask).toHaveBeenCalledWith("t7", undefined);
  });
});
