import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionCard } from "@/components/questions/QuestionCard";
import type { Question } from "@/models/question.model";

vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => <div data-testid="answer-content">{content}</div>,
}));

const makeQuestion = (answer: string | null = "A short answer"): Question => ({
  id: "q1", question: "Evaluate an app", answer, createdBy: "u1",
  tags: [{ id: "t1", label: "Product analysis", value: "product", createdBy: "u1" }],
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
});

it("keeps the question and tags visible while short answers start collapsed", async () => {
  render(<QuestionCard question={makeQuestion()} onEdit={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Evaluate an app" })).toBeVisible();
  expect(screen.getByText("Product analysis")).toBeVisible();
  expect(screen.queryByTestId("answer-content")).not.toBeInTheDocument();
  const toggle = screen.getByTestId("question-answer-toggle");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(screen.getByTestId("answer-content")).toHaveTextContent("A short answer");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(toggle);
  expect(screen.queryByTestId("answer-content")).not.toBeInTheDocument();
});

it("expands full rich-text answers without slicing HTML and supports keyboard toggling", async () => {
  const answer = `<p><strong>${"Complete answer ".repeat(40)}</strong></p>`;
  render(<QuestionCard question={makeQuestion(answer)} onEdit={vi.fn()} onDelete={vi.fn()} />);
  const toggle = screen.getByTestId("question-answer-toggle");
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByTestId("answer-content").textContent).toBe(answer);
  await userEvent.keyboard(" ");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it.each([null, "<p></p>"])("omits the answer control for empty content: %s", (answer) => {
  render(<QuestionCard question={makeQuestion(answer)} onEdit={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.queryByTestId("question-answer-toggle")).not.toBeInTheDocument();
});

it("does not toggle answers when editing or clicking the question", async () => {
  const onEdit = vi.fn(), question = makeQuestion();
  render(<QuestionCard question={question} onEdit={onEdit} onDelete={vi.fn()} />);
  await userEvent.click(screen.getByRole("heading"));
  await userEvent.click(screen.getByTestId("question-edit-btn"));
  expect(onEdit).toHaveBeenCalledWith(question);
  expect(screen.getByTestId("question-answer-toggle")).toHaveAttribute("aria-expanded", "false");
});
