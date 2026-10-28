// SET-INPUT-PREFERENCES: field-level behavior for structured profile fields —
// Enter=next navigates the region (skipping disabled/hidden/read-only fields)
// and commits the previous field, Enter=newline keeps the blur-commit, IME
// composition never navigates, entry selection applies once on entry, hints
// match the real key map, and auto-focus only runs on an explicit entry.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({ success: true, data: null })),
}));
vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { assertBirthDate } from "@/lib/career/candidateProfileValidation";
import { StructuredInput } from "@/components/career/application-profile/StructuredField";
import { ApplicationProfileField } from "@/components/career/application-profile/ApplicationProfileField";
import {
  MaterialNotesField,
  MaterialTextField,
} from "@/components/career/application-profile/MaterialAutosaveField";
import {
  focusFirstRegionField,
  INPUT_PREF_REGION_ATTR,
  updateInputPreferences,
} from "@/lib/inputPreferences";

function Region({ children }: { children: ReactNode }) {
  return <div {...{ [INPUT_PREF_REGION_ATTR]: true }}>{children}</div>;
}

function renderTextPair({
  saveA = vi.fn(async () => true),
  saveB = vi.fn(async () => true),
  required = false,
  committedA = "aa",
} = {}) {
  render(
    <Region>
      <MaterialTextField
        label="Field A"
        committed={committedA}
        onSave={saveA}
        required={required}
        testId="f-a"
      />
      <MaterialTextField
        label="Field B"
        committed="bb"
        onSave={saveB}
        testId="f-b"
      />
    </Region>,
  );
  return {
    saveA,
    saveB,
    a: screen.getByTestId("f-a-input") as HTMLInputElement,
    b: screen.getByTestId("f-b-input") as HTMLInputElement,
  };
}

function enter(el: HTMLElement, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(el, { key: "Enter", ...init });
}

function focus(el: HTMLElement) {
  act(() => {
    el.focus();
  });
}

