import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("@/components/agent/empty-state-motion", () => ({
  mountEmptyStateMotion: () => ({ dispose: vi.fn(), setState: vi.fn() }),
}));

const sendMessage = vi.fn();
const fillComposer = vi.fn();
const requestAddContext = vi.fn();
let activeRole: "insight" | "pilot" | "reflect" = "pilot";
let preflight = { checked: true, ok: true };
let context = { version: 1, items: [] as Array<Record<string, string>> };

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    sendMessage,
    fillComposer,
    activeRole,
    preflight,
    context,
    requestAddContext,
  }),
}));

import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";

describe("AgentChatEmptyState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeRole = "pilot";
    preflight = { checked: true, ok: true };
    context = { version: 1, items: [] };
  });

  it("renders a decorative 72px idle agent presence", () => {
    const { container } = render(<AgentChatEmptyState />);
    const mark = container.querySelector("svg[data-vocatrya-mark]");
    expect(mark).toHaveAttribute("width", "72");
    expect(mark).toHaveAttribute("data-state", "idle");
    expect(mark).toHaveAttribute("data-animated", "true");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("focusable", "false");
  });

  it("shows the roster self-intro and legend without naming extensions", () => {
    render(<AgentChatEmptyState />);
    expect(screen.getByTestId("agent-empty-self")).toHaveTextContent(
      "I keep your job list in shape",
    );
    expect(screen.getByTestId("agent-empty-self")).toHaveTextContent(
      "For resume analysis, ask Insight.",
    );
    expect(screen.getByTestId("agent-roster-legend")).toHaveTextContent(
      "switch anytime from the icons up top",
    );
    expect(screen.getByTestId("agent-empty-state").textContent).not.toMatch(
      /notion/i,
    );
  });

  it("shows four role suggestions that only fill the composer", async () => {
    render(<AgentChatEmptyState />);
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => b.closest("[data-testid='agent-empty-state']"));
    // Exactly four suggestions per role.
    expect(screen.getAllByRole("button")).toHaveLength(7); // 4 suggestions + 3 context picks
    await userEvent.click(screen.getByText("Add a job"));
    expect(fillComposer).toHaveBeenCalledWith(
      "Add this job posting to my jobs: ",
    );
    expect(sendMessage).not.toHaveBeenCalled();
    void buttons;
  });

  it.each([
    ["insight", "Check my match for this job"],
    ["reflect", "Talk through how that interview went"],
  ] as const)("offers %s its own first suggestion", (role, label) => {
    activeRole = role;
    render(<AgentChatEmptyState />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // D8: with no AI configured the send path is dead, but a suggestion still
  // fills the composer — the click itself never calls the model.
  it("keeps suggestions clickable when preflight failed", async () => {
    preflight = { checked: true, ok: false };
    render(<AgentChatEmptyState />);
    await userEvent.click(screen.getByText("List my saved jobs"));
    expect(fillComposer).toHaveBeenCalledWith("List my saved jobs");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the context entries wired to the existing picker", async () => {
    render(<AgentChatEmptyState />);
    const user = userEvent.setup();
    for (const name of ["Choose a job", "Choose a resume", "Add context"]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(requestAddContext).toHaveBeenCalledTimes(3);
    expect(fillComposer).not.toHaveBeenCalled();
  });

  it("names the context job when one is selected", () => {
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
  });
});
