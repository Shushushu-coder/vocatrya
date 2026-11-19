// SET-08 honest capability pages: the Notifications / Shortcuts settings
// components must render only capabilities that provably exist at baseline
// 59499771 — no fake toggles, no dead buttons, no media permission
// requests, and no "shortcuts" that were never registered. The Audio page
// has since shipped phase-1 controls (microphone pick, input level, an
// in-memory recording test); its contract below covers the delivered
// behavior — permission is only requested after a user click and
// transcription honestly stays "Not provided".
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/i18n";
import NotificationsSettings from "@/components/settings/NotificationsSettings";
import ShortcutsSettings from "@/components/settings/ShortcutsSettings";
import AudioSettings from "@/components/settings/AudioSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/settings",
}));

// REM-V1: notification preferences are real now — the page loads them via
// getUserSettings and writes through updateNotificationSettings. Both are
// stubbed so the loaded state is deterministic in jsdom.
const notificationActions = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));
vi.mock("@/actions/userSettings.actions", () => notificationActions);

// DictationSettingsControls loads its config through a server action; the
// real one depends on the database, so the spec pins a deterministic
// "configured nothing" snapshot instead.
const dictationActions = vi.hoisted(() => ({
  getDictationSettings: vi.fn(),
  updateDictationSettings: vi.fn(),
  saveDictationKey: vi.fn(),
  deleteDictationKey: vi.fn(),
}));
vi.mock("@/actions/dictation.actions", () => dictationActions);

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastActionResult: vi.fn(),
  GENERIC_ERROR_MESSAGE: "Something went wrong",
}));

const PAGES = {
  "notifications-settings": NotificationsSettings,
  "shortcuts-settings": ShortcutsSettings,
  "audio-settings": AudioSettings,
} as const;

afterEach(() => {
  delete (window as { vocatryaWindow?: unknown }).vocatryaWindow;
  delete (globalThis as { Notification?: unknown }).Notification;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  notificationActions.getUserSettings.mockResolvedValue({
    success: true,
    data: { userId: "u1", settings: { settings: {} } },
  });
  dictationActions.getDictationSettings.mockResolvedValue({
    success: true,
    data: { credentials: null, config: null },
  });
  notificationActions.updateNotificationSettings.mockImplementation(
    async (input: { enabled?: boolean; leadMinutes?: number }) => ({
      success: true,
      data: {
        userId: "u1",
        settings: { settings: { notifications: input } },
      },
    }),
  );
});

function expectNoInteractiveControls(container: HTMLElement) {
  expect(
    container.querySelector(
      'button, input, select, textarea, a[href], [role="switch"], [role="checkbox"], [role="slider"], [tabindex]',
    ),
  ).toBeNull();
}

