import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AGENT_NATIVE_SEARCH_PART_TYPE, AGENT_NATIVE_TOOL_PART_TYPE, AGENT_PASTE_PART_TYPE } from "@/models/agent.model";

const chat = {
  messages: [] as any[],
  status: "ready" as string,
  regenerate: vi.fn(),
  resumeStream: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  toolStreams: {} as Record<string, string>,
  contextUsage: null as any,
  approvalPending: false,
  conversationId: "conv-1" as string | null,
};
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));
const proposalMocks = vi.hoisted(() => ({
  getOperationProposalAction: vi.fn(),
  decideOperationProposalAction: vi.fn(),
  listOperationProposalsAction: vi.fn(),
  reproposeOperationAction: vi.fn(),
  resolveUncertainProposalAction: vi.fn(),
  restoreProposalSourceAction: vi.fn(),
  withdrawOperationProposalAction: vi.fn(),
}));
vi.mock("@/actions/operationProposal.actions", () => proposalMocks);
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div data-testid="tiptap-content" dangerouslySetInnerHTML={{ __html: content }} />
  ),
}));

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";

const toolPart = (state: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-add_job",
  toolCallId: "c1",
  state,
  input: { company: "Acme", jobTitle: "Platform Engineer" },
  ...extra,
});

const assistant = (parts: any[]) => ({ id: "a1", role: "assistant", parts });
const user = (parts: any[]) => ({ id: "u1", role: "user", parts });

const posting = "Senior Platform Engineer at Acme. We run payments reliability.";

