import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotesSection } from "@/components/myjobs/NotesSection";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";

vi.mock("@/actions/note.actions", () => ({
  getNotesByJobId: vi.fn(async () => ({ success: true, data: [{
    id: "note-1", jobId: "job-1", content: "Saved note", createdAt: new Date("2026-01-01"),
  }] })),
  deleteNote: vi.fn(),
}));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@/components/myjobs/NoteDialog", () => ({
  NoteDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Note editor</div> : null,
}));
vi.mock("@/components/DeleteAlertDialog", () => ({
  DeleteAlertDialog: ({ open }: { open: boolean }) => open ? <div role="alertdialog" /> : null,
}));

it("keeps saved notes readable while disabling all note mutation entry points", async () => {
  const wrap = (trigger: number) => <CareerSurfacesProvider freshNativeFull={false} jobMutationsEnabled={false}>
    <NotesSection jobId="job-1" openTrigger={trigger} />
  </CareerSurfacesProvider>;
  const { rerender } = render(wrap(0));
  const saved = await screen.findByText("Saved note");
  const card = saved.closest("div.border.rounded-lg") as HTMLElement;
  for (const button of within(card).getAllByRole("button")) expect(button).toBeDisabled();
  const add = screen.getByRole("button", { name: /new note/i });
  expect(add).toBeDisabled();
  await userEvent.click(add);
  rerender(wrap(1));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the existing writable behavior outside the runtime provider", async () => {
  render(<NotesSection jobId="job-1" />);
  await screen.findByText("Saved note");
  const add = screen.getByRole("button", { name: /new note/i });
  expect(add).toBeEnabled();
  await userEvent.click(add);
  expect(screen.getByRole("dialog")).toHaveTextContent("Note editor");
});