async function flushSelectionDefer() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe("structured field keyboard behavior", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("default Enter ends the single-line edit, commits, and never submits", () => {
    const saveA = vi.fn(async () => true);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Region>
          <MaterialTextField
            label="Field A"
            committed="aa"
            onSave={saveA}
            testId="f-a"
          />
          <MaterialTextField
            label="Field B"
            committed="bb"
            onSave={vi.fn(async () => true)}
            testId="f-b"
          />
        </Region>
      </form>,
    );
    const a = screen.getByTestId("f-a-input") as HTMLInputElement;
    const b = screen.getByTestId("f-b-input") as HTMLInputElement;
    focus(a);
    fireEvent.change(a, { target: { value: "a2" } });
    enter(a);
    expect(saveA).toHaveBeenCalledWith("a2");
    expect(document.activeElement).not.toBe(a);
    expect(document.activeElement).not.toBe(b);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter=next moves to the next field and commits the previous one", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveA = vi.fn(async () => true);
    const { a, b } = renderTextPair({ saveA });
    focus(a);
    fireEvent.change(a, { target: { value: "a2" } });
    enter(a);
    expect(document.activeElement).toBe(b);
    expect(saveA).toHaveBeenCalledWith("a2");
  });

  it("Enter=next on the last field only ends editing", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveB = vi.fn(async () => true);
    const { b } = renderTextPair({ saveB });
    focus(b);
    fireEvent.change(b, { target: { value: "b2" } });
    enter(b);
    expect(saveB).toHaveBeenCalledWith("b2");
    expect(document.activeElement).not.toBe(b);
  });

  it("skips disabled, read-only and hidden fields in the chain", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveA = vi.fn(async () => true);
    render(
      <Region>
        <MaterialTextField
          label="Field A"
          committed="aa"
          onSave={saveA}
          testId="f-a"
        />
        <input data-input-pref-field disabled aria-label="disabled" />
        <input data-input-pref-field readOnly aria-label="readonly" />
        <input
          data-input-pref-field
          style={{ display: "none" }}
          aria-label="hidden"
        />
        <MaterialTextField
          label="Field B"
          committed="bb"
          onSave={vi.fn(async () => true)}
          testId="f-b"
        />
      </Region>,
    );
    const a = screen.getByTestId("f-a-input") as HTMLInputElement;
    const b = screen.getByTestId("f-b-input") as HTMLInputElement;
    focus(a);
    enter(a);
    expect(document.activeElement).toBe(b);
  });

  it("IME candidate confirmation never navigates or commits", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveA = vi.fn(async () => true);
    const { a } = renderTextPair({ saveA });
    focus(a);
    fireEvent.change(a, { target: { value: "拼" } });
    saveA.mockClear();
    enter(a, { keyCode: 229 });
    expect(document.activeElement).toBe(a);
    enter(a, { isComposing: true });
    expect(document.activeElement).toBe(a);
    expect(saveA).not.toHaveBeenCalled();
  });

  it("Shift+Enter stays in a multi-line field while Enter navigates", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveNotes = vi.fn(async () => true);
    render(
      <Region>
        <MaterialNotesField
          label="Notes"
          committed="line1"
          onSave={saveNotes}
          testId="f-notes"
        />
        <MaterialTextField
          label="Field B"
          committed="bb"
          onSave={vi.fn(async () => true)}
          testId="f-b"
        />
      </Region>,
    );
    const notes = screen.getByTestId("f-notes-input") as HTMLTextAreaElement;
    const b = screen.getByTestId("f-b-input") as HTMLInputElement;
    focus(notes);
    enter(notes, { shiftKey: true });
    expect(document.activeElement).toBe(notes);
    expect(saveNotes).not.toHaveBeenCalled();
    enter(notes);
    expect(document.activeElement).toBe(b);
  });

  it("a blocked required field keeps focus and shows the field error", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveA = vi.fn(async () => true);
    const { a, b } = renderTextPair({ saveA, required: true, committedA: "" });
    focus(a);
    enter(a);
    expect(document.activeElement).toBe(a);
    expect(screen.getByTestId("f-a-required")).toHaveTextContent("Required");
    fireEvent.change(a, { target: { value: "ok" } });
    enter(a);
    expect(document.activeElement).toBe(b);
  });

  it("Tab and Shift+Tab keep the native order", async () => {
    updateInputPreferences({ enterBehavior: "next" });
    const { a, b } = renderTextPair();
    const user = userEvent.setup();
    focus(a);
    await user.tab();
    expect(document.activeElement).toBe(b);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(a);
  });

  it("Escape keeps the field focused without committing", () => {
    const saveA = vi.fn(async () => true);
    const { a } = renderTextPair({ saveA });
    focus(a);
    fireEvent.change(a, { target: { value: "a2" } });
    fireEvent.keyDown(a, { key: "Escape" });
    expect(document.activeElement).toBe(a);
    expect(saveA).not.toHaveBeenCalled();
  });

  it("switches behavior live when the preference changes", () => {
    const { a, b } = renderTextPair();
    focus(a);
    enter(a);
    expect(document.activeElement).not.toBe(b);
    act(() => {
      updateInputPreferences({ enterBehavior: "next" });
    });
    focus(a);
    enter(a);
    expect(document.activeElement).toBe(b);
  });
});

