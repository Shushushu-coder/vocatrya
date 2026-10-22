// SET-08 honest capability pages: the Notifications / Shortcuts / Audio
// settings components must render only capabilities that provably exist at
// baseline 59499771 — no fake toggles, no dead buttons, no media permission
// requests, and no "shortcuts" that were never registered.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@/i18n";
import NotificationsSettings from "@/components/settings/NotificationsSettings";
import ShortcutsSettings from "@/components/settings/ShortcutsSettings";
import AudioSettings from "@/components/settings/AudioSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/settings",
}));

const PAGES = {
  "notifications-settings": NotificationsSettings,
  "shortcuts-settings": ShortcutsSettings,
  "audio-settings": AudioSettings,
} as const;

afterEach(() => {
  delete (window as { vocatryaWindow?: unknown }).vocatryaWindow;
  vi.restoreAllMocks();
});

function expectNoInteractiveControls(container: HTMLElement) {
  expect(
    container.querySelector(
      'button, input, select, textarea, a[href], [role="switch"], [role="checkbox"], [role="slider"], [tabindex]',
    ),
  ).toBeNull();
}

describe("NotificationsSettings — honest capability page", () => {
  it("lists the in-app toast feedback as built-in, not configurable", () => {
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    expect(
      within(page).getByText("In-app feedback messages"),
    ).toBeInTheDocument();
    expect(within(page).getByText("Built-in")).toBeInTheDocument();
    expect(within(page).getByText(/toast/i)).toBeInTheDocument();
  });

  it("states system notifications and preferences as not provided", () => {
    render(<NotificationsSettings />);
    const page = screen.getByTestId("notifications-settings");
    expect(
      within(page).getByText("System notifications"),
    ).toBeInTheDocument();
    expect(
      within(page).getByText("Notification preferences"),
    ).toBeInTheDocument();
    expect(within(page).getAllByText("Not provided")).toHaveLength(2);
  });

  it("contains no interactive control that could imply a setting", () => {
    const { container } = render(<NotificationsSettings />);
    expectNoInteractiveControls(container);
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

  it("labels Alt+Arrow history keys as desktop-app scoped", () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    expect(within(page).getByText("Go back one page")).toBeInTheDocument();
    expect(
      within(page).getByText("Go forward one page"),
    ).toBeInTheDocument();
    expect(
      within(page).getAllByText("Desktop app only"),
    ).toHaveLength(2);
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

  it("states global shortcuts and rebinding as not provided", () => {
    render(<ShortcutsSettings />);
    const page = screen.getByTestId("shortcuts-settings");
    expect(
      within(page).getByText("OS-level global shortcuts"),
    ).toBeInTheDocument();
    expect(
      within(page).getByText("Custom keybindings"),
    ).toBeInTheDocument();
    expect(within(page).getAllByText("Not provided")).toHaveLength(2);
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

describe("AudioSettings — honest capability page", () => {
  it("declares the audio capabilities it does not have", () => {
    render(<AudioSettings />);
    const page = screen.getByTestId("audio-settings");
    for (const title of [
      "Microphone input",
      "Audio output & device switching",
      "Speech transcription & recognition",
      "Recording test",
    ]) {
      expect(within(page).getByText(title)).toBeInTheDocument();
    }
    expect(within(page).getAllByText("Not provided")).toHaveLength(4);
    expect(
      within(page).getByText(/screen capture/i),
    ).toBeInTheDocument();
  });

  it("never touches media devices or permission APIs", () => {
    const getUserMedia = vi.fn();
    const enumerateDevices = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia, enumerateDevices },
      configurable: true,
    });
    const { unmount } = render(<AudioSettings />);
    unmount();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("contains no interactive control that could imply a setting", () => {
    const { container } = render(<AudioSettings />);
    expectNoInteractiveControls(container);
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
  it("writes the three page fragments to the runtime evidence dir", () => {
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
    (testId) => {
      const Page = PAGES[testId as keyof typeof PAGES];
      render(<Page />);
      const page = screen.getByTestId(testId);
      const rows = page.querySelectorAll(".flex.flex-wrap");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const text = row.querySelector(".min-w-0");
        expect(text).not.toBeNull();
        expect(text?.querySelector(".break-words")).not.toBeNull();
      }
    },
  );
});
