import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DictationTestControls } from "@/components/settings/DictationTestControls";
import { useDictation, type UseDictation } from "@/lib/dictation/useDictation";

vi.mock("@/lib/dictation/useDictation", () => ({ useDictation: vi.fn() }));

function state(overrides: Partial<UseDictation> = {}): UseDictation {
  return { phase: "idle", elapsedMs: 0, error: null, canRetry: false,
    start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn(), ...overrides };
}

it("starts only after configuration is saved and previews the returned text", async () => {
  const dictation = state();
  vi.mocked(useDictation).mockReturnValue(dictation);
  const user = userEvent.setup();
  const view = render(<DictationTestControls enabled={false} ownershipKey="saved-config" />);
  await user.click(screen.getByRole("button", { name: "Test transcription" }));
  expect(dictation.start).not.toHaveBeenCalled();
  view.rerender(<DictationTestControls enabled ownershipKey="saved-config" />);
  await user.click(screen.getByRole("button", { name: "Test transcription" }));
  expect(dictation.start).toHaveBeenCalledOnce();
  const options = vi.mocked(useDictation).mock.lastCall![0];
  expect(options.maxDurationMs).toBe(15_000);
  act(() => options.onTranscript("面试岗位是前端工程师"));
  expect(screen.getByRole("status")).toHaveTextContent("面试岗位是前端工程师");
  expect(screen.getByRole("status")).toHaveTextContent("Transcription succeeded");
});

it("shows an actionable authentication error without claiming success", () => {
  vi.mocked(useDictation).mockReturnValue(state({ phase: "error", canRetry: true,
    error: { kind: "transcribe", code: "DICTATION_AUTH_FAILED" } }));
  render(<DictationTestControls enabled ownershipKey="saved-config" />);
  expect(screen.getByRole("alert")).toHaveTextContent("rejected the configured API key");
  expect(screen.queryByText(/Transcription succeeded/)).not.toBeInTheDocument();
});
