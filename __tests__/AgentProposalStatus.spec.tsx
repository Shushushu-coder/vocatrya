import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProposalStatus } from "@/components/agent/AgentProposalStatus";
import {
  decideOperationProposalAction,
  getOperationProposalAction,
  listOperationProposalsAction,
  reproposeOperationAction,
  resolveUncertainProposalAction,
  restoreProposalSourceAction,
  withdrawOperationProposalAction,
} from "@/actions/operationProposal.actions";

vi.mock("@/actions/operationProposal.actions", () => ({
  decideOperationProposalAction: vi.fn(),
  getOperationProposalAction: vi.fn(),
  listOperationProposalsAction: vi.fn(),
  reproposeOperationAction: vi.fn(),
  resolveUncertainProposalAction: vi.fn(),
  restoreProposalSourceAction: vi.fn(),
  withdrawOperationProposalAction: vi.fn(),
}));

const get = vi.mocked(getOperationProposalAction);
const decide = vi.mocked(decideOperationProposalAction);
const repropose = vi.mocked(reproposeOperationAction);
const resolve = vi.mocked(resolveUncertainProposalAction);
const withdraw = vi.mocked(withdrawOperationProposalAction);

const dto = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  toolName: "notion_create_page",
  status: "APPROVED",
  derived: "queued",
  input: { title: "Offer log" },
  conversationId: "conv-1",
  sourceArchived: false,
  approvalId: "ap-1",
  toolCallId: "tc-1",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  dispatched: false,
  taskId: "t-1",
  taskStatus: "QUEUED",
  outcomeStatus: null,
  outcome: null,
  manualResolution: null,
  supersedesId: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentProposalStatus", () => {
  it("restarts polling after a terminal card is re-proposed and stops after settlement", async () => {
    vi.useFakeTimers();
    try {
      const pending = dto({ id: "p2", derived: "pending", status: "PROPOSED" });
      const succeeded = dto({ id: "p2", derived: "succeeded", outcomeStatus: "SUCCEEDED" });
      get.mockResolvedValueOnce({ success: true, data: dto({ derived: "expired" }) } as never)
        .mockResolvedValueOnce({ success: true, data: pending } as never)
        .mockResolvedValue({ success: true, data: succeeded } as never);
      repropose.mockResolvedValue({ success: true, data: { proposal: pending } } as never);
      const view = render(<AgentProposalStatus proposalId="p1" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Propose again" })); });
      expect(screen.getByText("Awaiting your decision")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText("Written to Notion")).toBeInTheDocument();
      const reads = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(get).toHaveBeenCalledTimes(reads);
      expect(get).toHaveBeenLastCalledWith({ approvalId: undefined, proposalId: "p2" });
      view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it("mounts read-only — one fetch, zero write or decide calls", async () => {
    get.mockResolvedValue({ success: true, data: dto() } as never);
    render(<AgentProposalStatus proposalId="p1" />);
    expect(await screen.findByText("Queued for background execution")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    for (const m of [
      decide,
      repropose,
      resolve,
      withdraw,
      vi.mocked(restoreProposalSourceAction),
      vi.mocked(listOperationProposalsAction),
    ]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("stops polling on a terminal state — no second fetch is scheduled", async () => {
    get.mockResolvedValue({
      success: true,
      data: dto({ derived: "succeeded", outcomeStatus: "SUCCEEDED" }),
    } as never);
    render(<AgentProposalStatus proposalId="p1" />);
    expect(await screen.findByText("Written to Notion")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("shows the action's failure message instead of silently refreshing", async () => {
    get.mockResolvedValue({
      success: true,
      data: dto({ derived: "pending", status: "PROPOSED" }),
    } as never);
    decide.mockResolvedValue({
      success: false,
      message: "Proposal expired",
      code: "PROPOSAL_EXPIRED",
    } as never);
    render(<AgentProposalStatus proposalId="p1" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    expect(await screen.findByText("Proposal expired")).toBeInTheDocument();
  });

  it("a re-proposal swaps the card onto the returned new proposal", async () => {
    get.mockImplementation((async (input: { proposalId?: string }) =>
      input.proposalId === "p2"
        ? {
            success: true,
            data: dto({
              id: "p2",
              derived: "pending",
              status: "PROPOSED",
              supersedesId: "p1",
            }),
          }
        : {
            success: true,
            data: dto({
              derived: "uncertain",
              outcomeStatus: "UNCERTAIN",
              manualResolution: "NOT_HAPPENED",
            }),
          }) as never);
    repropose.mockResolvedValue({
      success: true,
      data: {
        proposalId: "p2",
        proposal: dto({
          id: "p2",
          derived: "pending",
          status: "PROPOSED",
          supersedesId: "p1",
        }),
      },
    } as never);
    render(<AgentProposalStatus proposalId="p1" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Propose again" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Awaiting your decision")).toBeInTheDocument(),
    );
  });

  it("gates re-proposal on attestation for unverified rows", async () => {
    get.mockResolvedValue({
      success: true,
      data: dto({
        derived: "unverified",
        taskId: null,
        taskStatus: null,
      }),
    } as never);
    render(<AgentProposalStatus proposalId="p1" />);
    expect(
      await screen.findByRole("button", { name: "Confirmed not happened" }),
    ).toBeInTheDocument();
    // No re-proposal button until the user attests what Notion shows.
    expect(
      screen.queryByRole("button", { name: "Propose again" }),
    ).not.toBeInTheDocument();
  });
});
