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
// The code-block labels ship with the i18n integration commit; assertions pin
// the keys the component binds, so they keep holding once translations land.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatNumber: (n: number) => String(n),
  }),
}));

import { AgentChatMessages } from "@/components/agent/AgentChatMessages";
import { splitAgentMarkdown } from "@/lib/agent/markdown";
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

const CODE_BUTTON = "agentCodeBlock.copy";
const COPIED_BUTTON = "agentCodeBlock.copied";
const ANSWER_BUTTON = "agentAnswer.copy";

describe("splitAgentMarkdown", () => {
  it("returns one markdown segment for prose without fences", () => {
    expect(splitAgentMarkdown("## 标题\n\n- 一\n- 二")).toEqual([
      { kind: "markdown", text: "## 标题\n\n- 一\n- 二" },
    ]);
  });

  it("detaches a fenced block and yields the verbatim code body", () => {
    const source = "先看这段：\n\n```ts\nconst a = 1;\n  indented;\n```\n\n再说。";
    // Markdown segments keep their boundary blank lines verbatim; the blank
    // separators render the same either way.
    expect(splitAgentMarkdown(source)).toEqual([
      { kind: "markdown", text: "先看这段：\n" },
      { kind: "code", language: "ts", code: "const a = 1;\n  indented;\n" },
      { kind: "markdown", text: "\n再说。" },
    ]);
  });

  it("splits alternating prose and multiple code blocks in order", () => {
    const source = "a\n```ts\none\n```\nb\n```\ntwo\n```\nc";
    expect(splitAgentMarkdown(source)).toEqual([
      { kind: "markdown", text: "a" },
      { kind: "code", language: "ts", code: "one\n" },
      { kind: "markdown", text: "b" },
      { kind: "code", language: "", code: "two\n" },
      { kind: "markdown", text: "c" },
    ]);
  });

  it("keeps indentation and inner blank lines in the code body", () => {
    const code = "def f():\n    x = 1\n\n    return x\n";
    const [segment] = splitAgentMarkdown("```text\n" + code + "```");
    expect(segment).toEqual({ kind: "code", language: "text", code });
  });

  it("uses the first info-string word as the language label", () => {
    const [, block] = splitAgentMarkdown("x\n```js extra meta\ny\n```");
    expect(block).toEqual({ kind: "code", language: "js", code: "y\n" });
  });

  it("treats an unclosed fence as a fence to end of input, as streaming renders", () => {
    expect(splitAgentMarkdown("说明\n```js\nconst a")).toEqual([
      { kind: "markdown", text: "说明" },
      { kind: "code", language: "js", code: "const a" },
    ]);
  });

  it("leaves a fence nested in a list inside the markdown segment", () => {
    const source = "- item\n  ```js\n  nested\n  ```\n- next";
    expect(splitAgentMarkdown(source)).toEqual([
      { kind: "markdown", text: source },
    ]);
  });

  it("leaves indented code inside the markdown segment", () => {
    const source = "intro\n    indented code\n\noutro";
    expect(splitAgentMarkdown(source)).toEqual([
      { kind: "markdown", text: source },
    ]);
  });

  it("strips hidden reasoning before splitting, same as the renderer", () => {
    expect(
      splitAgentMarkdown("<think>```js\nsecret\n```</think>```py\nshown\n```"),
    ).toEqual([{ kind: "code", language: "py", code: "shown\n" }]);
  });

  it("maps lines correctly when the source uses \\r\\n", () => {
    expect(splitAgentMarkdown("a\r\n```js\r\nx\r\n```\r\nb")).toEqual([
      { kind: "markdown", text: "a" },
      { kind: "code", language: "js", code: "x\n" },
      { kind: "markdown", text: "b" },
    ]);
  });

  it("preserves literal Unicode separators in code instead of changing its content", () => {
    const code = 'const text = "a\u2028b\u2029c";\n';
    expect(splitAgentMarkdown("```js\n" + code + "```\nafter")).toEqual([
      { kind: "code", language: "js", code },
      { kind: "markdown", text: "after" },
    ]);
  });

  it("returns no segments for empty, whitespace-only or fully hidden input", () => {
    expect(splitAgentMarkdown("")).toEqual([]);
    expect(splitAgentMarkdown("  \n  ")).toEqual([]);
    expect(splitAgentMarkdown("<think>only thinking</think>")).toEqual([]);
  });
});

