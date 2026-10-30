// SET-INPUT-PREFERENCES: the Devices & Input card renders the four
// device-local preferences in order (three selects + one switch), persists
// every change immediately, restores them on remount, and falls back to
// defaults for a corrupt snapshot.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { I18nProvider } from "@/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({ success: true, data: null })),
}));

import InputPreferencesSettings from "@/components/settings/InputPreferencesSettings";
import { APP_CONSTANTS } from "@/lib/constants";
import { updateInputPreferences } from "@/lib/inputPreferences";

// jsdom lacks the pointer-capture/scroll APIs Radix Select touches.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const KEY = APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY;

function storedSnapshot() {
  const raw = localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

async function pickOption(triggerTestId: string, name: string | RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(triggerTestId));
  await user.click(await screen.findByRole("option", { name }));
}

describe("InputPreferencesSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the four rows with their default values", () => {
    render(<InputPreferencesSettings />);
    expect(screen.getByTestId("input-prefs-enter")).toHaveTextContent(
      "New line",
    );
    expect(screen.getByTestId("input-prefs-entry")).toHaveTextContent(
      "At click position",
    );
    expect(screen.getByTestId("input-prefs-hints")).toHaveTextContent(
      "On focus",
    );
    expect(screen.getByTestId("input-prefs-autofocus")).not.toBeChecked();
    expect(screen.getByTestId("input-prefs-footer")).toHaveTextContent(
      "Enter and Shift+Enter insert a new line in multi-line fields.",
    );
  });

  it("persists an Enter-behavior change immediately and updates the footer", async () => {
    render(<InputPreferencesSettings />);
    await pickOption("input-prefs-enter", "Next field");
    expect(screen.getByTestId("input-prefs-enter")).toHaveTextContent(
      "Next field",
    );
    expect(storedSnapshot().enterBehavior).toBe("next");
    expect(screen.getByTestId("input-prefs-footer")).toHaveTextContent(
      "Enter moves to the next field",
    );
  });

  it("persists edit-entry, hint and auto-focus changes", async () => {
    render(<InputPreferencesSettings />);
    await pickOption("input-prefs-entry", "Select all");
    await pickOption("input-prefs-hints", "Off");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("input-prefs-autofocus"));
    expect(storedSnapshot()).toEqual({
      enterBehavior: "newline",
      editEntry: "select-all",
      hintMode: "off",
      autoFocus: true,
    });
  });

  it("restores persisted values on a fresh mount", () => {
    updateInputPreferences({ editEntry: "end", autoFocus: true });
    render(<InputPreferencesSettings />);
    expect(screen.getByTestId("input-prefs-entry")).toHaveTextContent(
      "Caret at end",
    );
    expect(screen.getByTestId("input-prefs-autofocus")).toBeChecked();
  });

  it("falls back to defaults for a corrupt snapshot", () => {
    localStorage.setItem(KEY, "{broken");
    render(<InputPreferencesSettings />);
    expect(screen.getByTestId("input-prefs-enter")).toHaveTextContent(
      "New line",
    );
    expect(screen.getByTestId("input-prefs-hints")).toHaveTextContent(
      "On focus",
    );
  });

  it("renders the zh-CN copy when the locale is Chinese", () => {
    render(
      <I18nProvider
        initialLocale="zh-CN"
        loadPersistedLocale={async () => null}
      >
        <InputPreferencesSettings />
      </I18nProvider>,
    );
    expect(screen.getByText("输入偏好")).toBeInTheDocument();
    expect(screen.getByTestId("input-prefs-enter")).toHaveTextContent("换行");
    expect(screen.getByTestId("input-prefs-entry")).toHaveTextContent(
      "按点击位置",
    );
    expect(screen.getByTestId("input-prefs-hints")).toHaveTextContent(
      "聚焦时显示",
    );
  });
});


it("reports persistence failure and retains the previously persisted settings", async () => {
  localStorage.clear();
  updateInputPreferences({ enterBehavior: "newline" });
  render(<InputPreferencesSettings />);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  try {
    await pickOption("input-prefs-enter", "Next field");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save input preferences");
    expect(screen.getByTestId("input-prefs-enter")).toHaveTextContent("New line");
    expect(storedSnapshot().enterBehavior).toBe("newline");
  } finally { write.mockRestore(); }
});
