import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const chat = {
  messages: [] as any[],
  status: "ready" as string,
  regenerate: vi.fn(),
  resumeStream: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  interruptedTurn: false,
  dismissInterrupted: vi.fn(),
  toolStreams: {} as Record<string, string>,
  approvalPending: false,
  conversationId: "conv-1" as string | null,
};
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div data-testid="tiptap-content" dangerouslySetInnerHTML={{ __html: content }} />
  ),
}));
vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
}));
// Assertions pin the bound i18n keys so the contract keeps holding once the
// shared dictionary merge lands on Main.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatNumber: (n: number) => String(n),
  }),
}));

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";
import { regenerateTailHasWriteReceipt } from "@/lib/agent/writeReceipt";

const assistant = (parts: any[], id = "a1") => ({ id, role: "assistant", parts });
const user = (parts: any[], id = "u1") => ({ id, role: "user", parts });
const textPart = (text: string) => ({ type: "text", text });
const createdJobPart = {
  type: "tool-add_job",
  toolCallId: "c1",
  state: "output-available",
  input: { company: "Acme" },
  output: { created: true, jobId: "j1", resolutions: [] },
};
const readToolPart = {
  type: "tool-list_jobs",
  toolCallId: "l1",
  state: "output-available",
  input: {},
  output: { status: "ok", jobs: [] },
};

const REGEN = "agentAnswer.regenerate";
const COPY = "agentAnswer.copy";

describe("regenerateTailHasWriteReceipt", () => {
  it("scopes the receipt check to the tail after the last user message", () => {
    const messages = [
      user([textPart("add this")]),
      assistant([createdJobPart, textPart("Added.")], "a1"),
      user([textPart("another question")], "u2"),
      assistant([textPart("plain answer")], "a2"),
    ] as any;
    expect(regenerateTailHasWriteReceipt(messages)).toBe(false);
    expect(regenerateTailHasWriteReceipt(messages.slice(0, 2))).toBe(true);
  });
});

describe("AgentChatMessages regenerate answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.messages = [];
    chat.status = "ready";
    chat.interruptedTurn = false;
    chat.toolStreams = {};
    chat.approvalPending = false;
    chat.conversationId = "conv-1";
  });

  it("offers regenerate only on the latest completed answer and calls it with that message id", async () => {
    chat.messages = [
      user([textPart("first")], "u1"),
      assistant([textPart("older answer")], "a1"),
      user([textPart("second")], "u2"),
      assistant([textPart("latest answer")], "a2"),
    ];
    render(<AgentChatMessages />);
    const buttons = screen.getAllByRole("button", { name: REGEN });
    expect(buttons).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: COPY })).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(chat.regenerate).toHaveBeenCalledWith("a2");
    expect(chat.regenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps regenerate available on a read-only tool answer", () => {
    chat.messages = [
      user([textPart("what jobs do I have")]),
      assistant([readToolPart, textPart("You have no jobs yet.")]),
    ];
    render(<AgentChatMessages />);
    expect(screen.getByRole("button", { name: REGEN })).toBeInTheDocument();
  });

  it("hides regenerate on an answer that already saved a write", () => {
    chat.messages = [
      user([textPart("add this job")]),
      assistant([createdJobPart, textPart("Added Acme.")]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("button", { name: REGEN })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: COPY })).toBeInTheDocument();
  });

  it("hides regenerate while an approval is still pending", () => {
    chat.approvalPending = true;
    chat.messages = [
      user([textPart("question")]),
      assistant([textPart("answer")]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("button", { name: REGEN })).not.toBeInTheDocument();
  });

  it("hides regenerate while the turn is still streaming", () => {
    chat.status = "streaming";
    chat.messages = [
      user([textPart("question")]),
      assistant([textPart("still coming")]),
    ];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("button", { name: REGEN })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: COPY })).toBeInTheDocument();
  });

  it("hides regenerate on a draft with no persisted conversation", () => {
    chat.conversationId = null;
    chat.messages = [assistant([textPart("answer")])];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("button", { name: REGEN })).not.toBeInTheDocument();
  });

  it("offers nothing on a user-ending transcript and never on user messages", () => {
    chat.messages = [user([textPart("awaiting a reply")])];
    render(<AgentChatMessages />);
    expect(screen.queryByRole("button", { name: REGEN })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY })).not.toBeInTheDocument();
  });

  it("is reachable and operable by keyboard", async () => {
    const user_ = userEvent.setup();
    chat.messages = [
      user([textPart("question")]),
      assistant([textPart("keyboard answer")]),
    ];
    render(<AgentChatMessages />);
    const button = screen.getByRole("button", { name: REGEN });
    await user_.tab();
    expect(screen.getByRole("button", { name: COPY })).toHaveFocus();
    await user_.tab();
    expect(button).toHaveFocus();
    await user_.keyboard("{Enter}");
    expect(chat.regenerate).toHaveBeenCalledWith("a1");
  });
});