describe("AgentChatMessages code block copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboard();
    chat.messages = [];
    chat.status = "ready";
    chat.interruptedTurn = false;
    chat.toolStreams = {};
  });

  it("copies the code body only — no fences, language tag or surrounding prose", async () => {
    chat.messages = [
      assistant([
        {
          type: "text",
          text: "试这个：\n\n```python\nprint('你好')\n  x = 1\n```\n\n跑完告诉我。",
        },
      ]),
    ];
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: CODE_BUTTON }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = lastWritten();
    expect(text).toBe("print('你好')\n  x = 1\n");
    expect(text).not.toContain("试这个");
    expect(text).not.toContain("python");
    expect(text).not.toContain("```");
  });

  it("copies each code block independently when an answer has several", async () => {
    chat.messages = [
      assistant([
        {
          type: "text",
          text: "第一段\n```ts\none\n```\n中间说明\n```sh\ntwo\n```\n结尾",
        },
      ]),
    ];
    render(<AgentChatMessages />);
    const buttons = screen.getAllByRole("button", { name: CODE_BUTTON });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("one\n");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalledTimes(2));
    expect(lastWritten()).toBe("two\n");
  });

  it("keeps the whole-answer copy action alongside the code block buttons", async () => {
    const source = "说明\n```ts\ncode\n```";
    chat.messages = [assistant([{ type: "text", text: source }])];
    render(<AgentChatMessages />);
    expect(
      screen.getByRole("button", { name: CODE_BUTTON }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ANSWER_BUTTON }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    // Whole-answer copy still takes the markdown source, fences included.
    expect(lastWritten()).toBe(source);
  });

  it("scopes code copy across reloaded history messages", async () => {
    chat.messages = [
      user([{ type: "text", text: "first" }], "u1"),
      assistant([{ type: "text", text: "```ts\nold\n```" }], "a1"),
      user([{ type: "text", text: "second" }], "u2"),
      assistant([{ type: "text", text: "```ts\nnew\n```" }], "a2"),
    ];
    render(<AgentChatMessages />);
    const buttons = screen.getAllByRole("button", { name: CODE_BUTTON });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("old\n");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalledTimes(2));
    expect(lastWritten()).toBe("new\n");
  });

  it("copies the code visible at click time while the block is still streaming", async () => {
    chat.status = "streaming";
    chat.messages = [
      assistant([{ type: "text", text: "```js\nconst a = 1;" }]),
    ];
    const { rerender } = render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: CODE_BUTTON }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("const a = 1;");

    // A later chunk extends the same block; the next click takes the grown
    // body, not the snapshot from the first click. The button may still show
    // its two-second copied feedback, so match either accessible name.
    chat.messages = [
      assistant([{ type: "text", text: "```js\nconst a = 1;\nconst b = 2;" }]),
    ];
    rerender(<AgentChatMessages />);
    fireEvent.click(
      screen.getByRole("button", { name: /agentCodeBlock\.(copy|copied)/ }),
    );
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalledTimes(2));
    expect(lastWritten()).toBe("const a = 1;\nconst b = 2;");
  });

  it("offers no code copy on an empty fence, a nested fence or indented code", () => {
    chat.messages = [
      assistant([
        {
          type: "text",
          text: "```\n```\n\n- item\n  ```js\n  nested\n  ```\n\n    indented",
        },
      ]),
    ];
    render(<AgentChatMessages />);
    expect(
      screen.queryByRole("button", { name: CODE_BUTTON }),
    ).not.toBeInTheDocument();
  });

  it("reports a real failure and lets a retry succeed", async () => {
    chat.messages = [assistant([{ type: "text", text: "```ts\ncode\n```" }])];
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<AgentChatMessages />);
    fireEvent.click(screen.getByRole("button", { name: CODE_BUTTON }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith("agentCodeBlock.copyFailed");
    expect(
      screen.queryByRole("button", { name: COPIED_BUTTON }),
    ).not.toBeInTheDocument();

    mockClipboard();
    fireEvent.click(screen.getByRole("button", { name: CODE_BUTTON }));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("code\n");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: COPIED_BUTTON }),
      ).toBeInTheDocument(),
    );
  });

  it("is reachable and operable by keyboard", async () => {
    const user_ = userEvent.setup();
    mockClipboard();
    chat.messages = [
      assistant([{ type: "text", text: "```ts\nkeyboard\n```" }]),
    ];
    render(<AgentChatMessages />);
    const button = screen.getByRole("button", { name: CODE_BUTTON });
    await user_.tab();
    expect(button).toHaveFocus();
    await user_.keyboard("{Enter}");
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    expect(lastWritten()).toBe("keyboard\n");
  });
});
