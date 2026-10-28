import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";
import { assistantAnswerCopyText } from "@/lib/agent/answerCopyText";
import { toastError } from "@/lib/toast";

const assistant = (parts: any[], id = "a1") => ({ id, role: "assistant", parts });
const user = (parts: any[], id = "u1") => ({ id, role: "user", parts });

const writeTextMock = () =>
  navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

// userEvent.setup installs its own clipboard stub, so mockClipboard must run
// after setup when the two are combined (the keyboard test).
function mockClipboard(impl?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: vi
        .fn()
        .mockImplementation(impl ?? (() => Promise.resolve())),
    },
    configurable: true,
  });
}

const lastWritten = () => writeTextMock().mock.calls.at(-1)![0] as string;

describe("assistantAnswerCopyText", () => {
  it("joins visible text parts in display order separated by a blank line", () => {
    const text = assistantAnswerCopyText([
      { type: "text", text: "第一段" },
      { type: "tool-add_job", toolCallId: "c1", state: "output-available" },
      { type: "text", text: "第二段" },
    ]);
    expect(text).toBe("第一段\n\n第二段");
  });

  it("keeps the markdown source and inner line breaks verbatim", () => {
    const text = assistantAnswerCopyText([
      { type: "text", text: "## 建议\n\n- 第一条\n- 第二条" },
    ]);
    expect(text).toBe("## 建议\n\n- 第一条\n- 第二条");
  });

  it("drops hidden reasoning the same way the renderer does", () => {
    const text = assistantAnswerCopyText([
      { type: "reasoning", text: "scratchpad" },
      { type: "text", text: "<think>secret plan</think>可见回答" },
      { type: "text", text: "前缀<think>未完思考" },
    ]);
    expect(text).toBe("可见回答\n\n前缀");
  });

  it("ignores whitespace-only parts and reports an empty answer as empty", () => {
    expect(
      assistantAnswerCopyText([
        { type: "text", text: "   \n  " },
        { type: "text", text: "<think>only thinking</think>" },
      ]),
    ).toBe("");
    expect(assistantAnswerCopyText([{ type: "tool-add_job" }])).toBe("");
    expect(assistantAnswerCopyText([])).toBe("");
  });
});

describe("AgentChatMessages copy answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboard();
    chat.messages = [];
    chat.status = "ready";
    chat.interruptedTurn = false;
    chat.toolStreams = {};
  });

  it("copies a markdown answer, Chinese included, verbatim from its source", async () => {
    const source = "## 建议\n\n- **公司**：字节跳动\n- 保留换行";
    chat.messages = [
      user([{ type: "text", text: "帮我看看这个岗位" }]),
      assistant([{ type: "text", text: source }]),
    ];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe(source);
  });

  it("copies multi-part prose in display order, tool output excluded", async () => {
    chat.messages = [
      assistant([
        { type: "text", text: "先说结论。" },
        {
          type: "tool-add_job",
          toolCallId: "c1",
          state: "output-available",
          input: { company: "Acme" },
          output: { created: true, jobId: "j1", resolutions: [] },
        },
        { type: "text", text: "再补一句。" },
      ]),
    ];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = lastWritten();
    expect(text).toBe("先说结论。\n\n再补一句。");
    expect(text).not.toContain("Acme");
  });

  it("never puts hidden reasoning or raw tool input on the clipboard", async () => {
    chat.messages = [
      assistant([
        { type: "reasoning", text: "the scratchpad stays hidden" },
        { type: "text", text: "<think>hidden plan</think>Added." },
        {
          type: "tool-add_job",
          toolCallId: "c1",
          state: "approval-requested",
          input: { company: "Acme", jobTitle: "Platform Engineer" },
          approval: { id: "ap1" },
        },
      ]),
    ];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("Added.");
  });

  it("offers no action on a pure tool result or an empty answer", () => {
    chat.messages = [
      assistant(
        [
          {
            type: "tool-add_job",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { created: true, jobId: "j1", resolutions: [] },
          },
        ],
        "a1",
      ),
      assistant([{ type: "text", text: "   " }], "a2"),
      assistant([], "a3"),
      user([{ type: "text", text: "user words need no copy row" }]),
    ];
    render(<AgentChatMessages />);
    expect(
      screen.queryByRole("button", { name: "Copy answer" }),
    ).not.toBeInTheDocument();
  });

  it("copies the snapshot that is visible while the answer is still streaming", async () => {
    chat.status = "streaming";
    chat.messages = [assistant([{ type: "text", text: "I found the" }])];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("I found the");
  });

  it("copies each answer on a reloaded history transcript, scoped to its own message", async () => {
    chat.messages = [
      user([{ type: "text", text: "first" }], "u1"),
      assistant([{ type: "text", text: "older answer" }], "a1"),
      user([{ type: "text", text: "second" }], "u2"),
      assistant([{ type: "text", text: "newer answer" }], "a2"),
    ];
    render(<AgentChatMessages />);
    const buttons = screen.getAllByRole("button", { name: "Copy answer" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("older answer");
    fireEvent.click(buttons[1]);
    await waitFor(() =>
      expect(writeTextMock()).toHaveBeenCalledTimes(2),
    );
    expect(lastWritten()).toBe("newer answer");
  });

  it("reports a real failure toast and lets a retry succeed", async () => {
    chat.messages = [assistant([{ type: "text", text: "retry me" }])];
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<AgentChatMessages />);
    const button = screen.getByRole("button", { name: "Copy answer" });
    fireEvent.click(button);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Copied" }),
    ).not.toBeInTheDocument();

    mockClipboard();
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("retry me");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument(),
    );
  });

  it("flips the accessible label to Copied on success and back after the timeout", async () => {
    chat.messages = [assistant([{ type: "text", text: "feedback" }])];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument(),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "Copy answer" }),
        ).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it("is reachable and operable by keyboard", async () => {
    const user_ = userEvent.setup();
    mockClipboard();
    chat.messages = [
      user([{ type: "text", text: "question" }]),
      assistant([{ type: "text", text: "keyboard answer" }]),
    ];
    render(<AgentChatMessages />);
    const button = screen.getByRole("button", { name: "Copy answer" });
    await user_.tab();
    expect(button).toHaveFocus();
    await user_.keyboard("{Enter}");
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("keyboard answer");
  });
});