describe("edit-entry selection strategy", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("end: caret lands at the text end on keyboard entry", () => {
    updateInputPreferences({ editEntry: "end" });
    const { a } = renderTextPair();
    focus(a);
    expect(a.selectionStart).toBe(2);
    expect(a.selectionEnd).toBe(2);
  });

  it("select-all: the whole value is selected on entry", () => {
    updateInputPreferences({ editEntry: "select-all" });
    const { a } = renderTextPair();
    focus(a);
    expect(a.selectionStart).toBe(0);
    expect(a.selectionEnd).toBe(2);
  });

  it("click + pointer entry keeps the click caret; keyboard entry falls to end", async () => {
    const { a } = renderTextPair();
    a.setSelectionRange(0, 0);
    fireEvent.mouseDown(a);
    focus(a);
    await flushSelectionDefer();
    expect(a.selectionStart).toBe(0);
    // Re-enter via keyboard (no mousedown): default lands at the end.
    act(() => {
      a.blur();
    });
    focus(a);
    expect(a.selectionStart).toBe(2);
  });

  it("pointer entry applies the configured strategy after the click", async () => {
    updateInputPreferences({ editEntry: "select-all" });
    const { a } = renderTextPair();
    a.setSelectionRange(0, 0);
    fireEvent.mouseDown(a);
    focus(a);
    await flushSelectionDefer();
    expect(a.selectionStart).toBe(0);
    expect(a.selectionEnd).toBe(2);
  });

  it("applies the strategy only on entry, never over a user's selection", async () => {
    updateInputPreferences({ editEntry: "select-all" });
    const saveA = vi.fn(async () => true);
    const { a } = renderTextPair({ saveA });
    focus(a);
    fireEvent.change(a, { target: { value: "a2" } });
    // A deliberate drag-selection after typing: a save-driven rerender must
    // never overwrite it with the entry strategy (AC-07).
    act(() => {
      a.setSelectionRange(1, 2);
    });
    await act(async () => {
      a.blur();
    });
    expect(saveA).toHaveBeenCalledWith("a2");
    expect(a.selectionStart).toBe(1);
    expect(a.selectionEnd).toBe(2);
  });
});

describe("quiet field presentation", () => {
  it("keeps keyboard navigation without hint rows even with an old always-on preference", () => {
    updateInputPreferences({ enterBehavior: "next", hintMode: "always" });
    const { a, b } = renderTextPair();
    focus(a);
    expect(screen.queryByTestId("f-a-hint")).toBeNull();
    enter(a);
    expect(document.activeElement).toBe(b);
    expect(screen.queryByTestId("f-b-hint")).toBeNull();
  });
});

describe("auto-focus explicit entry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("focuses the first eligible field only when invoked", () => {
    updateInputPreferences({ autoFocus: true });
    render(
      <div {...{ [INPUT_PREF_REGION_ATTR]: true }} data-testid="region">
        <input data-input-pref-field disabled />
        <MaterialTextField
          label="First"
          committed=""
          onSave={vi.fn(async () => true)}
          testId="first"
        />
      </div>,
    );
    const first = screen.getByTestId("first-input") as HTMLInputElement;
    // No mount-time focus: only the explicit entry moves focus.
    expect(document.activeElement).not.toBe(first);
    const moved = focusFirstRegionField(screen.getByTestId("region"));
    expect(moved).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("does nothing on coarse-pointer devices so no keyboard pops up", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(
      () => ({ matches: true }) as MediaQueryList,
    );
    try {
      render(
        <div {...{ [INPUT_PREF_REGION_ATTR]: true }} data-testid="region">
          <MaterialTextField
            label="First"
            committed=""
            onSave={vi.fn(async () => true)}
            testId="first"
          />
        </div>,
      );
      const moved = focusFirstRegionField(screen.getByTestId("region"));
      expect(moved).toBe(false);
      expect(document.activeElement).not.toBe(
        screen.getByTestId("first-input"),
      );
    } finally {
      window.matchMedia = original;
    }
  });

  it("the workspace-style start button wires the explicit entry", () => {
    updateInputPreferences({ autoFocus: true });
    render(
      <div {...{ [INPUT_PREF_REGION_ATTR]: true }} data-testid="region">
        <button
          type="button"
          data-testid="start-fill"
          onClick={(e) =>
            focusFirstRegionField(
              e.currentTarget.closest(`[${INPUT_PREF_REGION_ATTR}]`),
            )
          }
        >
          Fill in sequence
        </button>
        <MaterialTextField
          label="Name"
          committed=""
          onSave={vi.fn(async () => true)}
          testId="name"
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId("start-fill"));
    expect(document.activeElement).toBe(screen.getByTestId("name-input"));
  });
});