describe("AgentChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.messages = [];
    chat.status = "ready";
    chat.toolStreams = {};
    chat.contextUsage = null;
  });

  it("renders the running card while the tool input is still arriving", () => {
    chat.messages = [assistant([toolPart("input-available")])];
    render(<AgentChatMessages />);
    expect(screen.getByText(/preparing to add a job/i)).toBeInTheDocument();
  });

  it("renders the approval card for approval-requested", () => {
    chat.messages = [
      assistant([toolPart("approval-requested", { approval: { id: "ap1" } })]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("renders the result card for output-available", () => {
    chat.messages = [
      assistant([
        toolPart("output-available", {
          output: { created: true, jobId: "j1", resolutions: [] },
        }),
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getAllByText(/added/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("Needs approval")).not.toBeInTheDocument();
  });

  // AWU-APPROVAL: an approval-gated tool's settled states stay on the
  // approval card — executed/denied/failed — beside the outcome card.
  it("settles an approved call into Executed beside the result card", () => {
    chat.messages = [
      assistant([
        toolPart("output-available", {
          approval: { id: "ap1", approved: true },
          output: { created: true, jobId: "j1", resolutions: [] },
        }),
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText("Executed")).toBeInTheDocument();
    expect(screen.getAllByText(/added/i).length).toBeGreaterThan(0);
  });

  it("shows a denied call as Declined without a result card", () => {
    chat.messages = [
      assistant([
        toolPart("output-denied", {
          approval: { id: "ap1", approved: false, reason: "wrong company" },
        }),
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText(/wrong company/)).toBeInTheDocument();
  });

  it("shows a failed call as Failed beside the retry card", () => {
    chat.messages = [
      assistant([
        toolPart("output-error", {
          approval: { id: "ap1", approved: true },
          errorText: "provider unreachable",
        }),
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/not added/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("notes the dropped history above the transcript", () => {
    chat.contextUsage = { droppedTurnCount: 3 };
    chat.messages = [
      user([{ type: "text", text: "add a job" }]),
      assistant([{ type: "text", text: "Done." }]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText(/left out of the last send/i)).toBeInTheDocument();
  });

  it("feeds the approval card the pasted text from the same thread", () => {
    chat.messages = [
      user([
        { type: "text", text: "add this" },
        {
          type: AGENT_PASTE_PART_TYPE,
          id: "p1",
          data: {
            id: "p1",
            text: posting,
            chars: posting.length,
            truncated: false,
          },
        },
      ]),
      assistant([toolPart("approval-requested", { approval: { id: "ap1" } })]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText(/pasted verbatim/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(posting.slice(0, 30)))).toBeInTheDocument();
  });

  it("offers Continue on a dead turn and calls regenerate only on click", async () => {
    chat.messages = [user([{ type: "text", text: "add a job" }])];
    render(<AgentChatMessages />);

    expect(chat.regenerate).not.toHaveBeenCalled();
    expect(chat.resumeStream).not.toHaveBeenCalled();

    // Exact name: the answer row under a reply carries a "Regenerate answer"
    // action — the banner's button is just "Regenerate".
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(chat.regenerate).toHaveBeenCalled();
    expect(chat.resumeStream).not.toHaveBeenCalled();
  });

  it("lets the continue notice be dismissed", async () => {
    chat.messages = [user([{ type: "text", text: "add a job" }])];
    render(<AgentChatMessages />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(
      screen.queryByRole("button", { name: "Regenerate" }),
    ).not.toBeInTheDocument();
  });

  it("offers Continue when a seeded transcript ends with a user message", () => {
    chat.messages = [user([{ type: "text", text: "add a job" }])];
    render(<AgentChatMessages />);
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeInTheDocument();
  });

  it("does not offer Continue while the reply is still in flight", () => {
    chat.status = "submitted";
    chat.messages = [user([{ type: "text", text: "add a job" }])];
    render(<AgentChatMessages />);
    expect(
      screen.queryByRole("button", { name: /regenerate/i }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Continue after a completed assistant turn", () => {
    chat.messages = [
      user([{ type: "text", text: "add a job" }]),
      assistant([{ type: "text", text: "Done." }]),
    ];
    render(<AgentChatMessages />);
    // No interrupted banner; the answer row's "Regenerate answer" is a
    // different control and stays.
    expect(
      screen.queryByRole("button", { name: "Regenerate" }),
    ).not.toBeInTheDocument();
  });

  it("shows the thinking row while the first assistant part is still pending", () => {
    chat.status = "submitted";
    chat.messages = [user([{ type: "text", text: "add a job" }])];
    render(<AgentChatMessages />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it("shows the thinking row after a tool result while the reply is composed", () => {
    chat.status = "streaming";
    chat.messages = [
      assistant([
        toolPart("output-available", {
          output: { created: true, jobId: "j1", resolutions: [] },
        }),
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });

  it("does not double up on the running card, which spins already", () => {
    chat.status = "streaming";
    chat.messages = [assistant([toolPart("input-available")])];
    render(<AgentChatMessages />);
    expect(screen.getByText(/preparing to add a job/i)).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("does not show the thinking row while an approval is on screen", () => {
    chat.status = "streaming";
    chat.messages = [
      assistant([toolPart("approval-requested", { approval: { id: "ap1" } })]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("does not show the thinking row once text is arriving", () => {
    chat.status = "streaming";
    chat.messages = [assistant([{ type: "text", text: "I found the" }])];
    render(<AgentChatMessages />);
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("does not show the thinking row on a settled transcript", () => {
    chat.messages = [
      user([{ type: "text", text: "add a job" }]),
      assistant([{ type: "text", text: "Done." }]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("renders assistant text as plain text, never as markdown media", () => {
    chat.messages = [
      assistant([{ type: "text", text: "![x](http://evil/a.png)" }]),
    ];
    const { container } = render(<AgentChatMessages />);
    expect(container.innerHTML).not.toContain("<img");
    expect(screen.getByTestId("tiptap-content")).toHaveTextContent(
      "![x](http://evil/a.png)",
    );
  });

  it("renders assistant markdown as formatted HTML", () => {
    chat.messages = [
      assistant([{ type: "text", text: "## Summary\n\n- one\n- two" }]),
    ];
    render(<AgentChatMessages />);
    const rendered = screen.getByTestId("tiptap-content");
    expect(rendered.innerHTML).toContain("<h2>Summary</h2>");
    expect(rendered.innerHTML).toContain("<li>one</li>");
  });

  it("leaves user text unformatted", () => {
    chat.messages = [user([{ type: "text", text: "## not a heading" }])];
    render(<AgentChatMessages />);
    expect(screen.queryByTestId("tiptap-content")).not.toBeInTheDocument();
    expect(screen.getByText("## not a heading")).toBeInTheDocument();
  });

  it("constrains long user bubbles while retaining line breaks and wrapping long tokens", () => {
    const text = `岗位职责\n${"https://example.test/" + "a".repeat(500)}\n任职要求`;
    chat.messages = [user([{ type: "text", text }])];
    render(<AgentChatMessages />);
    const bubble = screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);
    expect(bubble).toHaveClass("max-w-[85%]", "min-w-0", "whitespace-pre-wrap", "[overflow-wrap:anywhere]");
    expect(bubble.parentElement).toHaveClass("items-end");
  });

  it("does not render a link the model emitted", () => {
    chat.messages = [
      assistant([{ type: "text", text: "[click](https://evil.example/?d=x)" }]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // think:true means reasoning parts now reach the client. They are the
  // model's scratchpad, not its answer, and must never render as prose.
  it("renders nothing for a reasoning part", () => {
    chat.messages = [
      assistant([
        { type: "reasoning", text: "The user pasted a posting, so I omit jobDescription." },
        { type: "text", text: "Added." },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByText("Added.")).toBeInTheDocument();
    expect(screen.queryByText(/omit jobDescription/)).not.toBeInTheDocument();
  });

  // The transcript no longer parses assistant prose for a SCORES line at all
  // — the card comes from the tool part. A model that emits one anyway is
  // rendered as the plain text it is.
  it("renders no score card for a scores line in assistant prose", () => {
    chat.messages = [
      assistant([
        {
          type: "text",
          text: "SCORES: overall=78 impact=72 clarity=81 ats=69\n\nSolid resume.",
        },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByText("Impact")).not.toBeInTheDocument();
  });

  it("renders a follow-up answer with no score card", () => {
    chat.messages = [
      assistant([
        { type: "text", text: "Your ATS score is held back by the tables." },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByText("Impact")).not.toBeInTheDocument();
  });

  const reviewRunning = {
    type: "tool-review_resume",
    toolCallId: "rv1",
    state: "input-available",
    input: {},
  } as any;

  it("renders the review as it streams, before the tool result exists", () => {
    chat.status = "streaming";
    chat.toolStreams = {
      rv1: "SCORES: overall=78 impact=72 clarity=81 ats=69\n\n## Summary\n\nSolid.",
    };
    chat.messages = [assistant([reviewRunning])];
    render(<AgentChatMessages />);
    expect(screen.getByText("Impact")).toBeInTheDocument();
    expect(screen.queryByText(/SCORES:/)).not.toBeInTheDocument();
    expect(screen.getByTestId("tiptap-content").innerHTML).toContain(
      "<h2>Summary</h2>",
    );
  });

  it("shows the running card until the first review token arrives", () => {
    chat.status = "streaming";
    chat.toolStreams = {};
    chat.messages = [assistant([reviewRunning])];
    render(<AgentChatMessages />);
    expect(screen.getByText(/reviewing your resume/i)).toBeInTheDocument();
  });

  it("renders a running match_job from its streamed text", () => {
    chat.toolStreams = {
      m1: "SCORES: match=72 recommendation=good\n\n## Summary\n\nStreaming.",
    };
    chat.messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-match_job",
            toolCallId: "m1",
            state: "input-available",
            input: {},
          },
        ],
      },
    ] as any;
    render(<AgentChatMessages />);
    expect(screen.getByText(/Streaming\./i)).toBeInTheDocument();
    expect(screen.queryByText(/SCORES:/)).not.toBeInTheDocument();
  });

  it("renders a running generate_cover_letter from its streamed text", () => {
    chat.toolStreams = {
      c1: "<think>planning</think>Dear Hiring Manager,\n\nI am writing.",
    };
    chat.messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-generate_cover_letter",
            toolCallId: "c1",
            state: "input-available",
            input: {},
          },
        ],
      },
    ] as any;
    render(<AgentChatMessages />);
    expect(screen.getByText(/Dear Hiring Manager/i)).toBeInTheDocument();
    expect(screen.queryByText(/planning/)).not.toBeInTheDocument();
  });

  it("renders a native search part in started state without duplicating the thinking indicator", () => {
    chat.status = "streaming";
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_SEARCH_PART_TYPE,
          id: "native-search-ws1",
          data: {
            version: 1,
            kind: "search",
            itemId: "ws1",
            status: "started",
            actionType: "search",
            query: "vocatrya careers",
            queries: ["vocatrya careers"],
            sources: [],
          },
        },
      ]),
    ];
    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-search-card");
    expect(card).toHaveAttribute("data-status", "started");
    expect(card).toHaveTextContent("vocatrya careers");
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("renders completed native search records with clickable http/https sources only", () => {
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_SEARCH_PART_TYPE,
          id: "native-search-ws1",
          data: {
            version: 1,
            kind: "search",
            itemId: "ws1",
            status: "completed",
            actionType: "search",
            query: "platform engineer openings",
            queries: ["platform engineer openings"],
            sources: [
              { url: "https://example.com/jobs/1", host: "example.com", title: "Platform Engineer" },
              { url: "javascript:alert(1)", title: "Unsafe" },
            ],
          },
        },
        { type: "text", text: "Here are the verified results." },
      ]),
    ];
    render(<AgentChatMessages />);
    const link = screen.getByRole("link", { name: /Platform Engineer/i });
    expect(link).toHaveAttribute("href", "https://example.com/jobs/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.queryByRole("link", { name: /Unsafe/i })).not.toBeInTheDocument();
    expect(screen.getByText("Here are the verified results.")).toBeInTheDocument();
  });

  it("does not fabricate search cards or clickable links when prose alone claims to have searched", () => {
    chat.messages = [
      assistant([
        { type: "text", text: "我已搜索 [虚假来源](https://fake.example/news)" },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByTestId("agent-native-search-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a running native business tool card without duplicating the thinking indicator", () => {
    chat.status = "streaming";
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-t1",
          data: {
            version: 1,
            kind: "tool",
            itemId: "t1",
            tool: "list_jobs",
            status: "running",
          },
        },
      ]),
    ];
    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-tool-card");
    expect(card).toHaveAttribute("data-status", "running");
    expect(card).toHaveAttribute("data-tool", "list_jobs");
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("renders a completed native business tool card with its bounded summaries", () => {
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-t2",
          data: {
            version: 1,
            kind: "tool",
            itemId: "t2",
            tool: "get_job",
            status: "completed",
            argumentsSummary: '{"jobId":"j1"}',
            resultSummary: "Platform Engineer at Acme",
          },
        },
        { type: "text", text: "Done." },
      ]),
    ];
    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-tool-card");
    expect(card).toHaveAttribute("data-status", "completed");
    expect(card).toHaveTextContent("Platform Engineer at Acme");
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });

  it("renders a failed native business tool card", () => {
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-t3",
          data: {
            version: 1,
            kind: "tool",
            itemId: "t3",
            tool: "today_plan_read",
            status: "failed",
            resultSummary: "denied",
          },
        },
      ]),
    ];
    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-tool-card");
    expect(card).toHaveAttribute("data-status", "failed");
    expect(card).toHaveTextContent("denied");
  });

  it("does not fabricate tool cards for unknown native part shapes", () => {
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-bad",
          data: { version: 1, kind: "tool", itemId: "x", tool: "add_job", status: "writing" },
        },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByTestId("agent-native-tool-card")).not.toBeInTheDocument();
  });

  it("renders a native approval_required part as an approval card (never Completed) and updates on approve", async () => {
    const pendingDto = {
      id: "prop-add-1",
      toolName: "add_job",
      status: "PROPOSED",
      derived: "pending",
      input: {
        company: "Acme Corp",
        jobTitle: "Platform Engineer",
        location: "Shanghai",
      },
      target: "Acme Corp · Platform Engineer",
      conversationId: "conv-1",
      sourceArchived: false,
      approvalId: "ap-add-1",
      toolCallId: "native-mcp-1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      decidedAt: null,
      decisionReason: null,
      dispatched: false,
      taskId: null,
      taskStatus: null,
      outcomeStatus: null,
      outcome: null,
      manualResolution: null,
      supersedesId: null,
    };
    const succeededDto = {
      ...pendingDto,
      status: "APPROVED",
      derived: "succeeded",
      taskId: "task-1",
      taskStatus: "SUCCEEDED",
      outcomeStatus: "SUCCEEDED",
      outcome: {
        saved: true,
        created: true,
        company: "Acme Corp",
        title: "Platform Engineer",
      },
    };
    proposalMocks.getOperationProposalAction
      .mockResolvedValueOnce({ success: true, data: pendingDto })
      .mockResolvedValue({ success: true, data: succeededDto });
    proposalMocks.decideOperationProposalAction.mockResolvedValueOnce({
      success: true,
      data: { state: "approved", proposal: { ...pendingDto, status: "APPROVED", derived: "queued", taskId: "task-1" } },
    });

    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-add1",
          data: {
            version: 1,
            kind: "tool",
            itemId: "add1",
            tool: "add_job",
            status: "approval_required",
            proposalId: "prop-add-1",
            approvalId: "ap-add-1",
          },
        },
      ]),
    ];

    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-tool-card");
    expect(card).toHaveAttribute("data-status", "approval_required");
    expect(card).toHaveAttribute("data-proposal-id", "prop-add-1");
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(await screen.findByText("Awaiting your decision")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(proposalMocks.decideOperationProposalAction).toHaveBeenCalledWith({
      proposalId: "prop-add-1",
      decision: "approve",
    });
    expect(await screen.findByText("Completed")).toBeInTheDocument();
  });

  it("renders a native queued write part honestly as Queued (never Completed or Written)", async () => {
    proposalMocks.getOperationProposalAction.mockResolvedValueOnce({
      success: true,
      data: {
        id: "prop-q-1",
        toolName: "notion_create_page",
        status: "APPROVED",
        derived: "queued",
        input: { title: "Offer Tracker", content: "Offer details" },
        conversationId: "conv-1",
        sourceArchived: false,
        approvalId: "ap-q-1",
        toolCallId: "native-mcp-q1",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        decidedAt: new Date().toISOString(),
        decisionReason: "FULL_ACCESS_PREAUTHORIZED",
        dispatched: false,
        taskId: "task-q-1",
        taskStatus: "QUEUED",
        outcomeStatus: null,
        outcome: null,
        manualResolution: null,
        supersedesId: null,
      },
    });
    chat.messages = [
      assistant([
        {
          type: AGENT_NATIVE_TOOL_PART_TYPE,
          id: "native-tool-q1",
          data: {
            version: 1,
            kind: "tool",
            itemId: "q1",
            tool: "notion_create_page",
            status: "queued",
            proposalId: "prop-q-1",
            approvalId: "ap-q-1",
            taskId: "task-q-1",
          },
        },
      ]),
    ];

    render(<AgentChatMessages />);
    const card = screen.getByTestId("agent-native-tool-card");
    expect(card).toHaveAttribute("data-status", "queued");
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(await screen.findByText("Queued for background execution")).toBeInTheDocument();
    expect(screen.queryByText("Written to Notion")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });
});
