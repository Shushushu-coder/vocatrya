import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentApprovalCard } from "@/components/agent/AgentApprovalCard";

const part = (overrides: Record<string, unknown> = {}) =>
  ({
    type: "tool-add_job",
    toolCallId: "c1",
    state: "approval-requested",
    approval: { id: "ap1" },
    input: {
      company: "Acme Corp",
      jobTitle: "Senior Platform Engineer",
      location: "Remote",
      source: "LinkedIn",
      jobUrl: "https://example.com/jobs/1",
      salaryRange: "$180k",
      tags: ["Go", "Kubernetes"],
    },
    ...overrides,
  }) as any;

const longPaste = Array.from({ length: 200 }, () => "word").join(" ");

describe("AgentApprovalCard", () => {
  it("labels a suggested checklist as a plan to adopt and submits its approval", async () => {
    const onRespond = vi.fn();
    render(
      <AgentApprovalCard
        part={part({ type: "tool-today_plan", input: { action: "suggest", items: ["Prepare interview examples"], target: "today" } })}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText("Update today's checklist")).toBeInTheDocument();
    expect(screen.getByText("Prepare interview examples")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Adopt plan" }));
    expect(onRespond).toHaveBeenCalledWith({ id: "ap1", approved: true });
  });

  it("renders the arguments as labelled rows under a Needs approval pill", () => {
    render(<AgentApprovalCard part={part()} onRespond={vi.fn()} />);
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByText("Add job")).toBeInTheDocument();
    expect(screen.queryByText("add_job")).not.toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("Senior Platform Engineer")).toBeInTheDocument();
    expect(screen.getByText("Remote")).toBeInTheDocument();
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.getByText("$180k")).toBeInTheDocument();
    expect(screen.getByText(/Go/)).toBeInTheDocument();
  });

  it("renders a model-supplied URL as text, never as an anchor", () => {
    const { container } = render(
      <AgentApprovalCard part={part()} onRespond={vi.fn()} />,
    );
    expect(screen.getByText("https://example.com/jobs/1")).toBeInTheDocument();
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(
      anchors.some((a) => a.getAttribute("href")?.includes("example.com")),
    ).toBe(false);
  });

  it("shows the pasted source, its size and a completeness badge before Confirm", () => {
    render(
      <AgentApprovalCard
        part={part()}
        pastedText={longPaste}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/pasted/i)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${longPaste.length}`)),
    ).toBeInTheDocument();
    expect(screen.getByText(/full/i)).toBeInTheDocument();
  });

  it("labels a model-supplied description and classifies it as thin when it is", () => {
    render(
      <AgentApprovalCard
        part={part({
          input: {
            company: "Acme",
            jobTitle: "Eng",
            jobDescription: "Backend role, remote.",
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/model-supplied/i)).toBeInTheDocument();
    expect(screen.getByText(/title-only/i)).toBeInTheDocument();
  });

  it("uses Confirm and Cancel, not Approve and Deny", () => {
    render(<AgentApprovalCard part={part()} onRespond={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /confirm/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /deny/i }),
    ).not.toBeInTheDocument();
  });

  it("responds approved with the approval id from the tool part", async () => {
    const onRespond = vi.fn();
    render(<AgentApprovalCard part={part()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onRespond).toHaveBeenCalledWith({ id: "ap1", approved: true });
  });

  it("carries an optional decline reason back to the model", async () => {
    const onRespond = vi.fn();
    render(<AgentApprovalCard part={part()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    const reason = screen.getByPlaceholderText(/what was wrong/i);
    await userEvent.type(reason, "wrong company");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onRespond).toHaveBeenCalledWith({
      id: "ap1",
      approved: false,
      reason: "wrong company",
    });
  });

  it("cancels with no reason if the user does not give one", async () => {
    const onRespond = vi.fn();
    render(<AgentApprovalCard part={part()} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await userEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onRespond).toHaveBeenCalledWith({ id: "ap1", approved: false });
  });

  it("replaces the buttons with a waiting state once responded", () => {
    render(
      <AgentApprovalCard
        part={part({
          state: "approval-responded",
          approval: { id: "ap1", approved: true },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /confirm/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();
  });

  it("renders nothing for a state it does not own", () => {
    const { container } = render(
      <AgentApprovalCard
        part={part({ state: "input-available" })}
        onRespond={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // AWU-APPROVAL: the card follows the approval through execution — the
  // request settles into a status line with the parameters one tap away.
  it("shows an approved respond as running, not as a fresh request", () => {
    render(
      <AgentApprovalCard
        part={part({
          state: "approval-responded",
          approval: { id: "ap1", approved: true },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    expect(screen.queryByText("Needs approval")).not.toBeInTheDocument();
    expect(screen.queryByText("Show details")).not.toBeInTheDocument();
  });

  it("shows a denied respond as declined with its reason", () => {
    render(
      <AgentApprovalCard
        part={part({
          state: "approval-responded",
          approval: { id: "ap1", approved: false, reason: "wrong company" },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText(/wrong company/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
  });

  it("collapses the parameters on an executed call", () => {
    const { container } = render(
      <AgentApprovalCard
        part={part({
          state: "output-available",
          approval: { id: "ap1", approved: true },
          output: { created: true, jobId: "j1" },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Executed")).toBeInTheDocument();
    const details = container.querySelector("details");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Show details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("shows a denied output as declined", () => {
    render(
      <AgentApprovalCard
        part={part({
          state: "output-denied",
          approval: { id: "ap1", approved: false, reason: "duplicate" },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText(/duplicate/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("shows a failed call with its error text", () => {
    render(
      <AgentApprovalCard
        part={part({
          state: "output-error",
          approval: { id: "ap1", approved: true },
          errorText: "provider unreachable",
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/provider unreachable/)).toBeInTheDocument();
  });

  it("does not claim a plain output that never carried an approval", () => {
    const { container } = render(
      <AgentApprovalCard
        part={part({ state: "output-available", approval: undefined, output: {} })}
        onRespond={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