describe("NotificationsSettings — real reminder controls", () => {
  it("lists the in-app toast feedback as built-in, not configurable", async () => {
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    expect(
      await within(page).findByText("In-app feedback messages"),
    ).toBeInTheDocument();
    expect(within(page).getByText("Built-in")).toBeInTheDocument();
    expect(within(page).getByText(/toast/i)).toBeInTheDocument();
  });

  it("renders the reminder switch, lead selector, and test button", async () => {
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    expect(
      await within(page).findByTestId("notifications-enabled-switch"),
    ).toBeInTheDocument();
    expect(
      within(page).getByTestId("notifications-lead-select"),
    ).toBeInTheDocument();
    expect(
      within(page).getByTestId("notifications-test-button"),
    ).toBeInTheDocument();
    expect(within(page).queryByText("Not provided")).not.toBeInTheDocument();
    // Honest boundary copy: delivered while running, not after a full quit.
    expect(
      within(page).getAllByText(/while the app is running/i).length,
    ).toBeGreaterThan(0);
    expect(
      within(page).getByText(/not delivered after a full quit/i),
    ).toBeInTheDocument();
  });

  it("rolls the switch back to the confirmed value when the write fails", async () => {
    notificationActions.updateNotificationSettings.mockResolvedValue({
      success: false,
      message: "forced failure",
    });
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    const toggle = await within(page).findByTestId(
      "notifications-enabled-switch",
    );
    expect(toggle).toHaveAttribute("data-state", "checked");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("data-state", "checked"),
    );
  });

  it("sends the test notification through the Notification API", async () => {
    const constructed = vi.fn();
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      constructor(title: string, options?: NotificationOptions) {
        constructed(title, options);
      }
    }
    (globalThis as { Notification?: unknown }).Notification =
      FakeNotification;
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    fireEvent.click(
      await within(page).findByTestId("notifications-test-button"),
    );
    await waitFor(() =>
      expect(constructed).toHaveBeenCalledWith(
        "Test notification",
        expect.objectContaining({ body: expect.any(String) }),
      ),
    );
  });

  it("reports an unsupported environment instead of a dead button", async () => {
    const { toastError } = await import("@/lib/toast");
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    fireEvent.click(
      await within(page).findByTestId("notifications-test-button"),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});

describe("ShortcutsSettings — honest capability page", () => {
  it("lists Ctrl+B sidebar toggle with its real window scope", () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    // Ctrl+B and the resize-handle Enter row share the same action label.
    expect(
      within(page).getAllByText("Expand or collapse the sidebar"),
    ).toHaveLength(2);
    expect(
      within(page).getByText(/suppressed while a text input is focused/i),
    ).toBeInTheDocument();
    const combos = page.querySelectorAll("kbd");
    const labels = [...combos].map((k) => k.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Ctrl", "B"]));
  });

  it("labels Alt+Arrow history keys as desktop-app scoped", async () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    expect(within(page).getByText("Go back one page")).toBeInTheDocument();
    expect(
      within(page).getByText("Go forward one page"),
    ).toBeInTheDocument();
    // Outside the desktop bridge every rebindable row carries the
    // desktop-only badge in place of its edit controls.
    await waitFor(() =>
      expect(
        within(page).getAllByText("Desktop app only"),
      ).toHaveLength(7),
    );
  });

  it("shows the environment note outside the desktop shell", async () => {
    render(<ShortcutsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("shortcuts-env-note")).toBeInTheDocument(),
    );
  });

  it("hides the environment note inside the desktop shell", async () => {
    Object.defineProperty(window, "vocatryaWindow", {
      value: { setTheme: vi.fn() },
      configurable: true,
    });
    render(<ShortcutsSettings />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("shortcuts-env-note"),
      ).not.toBeInTheDocument(),
    );
  });

  it("documents control-level keys with their focused scopes", () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    expect(
      within(page).getByText("Resize the sidebar"),
    ).toBeInTheDocument();
    expect(
      within(page).getAllByText(/sidebar resize handle is focused/i),
    ).toHaveLength(2);
    expect(
      within(page).getByText("Submit the message"),
    ).toBeInTheDocument();
    expect(within(page).getByText(/Shift\+Enter/)).toBeInTheDocument();
    expect(
      within(page).getByText("Remove the last attachment"),
    ).toBeInTheDocument();
    expect(
      within(page).getByText("Confirm the current input"),
    ).toBeInTheDocument();
  });

  it("shows the real global hotkey row instead of a not-provided badge", () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    expect(
      within(page).getByText("Show or hide the main window"),
    ).toBeInTheDocument();
    expect(
      within(page).getByText(/restored and focused/i),
    ).toBeInTheDocument();
    expect(within(page).queryByText("Not provided")).not.toBeInTheDocument();
  });

  it("registers no key handlers of its own", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { unmount } = render(<ShortcutsSettings />);
    unmount();
    expect(addSpy).not.toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
  });

  it("contains no interactive control that could imply rebinding", () => {
    const { container } = render(<ShortcutsSettings />);
    expectNoInteractiveControls(container);
  });
});

