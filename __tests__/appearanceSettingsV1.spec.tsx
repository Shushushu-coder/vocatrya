// SET-03: appearance card selects apply immediately, autosave serially, and
// roll back to the last server-confirmed theme on failure. display.theme stays
// the single persistence authority; "saved" is only derived from the real
// updateDisplaySettings result, never from the local selection alone.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import DisplaySettings from "@/components/settings/DisplaySettings";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join("/")}` : key,
  }),
}));

const getUserSettings = vi.fn();
const updateDisplaySettings = vi.fn();
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: (...args: unknown[]) => getUserSettings(...args),
  updateDisplaySettings: (...args: unknown[]) =>
    updateDisplaySettings(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  toastError: (...args: unknown[]) => toastError(...args),
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
}));

const setTheme = vi.fn();
let currentTheme: string | undefined = "light";
let currentSystemTheme: "light" | "dark" | undefined = "light";
vi.mock("next-themes", () => ({
  useTheme: () => ({
    setTheme,
    theme: currentTheme,
    systemTheme: currentSystemTheme,
  }),
}));

const persisted = (theme: string) => ({
  success: true,
  data: {
    userId: "u-1",
    settings: {
      ai: { provider: "ollama", model: undefined },
      display: { theme },
    },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const themeRadio = (name: string) =>
  screen.getByRole("radio", { name: `settings.${name}` });

async function renderLoaded(savedTheme = "light") {
  getUserSettings.mockResolvedValue(persisted(savedTheme));
  render(<DisplaySettings />);
  await waitFor(() => expect(themeRadio("themeLight")).toBeInTheDocument());
}

describe("DisplaySettings — instant apply & autosave (SET-03)", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateDisplaySettings.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    setTheme.mockReset();
    currentTheme = "light";
    currentSystemTheme = "light";
    delete window.vocatryaWindow;
  });

  it("shows the persisted display.theme as the selected card on load", async () => {
    await renderLoaded("dark");

    expect(themeRadio("themeDark")).toBeChecked();
    // The persisted authority overrides the local next-themes cache.
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("falls back to the current next-themes value when no readable theme persists", async () => {
    getUserSettings.mockResolvedValue({
      success: true,
      data: {
        userId: "u-1",
        settings: {
          ai: { provider: "ollama", model: undefined },
          display: { theme: "solarized" },
        },
      },
    });
    currentTheme = "dark";
    render(<DisplaySettings />);

    await waitFor(() => expect(themeRadio("themeDark")).toBeChecked());
  });

  it("applies a click immediately and autosaves; saved comes from the real write", async () => {
    updateDisplaySettings.mockResolvedValue(persisted("dark"));
    const user = userEvent.setup();
    await renderLoaded("light");
    setTheme.mockClear();

    await user.click(themeRadio("themeDark"));

    expect(setTheme).toHaveBeenCalledWith("dark");
    await waitFor(() =>
      expect(updateDisplaySettings).toHaveBeenCalledWith({ theme: "dark" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(themeRadio("themeDark")).toBeChecked();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("autosaves the system preference so OS changes keep being followed", async () => {
    updateDisplaySettings.mockResolvedValue(persisted("system"));
    const user = userEvent.setup();
    await renderLoaded("dark");
    setTheme.mockClear();

    await user.click(themeRadio("themeSystem"));

    expect(setTheme).toHaveBeenCalledWith("system");
    await waitFor(() =>
      expect(updateDisplaySettings).toHaveBeenCalledWith({ theme: "system" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
  });

  it("selects a card by clicking anywhere on it, not only the hidden radio", async () => {
    updateDisplaySettings.mockResolvedValue(persisted("dark"));
    const user = userEvent.setup();
    await renderLoaded("light");

    await user.click(screen.getByText("settings.themeDark"));

    expect(themeRadio("themeDark")).toBeChecked();
    await waitFor(() =>
      expect(updateDisplaySettings).toHaveBeenCalledWith({ theme: "dark" }),
    );
  });

  it("does not issue a write when re-selecting the already applied theme", async () => {
    const user = userEvent.setup();
    await renderLoaded("light");

    await user.click(themeRadio("themeLight"));

    expect(updateDisplaySettings).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("rolls back web + native theme to the last confirmed value when the save fails", async () => {
    updateDisplaySettings.mockResolvedValue({
      success: false,
      message: "db write failed",
    });
    const user = userEvent.setup();
    await renderLoaded("light");
    setTheme.mockClear();

    await user.click(themeRadio("themeDark"));

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(themeRadio("themeLight")).toBeChecked();
    // setTheme("light") restores the confirmed value; the provider's existing
    // NativeWindowThemeSync propagates the same value to the native bridge.
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(toastError).toHaveBeenCalledWith("settings.saveDisplayFailed");
  });

  it("rolls back when the save promise rejects", async () => {
    updateDisplaySettings.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    await renderLoaded("dark");
    setTheme.mockClear();

    await user.click(themeRadio("themeSystem"));

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(themeRadio("themeDark")).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
  });

  it("treats a persistence echo that differs from the intent as a failure", async () => {
    // A success flag whose stored document does not carry the requested theme
    // is not a real save — the UI must not claim it persisted.
    updateDisplaySettings.mockResolvedValue(persisted("system"));
    const user = userEvent.setup();
    await renderLoaded("light");
    setTheme.mockClear();

    await user.click(themeRadio("themeDark"));

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(themeRadio("themeLight")).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("light");
  });

  it("serializes rapid switches so the last DB write is the latest intent", async () => {
    const first = deferred<ReturnType<typeof persisted>>();
    updateDisplaySettings
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persisted("light"));
    const user = userEvent.setup();
    await renderLoaded("system");
    setTheme.mockClear();

    await user.click(themeRadio("themeDark"));
    await user.click(themeRadio("themeLight"));

    // The newer intent is queued behind the in-flight write, never fired in
    // parallel — otherwise the older request could land last in the DB.
    expect(updateDisplaySettings).toHaveBeenCalledTimes(1);
    expect(updateDisplaySettings).toHaveBeenLastCalledWith({ theme: "dark" });

    first.resolve(persisted("dark"));

    await waitFor(() => expect(updateDisplaySettings).toHaveBeenCalledTimes(2));
    expect(updateDisplaySettings).toHaveBeenLastCalledWith({ theme: "light" });
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(themeRadio("themeLight")).toBeChecked();
    expect(setTheme).not.toHaveBeenCalledWith("system");
  });

  it("keeps the newest selection when an earlier in-flight save fails", async () => {
    const first = deferred<unknown>();
    updateDisplaySettings
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persisted("system"));
    const user = userEvent.setup();
    await renderLoaded("light");
    setTheme.mockClear();

    await user.click(themeRadio("themeDark"));
    await user.click(themeRadio("themeSystem"));

    // The dark save fails after the user already moved on to system: its stale
    // failure must not revert the newer selection.
    first.resolve({ success: false, message: "conflict" });

    await waitFor(() => expect(updateDisplaySettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(themeRadio("themeSystem")).toBeChecked();
    expect(setTheme).not.toHaveBeenCalledWith("light");
    expect(setTheme).toHaveBeenLastCalledWith("system");
    // The failed write still surfaced honestly.
    expect(toastError).toHaveBeenCalledWith("settings.saveDisplayFailed");
  });

  it("surfaces saving state while a write is in flight", async () => {
    const gate = deferred<ReturnType<typeof persisted>>();
    updateDisplaySettings.mockReturnValue(gate.promise);
    const user = userEvent.setup();
    await renderLoaded("light");

    await user.click(themeRadio("themeDark"));

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saving",
      ),
    );
    gate.resolve(persisted("dark"));
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
  });

  it("reports saved purely from the server write when no native bridge exists", async () => {
    // Without window.vocatryaWindow nothing may claim native sync succeeded;
    // the indicator only ever reflects the updateDisplaySettings result.
    expect(window.vocatryaWindow).toBeUndefined();
    updateDisplaySettings.mockResolvedValue(persisted("dark"));
    const user = userEvent.setup();
    await renderLoaded("light");

    await user.click(themeRadio("themeDark"));

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
  });
});
