import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendMessage = vi.fn();
const seedExchange = vi.fn();
let preflight = { checked: true, ok: true };
let context = { version: 1, items: [] as Array<Record<string, string>> };

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    sendMessage,
    seedExchange,
    preflight,
    context,
    requestAddContext: vi.fn(),
  }),
}));

import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";
import { AGENT_ADD_JOB_INTRO } from "@/lib/agent/prompt";

describe("AgentChatEmptyState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preflight = { checked: true, ok: true };
    context = { version: 1, items: [] };
  });

  // The click carries no company, title or posting, so add_job is
  // unreachable and the prompt leaves the model one legal reply. Spending a
  // 15-30s turn on it is latency for text we already know.
  it("answers the add-job suggestion locally instead of calling the model", async () => {
    render(<AgentChatEmptyState />);
    await userEvent.click(screen.getByText("Add a job posting"));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(seedExchange).toHaveBeenCalledWith(
      "Add a job posting",
      AGENT_ADD_JOB_INTRO,
    );
  });

  // The other three end in a tool call whose outcome depends on the page.
  it("sends the job-context suggestion to the model", async () => {
    context = {
      version: 1,
      items: [
        {
          kind: "job",
          entityId: "job-1",
          labelSnapshot: "AI Product Analyst",
          source: "AUTO",
        },
      ],
    };
    render(<AgentChatEmptyState />);
    expect(screen.getByText("AI Product Analyst")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Check my match"));

    expect(seedExchange).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      parts: [{ type: "text", text: "Check my match" }],
    });
  });

  it("does nothing when preflight failed", async () => {
    preflight = { checked: true, ok: false };
    render(<AgentChatEmptyState />);
    await userEvent.click(screen.getByText("Add a job posting"));

    expect(seedExchange).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