describe("AudioSettings — phase-1 controls", () => {
  it("renders real controls for delivered features and keeps transcription honest", async () => {
    render(<AudioSettings />);
    const page = screen.getByTestId("audio-settings");
    for (const title of [
      "Microphone input",
      "Input level",
      "Dictation (speech-to-text)",
      "Recording test",
    ]) {
      expect(within(page).getByText(title)).toBeInTheDocument();
    }
    // No capability is left as an honest "Not provided" badge; the dictation
    // row instead reports its real credential state once settings load.
    expect(within(page).queryByText("Not provided")).not.toBeInTheDocument();
    expect(
      await within(page).findByTestId("dictation-key-badge"),
    ).toHaveTextContent("Not configured");
    expect(within(page).getByTestId("audio-mic-enable")).toBeInTheDocument();
  });

  it("requests no media access and touches no media API before a user click", () => {
    const getUserMedia = vi.fn();
    const enumerateDevices = vi.fn();
    const addEventListener = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia, enumerateDevices, addEventListener },
      configurable: true,
    });
    const { unmount } = render(<AudioSettings />);
    unmount();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});

describe("zh-CN fallback copy", () => {
  it("renders Chinese text until the declared message keys land", async () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <NotificationsSettings />
        <ShortcutsSettings />
        <AudioSettings />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("notifications-settings"),
      ).toHaveTextContent("系统通知"),
    );
    expect(
      screen.getByTestId("notifications-settings"),
    ).toHaveTextContent("通知");
    expect(screen.getByTestId("shortcuts-settings")).toHaveTextContent(
      "快捷键",
    );
    expect(screen.getByTestId("audio-settings")).toHaveTextContent("音频");
    await waitFor(() =>
      expect(
        screen.getByTestId("shortcuts-env-note"),
      ).toHaveTextContent("当前环境不是桌面应用"),
    );
  });
});

describe("rendered DOM evidence", () => {
  it("writes the three page fragments to the runtime evidence dir", async () => {
    const dir = path.resolve(
      __dirname,
      "..",
      ".wave1-runtime",
      "evidence",
      "set08-dom",
    );
    const names = Object.keys(PAGES) as (keyof typeof PAGES)[];
    let wrote = 0;
    for (const name of names) {
      const Page = PAGES[name];
      const { container, unmount } = render(<Page />);
      try {
        // Capture the loaded fragment, not the notifications loading state.
        await waitFor(() =>
          expect(
            container.querySelector(".flex.flex-wrap"),
          ).not.toBeNull(),
        );
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, `${name}.html`),
          `<!doctype html><meta charset="utf-8">${container.innerHTML}`,
        );
        wrote += 1;
      } catch {
        // Evidence capture is best-effort; assertions live in the suites above.
      }
      unmount();
    }
    expect(wrote).toBe(names.length);
  });
});

describe("Settings V1 compact-row layout", () => {
  it.each(Object.keys(PAGES))(
    "%s rows wrap instead of overflowing on narrow widths",
    async (testId) => {
      const Page = PAGES[testId as keyof typeof PAGES];
      render(<Page />);
      const page = screen.getByTestId(testId);
      // NotificationsSettings resolves its persisted state before rendering
      // rows; the other pages are loaded immediately.
      await waitFor(() =>
        expect(
          page.querySelectorAll(".flex.flex-wrap").length,
        ).toBeGreaterThan(0),
      );
      const rows = page.querySelectorAll(".flex.flex-wrap");
      for (const row of rows) {
        // The wrap contract governs text rows (a shrinkable text column that
        // breaks long words). Control-only rows — the dictation key input,
        // its test buttons — legitimately have no such column.
        const text = row.querySelector(".min-w-0.flex-1");
        if (!text) continue;
        expect(text.querySelector(".break-words")).not.toBeNull();
      }
    },
  );
});
