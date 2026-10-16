import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TaskForm } from "@/components/tasks/TaskForm";
import { QuestionForm } from "@/components/questions/QuestionForm";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/actions/task.actions", () => ({
  createTask: vi.fn().mockResolvedValue({ success: true, data: { id: "task-id" } }),
  updateTask: vi.fn().mockResolvedValue({ success: true, data: { id: "task-id" } }),
}));

vi.mock("@/actions/question.actions", () => ({
  createQuestion: vi.fn().mockResolvedValue({ success: true }),
  updateQuestion: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/actions/tag.actions", () => ({
  createTag: vi.fn().mockResolvedValue({ success: true }),
}));

// Both form dialogs are built on the shared ui/dialog primitives. The scrim is
// the only `.fixed.inset-0` element Radix mounts for them, so counting matches
// is the single-layer regression check: before the fix these forms rendered two.
const OVERLAY = ".fixed.inset-0";
const overlays = () => document.body.querySelectorAll<HTMLElement>(OVERLAY);

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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

function taskForm(open: boolean, setDialogOpen: (o: boolean) => void = noop) {
  return (
    <TaskForm
      activityTypes={[]}
      editTask={null}
      resetEditTask={noop}
      onTaskSaved={noop}
      dialogOpen={open}
      setDialogOpen={setDialogOpen}
    />
  );
}

function questionForm(
  open: boolean,
  setDialogOpen: (o: boolean) => void = noop,
) {
  return (
    <QuestionForm
      availableTags={[]}
      editQuestion={null}
      resetEditQuestion={noop}
      onQuestionSaved={noop}
      dialogOpen={open}
      setDialogOpen={setDialogOpen}
    />
  );
}

function openDialog(
  renderNode: (open: boolean, setOpen: (o: boolean) => void) => React.ReactNode,
) {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button data-testid="open-dialog" onClick={() => setOpen(true)}>
          open
        </button>
        <button data-testid="background-sentinel">background</button>
        {renderNode(open, setOpen)}
      </>
    );
  }
  render(<Harness />);
  return user;
}

describe("shared dialog overlay contract", () => {
  it.each([
    ["TaskForm", taskForm, "task-form-dialog-title"],
    ["QuestionForm", questionForm, "question-form-dialog-title"],
  ])("%s renders exactly one effective overlay", async (_name, node, titleId) => {
    const user = openDialog(node);
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByTestId(titleId);

    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toHaveClass("bg-overlay-bg");
  });

  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.keyboard("{Escape}");
    }],
    ["X close button", async (user: ReturnType<typeof userEvent.setup>) => {
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
    }],
    ["Cancel button", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
    }],
    ["outside click", async (user: ReturnType<typeof userEvent.setup>) => {
      await screen.findByRole("dialog");
      await user.click(overlays()[0]);
    }],
  ])("TaskForm closes via %s", async (_name, act) => {
    const user = openDialog(taskForm);
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByTestId("task-form-dialog-title");

    await act(user);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(overlays()).toHaveLength(0);
  });

  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.keyboard("{Escape}");
    }],
    ["X close button", async (user: ReturnType<typeof userEvent.setup>) => {
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
    }],
    ["Cancel button", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
    }],
    ["outside click", async (user: ReturnType<typeof userEvent.setup>) => {
      await screen.findByRole("dialog");
      await user.click(overlays()[0]);
    }],
  ])("QuestionForm closes via %s", async (_name, act) => {
    const user = openDialog(questionForm);
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByTestId("question-form-dialog-title");

    await act(user);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(overlays()).toHaveLength(0);
  });

  it("moves focus into the dialog on open and out of it on close", async () => {
    const user = openDialog(taskForm);
    await user.click(screen.getByTestId("open-dialog"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // These forms are controlled dialogs with no DialogTrigger, so Radix has
    // no trigger node to restore to and focus lands on <body> — same on main.
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  it("restores focus to a Radix DialogTrigger on close", async () => {
    render(
      <Dialog>
        <DialogTrigger data-testid="radix-trigger">open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Trigger dialog</DialogTitle>
          <DialogDescription>desc</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const user = userEvent.setup();
    const trigger = screen.getByTestId("radix-trigger");
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("locks background scroll and aria-hides siblings while open, releasing both on close", async () => {
    const user = openDialog(taskForm);
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByRole("dialog");

    const sentinel = screen.getByTestId("background-sentinel");
    expect(sentinel.closest("[aria-hidden='true']")).not.toBeNull();
    expect(document.body).toHaveAttribute("data-scroll-locked");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(sentinel.closest("[aria-hidden='true']")).toBeNull(),
    );
    expect(document.body).not.toHaveAttribute("data-scroll-locked");
  });

  // Radix 1.1.x does not emit aria-modal; the audited AT contract here is
  // role=dialog + aria-labelledby/describedby + aria-hidden on siblings +
  // focus trap + scroll lock. Pinned so a future change is deliberate.
  it("exposes the Radix dialog a11y contract", async () => {
    const user = openDialog(taskForm);
    await user.click(screen.getByTestId("open-dialog"));
    const dialog = await screen.findByRole("dialog");

    const labelId = dialog.getAttribute("aria-labelledby");
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(labelId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent("Add Task");
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "Add a new task to track.",
    );
    expect(dialog).not.toHaveAttribute("aria-modal");
  });
});

describe("AlertDialog scrim and close safety", () => {
  function alertHarness() {
    const onDelete = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="open-dialog" onClick={() => setOpen(true)}>
            open
          </button>
          <DeleteAlertDialog
            pageTitle="thing"
            open={open}
            onOpenChange={setOpen}
            onDelete={onDelete}
          />
        </>
      );
    }
    render(<Harness />);
    return { onDelete };
  }

  it("shares the single semantic overlay", async () => {
    alertHarness();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByRole("alertdialog");

    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toHaveClass("bg-overlay-bg");
  });

  it("does not close on background click, but closes on Escape and Cancel", async () => {
    alertHarness();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByRole("alertdialog");

    await user.click(overlays()[0]);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });
});

describe("Sheet modal vs non-modal", () => {
  it("modal sheet renders the shared overlay, hides siblings, and locks scroll", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="open-dialog" onClick={() => setOpen(true)}>
            open
          </button>
          <button data-testid="background-sentinel">background</button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent>
              <SheetTitle>Panel</SheetTitle>
            </SheetContent>
          </Sheet>
        </>
      );
    }
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("open-dialog"));
    await screen.findByRole("dialog");

    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toHaveClass("bg-overlay-bg");
    const sentinel = screen.getByTestId("background-sentinel");
    expect(sentinel.closest("[aria-hidden='true']")).not.toBeNull();
    expect(document.body).toHaveAttribute("data-scroll-locked");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("non-modal sheet with overlay={false} leaves the background alone", async () => {
    render(
      <>
        <button data-testid="background-sentinel">background</button>
        <Sheet open modal={false} onOpenChange={noop}>
          <SheetContent overlay={false}>
            <SheetTitle>Docked</SheetTitle>
          </SheetContent>
        </Sheet>
      </>,
    );
    await screen.findByRole("dialog");

    expect(overlays()).toHaveLength(0);
    const sentinel = screen.getByTestId("background-sentinel");
    expect(sentinel.closest("[aria-hidden='true']")).toBeNull();
    expect(document.body).not.toHaveAttribute("data-scroll-locked");
  });
});
