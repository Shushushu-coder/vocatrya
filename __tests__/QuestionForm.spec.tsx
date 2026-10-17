import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionForm } from "@/components/questions/QuestionForm";
import { createQuestion, updateQuestion } from "@/actions/question.actions";
import type { Question } from "@/models/question.model";

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/actions/question.actions", () => ({
  createQuestion: vi.fn().mockResolvedValue({ success: true }),
  updateQuestion: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/actions/tag.actions", () => ({
  createTag: vi.fn().mockResolvedValue({ success: true }),
}));

// Same jsdom stubs DialogOverlay.spec.tsx installs for Radix/Tiptap.
document.createRange = () => {
  const range = new Range();
  range.getBoundingClientRect = vi.fn().mockReturnValue({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });
  range.getClientRects = () => ({
    item: () => null,
    length: 0,
    [Symbol.iterator]: vi.fn(),
  });
  return range;
};

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

const noop = () => {};

function renderForm(props: Partial<Parameters<typeof QuestionForm>[0]> = {}) {
  return render(
    <QuestionForm
      availableTags={[]}
      editQuestion={null}
      resetEditQuestion={noop}
      onQuestionSaved={noop}
      dialogOpen={true}
      setDialogOpen={noop}
      {...props}
    />,
  );
}

const tbdQuestion: Question = {
  id: "q-1",
  question: "What is React?",
  answer: "TBD",
  createdBy: "user-id",
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("QuestionForm answer truthfulness", () => {
  it("opens the new-question dialog with an empty answer and a visual placeholder", async () => {
    renderForm();
    const dialog = await screen.findByRole("dialog");

    await waitFor(() =>
      expect(
        within(dialog).getByText("Enter text here..."),
      ).toBeInTheDocument(),
    );
  });

  it("saves a new question with an empty answer instead of fabricating TBD", async () => {
    const user = userEvent.setup();
    renderForm();
    const dialog = await screen.findByRole("dialog");

    await user.type(
      within(dialog).getByPlaceholderText("Enter interview question"),
      "What is React?",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          question: "What is React?",
          answer: "",
        }),
      ),
    );
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("keeps a historical TBD answer unchanged when only other fields are edited", async () => {
    const user = userEvent.setup();
    renderForm({ editQuestion: tbdQuestion });
    const dialog = await screen.findByRole("dialog");

    const questionInput = within(dialog).getByPlaceholderText(
      "Enter interview question",
    );
    await user.clear(questionInput);
    await user.type(questionInput, "Explain JSX?");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "q-1",
          question: "Explain JSX?",
          answer: "TBD",
        }),
      ),
    );
    expect(createQuestion).not.toHaveBeenCalled();
  });

  it("blocks a short non-TBD answer instead of saving it", async () => {
    const user = userEvent.setup();
    renderForm({ editQuestion: { ...tbdQuestion, answer: "short" } });
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText(
        "Answer must be at least 10 characters.",
      ),
    ).toBeInTheDocument();
    expect(updateQuestion).not.toHaveBeenCalled();
    expect(createQuestion).not.toHaveBeenCalled();
  });

  it("submits a valid answer unchanged", async () => {
    const user = userEvent.setup();
    const answer = "<p>A solid STAR answer</p>";
    renderForm({ editQuestion: { ...tbdQuestion, answer } });
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ id: "q-1", answer }),
      ),
    );
  });

  it("cancel closes the dialog without calling any action", async () => {
    const user = userEvent.setup();
    const setDialogOpen = vi.fn();
    const resetEditQuestion = vi.fn();
    renderForm({ setDialogOpen, resetEditQuestion });
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(setDialogOpen).toHaveBeenCalledWith(false);
    expect(resetEditQuestion).toHaveBeenCalled();
    expect(createQuestion).not.toHaveBeenCalled();
    expect(updateQuestion).not.toHaveBeenCalled();
  });
});


it("prevents repeat question submission while the real save is pending", async () => {
  let finish!: (value: Awaited<ReturnType<typeof createQuestion>>) => void;
  vi.mocked(createQuestion).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup();
  renderForm();
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText("Enter interview question"), "Synthetic pending question?");
  const save = within(dialog).getByRole("button", { name: "Save" });
  await user.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(save).toHaveAttribute("aria-busy", "true");
  await user.click(save);
  expect(createQuestion).toHaveBeenCalledTimes(1);
  finish({ success: true } as never);
  await waitFor(() => expect(save).not.toBeDisabled());
});
