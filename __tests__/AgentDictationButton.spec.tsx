// AWU-DICTATION composer control: renders the state machine's phases as a
// toolbar control — mic → stop/cancel + timer → busy → error/retry. The
// hook itself is mocked; its spec covers the state machine.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDictationButton } from "@/components/agent/AgentDictationButton";
import {
  useDictation,
  type UseDictation,
} from "@/lib/dictation/useDictation";

vi.mock("@/lib/dictation/useDictation", () => ({
  useDictation: vi.fn(),
}));

function state(overrides: Partial<UseDictation> = {}): UseDictation {
  return {
    phase: "idle",
    elapsedMs: 0,
    error: null,
    canRetry: false,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

const insertText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentDictationButton", () => {
  it("renders a mic button at rest and starts dictation on click", async () => {
    const dictation = state();
    vi.mocked(useDictation).mockReturnValue(dictation);
    const user = userEvent.setup();
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    await user.click(screen.getByTestId("agent-dictation-start"));
    expect(dictation.start).toHaveBeenCalledTimes(1);
    expect(useDictation).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipKey: "job:conv-1" }),
    );
  });

  it("hands transcripts to the mount-site insertion callback", () => {
    vi.mocked(useDictation).mockReturnValue(state());
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    const onTranscript = vi.mocked(useDictation).mock.calls[0]![0]
      .onTranscript;
    onTranscript(" dictated words ");
    expect(insertText).toHaveBeenCalledWith(" dictated words ");
  });

  it("shows the timer plus stop and cancel while recording", async () => {
    const dictation = state({ phase: "recording", elapsedMs: 65_000 });
    vi.mocked(useDictation).mockReturnValue(dictation);
    const user = userEvent.setup();
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    expect(screen.getByTestId("agent-dictation-timer")).toHaveTextContent(
      "1:05",
    );
    await user.click(screen.getByTestId("agent-dictation-stop"));
    expect(dictation.stop).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("agent-dictation-cancel"));
    expect(dictation.cancel).toHaveBeenCalledTimes(1);
  });

  it("shows a cancellable busy state while transcribing", async () => {
    const dictation = state({ phase: "transcribing" });
    vi.mocked(useDictation).mockReturnValue(dictation);
    const user = userEvent.setup();
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    expect(screen.getByTestId("agent-dictation-busy")).toHaveTextContent(
      "Transcribing",
    );
    await user.click(screen.getByTestId("agent-dictation-cancel"));
    expect(dictation.cancel).toHaveBeenCalledTimes(1);
  });

  it("offers retry plus dismiss on a failure with a retained clip", async () => {
    const dictation = state({
      phase: "error",
      canRetry: true,
      error: { kind: "transcribe", code: "DICTATION_TIMEOUT" },
    });
    vi.mocked(useDictation).mockReturnValue(dictation);
    const user = userEvent.setup();
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("timed out");
    await user.click(screen.getByTestId("agent-dictation-retry"));
    expect(dictation.retry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("agent-dictation-dismiss"));
    expect(dictation.dismiss).toHaveBeenCalledTimes(1);
  });

  it("hides retry when the retained clip is gone", () => {
    vi.mocked(useDictation).mockReturnValue(
      state({
        phase: "error",
        canRetry: false,
        error: { kind: "mic", micKind: "denied" },
      }),
    );
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("denied");
    expect(
      screen.queryByTestId("agent-dictation-retry"),
    ).not.toBeInTheDocument();
  });

  it("honors the external disabled gate", () => {
    const dictation = state();
    vi.mocked(useDictation).mockReturnValue(dictation);
    render(
      <AgentDictationButton
        insertText={insertText}
        ownershipKey="job:conv-1"
        disabled
      />,
    );
    expect(screen.getByTestId("agent-dictation-start")).toBeDisabled();
  });
});