describe("ApplicationProfileField integration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("Enter=next navigates profile fields and keeps the autosave commit", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const saveA = vi.fn(async () => true);
    render(
      <Region>
        <ApplicationProfileField
          label="Phone"
          value="111"
          onSave={saveA}
          testId="p-a"
        />
        <ApplicationProfileField
          label="Email"
          value="e@x.com"
          onSave={vi.fn(async () => true)}
          testId="p-b"
        />
      </Region>,
    );
    const a = screen.getByTestId("p-a-input") as HTMLInputElement;
    const b = screen.getByTestId("p-b-input") as HTMLInputElement;
    focus(a);
    fireEvent.change(a, { target: { value: "222" } });
    enter(a);
    expect(document.activeElement).toBe(b);
    expect(saveA).toHaveBeenCalledWith("222");
  });
});


describe("input preference safety regressions", () => {
  beforeEach(() => localStorage.clear());

  it("keeps composition Enter in the field even when keyboard flags are absent", () => {
    updateInputPreferences({ enterBehavior: "next" });
    const { a, saveA } = renderTextPair();
    focus(a);
    fireEvent.compositionStart(a);
    enter(a);
    expect(document.activeElement).toBe(a);
    expect(saveA).not.toHaveBeenCalled();
  });

  it("applies keyboard entry strategy over a selection retained from the previous edit", () => {
    updateInputPreferences({ editEntry: "end" });
    const { a, b } = renderTextPair();
    focus(a);
    a.setSelectionRange(0, 1);
    focus(b);
    focus(a);
    expect(a.selectionStart).toBe(2);
    expect(a.selectionEnd).toBe(2);
  });

  it("skips visibility-hidden fields even when they have a layout offset parent", () => {
    updateInputPreferences({ enterBehavior: "next" });
    render(<Region>
      <MaterialTextField label="A" committed="a" onSave={async () => true} testId="visible-a" />
      <input data-input-pref-field style={{ visibility: "hidden" }} data-testid="hidden-layout" />
      <MaterialTextField label="B" committed="b" onSave={async () => true} testId="visible-b" />
    </Region>);
    Object.defineProperty(screen.getByTestId("hidden-layout"), "offsetParent", { value: document.body });
    const a = screen.getByTestId("visible-a-input");
    focus(a);
    enter(a);
    expect(document.activeElement).toBe(screen.getByTestId("visible-b-input"));
  });

  it("keeps invalid profile input focused on Enter and preserves it on Tab", async () => {
    updateInputPreferences({ enterBehavior: "next" });
    const save = vi.fn(async () => true);
    render(<Region>
      <ApplicationProfileField label="Date" value="2026-01-01" validate={(v) => { try { assertBirthDate(v); return true; } catch { return false; } }} onSave={save} testId="invalid-date" />
      <StructuredInput aria-label="Next" />
    </Region>);
    const input = screen.getByTestId("invalid-date-input");
    focus(input);
    fireEvent.change(input, { target: { value: "2026-02-30" } });
    enter(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("alert")).toHaveTextContent("valid value");
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Next"));
    expect(input).toHaveValue("2026-02-30");
    expect(save).not.toHaveBeenCalled();
  });

  it("gates a required create field on Enter without trapping Tab", async () => {
    updateInputPreferences({ enterBehavior: "next" });
    render(<Region><StructuredInput aria-label="Required name" value="" required readOnly={false} onChange={() => {}} /><StructuredInput aria-label="Optional" /></Region>);
    const input = screen.getByLabelText("Required name");
    focus(input);
    enter(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Optional"));
  });
});
