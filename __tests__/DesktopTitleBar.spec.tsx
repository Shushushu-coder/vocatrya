import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopTitleBar } from "@/components/desktop/DesktopTitleBar";

// jsdom has no Navigation API — stub both it and the preload bridge marker
// the component uses to tell "running inside Electron" apart from web/test.
function installDesktopShell({ canGoBack = false, canGoForward = false } = {}) {
  const listeners = new Set<() => void>();
  const nav = {
    canGoBack,
    canGoForward,
    back: vi.fn<() => void>(),
    forward: vi.fn<() => void>(),
    emit: () => listeners.forEach((listener) => listener()),
  };
  Object.defineProperty(window, "navigation", {
    value: {
      get canGoBack() {
        return nav.canGoBack;
      },
      get canGoForward() {
        return nav.canGoForward;
      },
      back: () => nav.back(),
      forward: () => nav.forward(),
      addEventListener: (_t: string, l: () => void) => listeners.add(l),
      removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
    },
    configurable: true,
  });
  Object.defineProperty(window, "vocatryaWindow", {
    value: { setTheme: vi.fn() },
    configurable: true,
  });
  return nav;
}

afterEach(() => {
  delete (window as { navigation?: unknown }).navigation;
  delete (window as { vocatryaWindow?: unknown }).vocatryaWindow;
});

describe("DesktopTitleBar", () => {
  it("keeps both nav buttons disabled without usable history", () => {
    installDesktopShell();
    render(<DesktopTitleBar />);

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("follows navigation state and triggers real history moves", async () => {
    const nav = installDesktopShell({ canGoBack: true });
    const user = userEvent.setup();
    render(<DesktopTitleBar />);

    const backButton = screen.getByRole("button", { name: "Back" });
    expect(backButton).toBeEnabled();
    await user.click(backButton);
    expect(nav.back).toHaveBeenCalledTimes(1);

    nav.canGoBack = false;
    nav.canGoForward = true;
    act(() => nav.emit());
    expect(backButton).toBeDisabled();
    const forwardButton = screen.getByRole("button", { name: "Forward" });
    expect(forwardButton).toBeEnabled();
    await user.click(forwardButton);
    expect(nav.forward).toHaveBeenCalledTimes(1);
  });

  it("binds Alt+ArrowLeft/ArrowRight to page back/forward", () => {
    const nav = installDesktopShell({ canGoBack: true, canGoForward: true });
    render(<DesktopTitleBar />);

    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(nav.back).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(nav.forward).toHaveBeenCalledTimes(1);
    // Plain arrows and other modifiers never navigate.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
    expect(nav.back).toHaveBeenCalledTimes(1);
  });

  it("ignores the shortcut once history runs out", () => {
    const nav = installDesktopShell();
    render(<DesktopTitleBar />);

    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(nav.back).not.toHaveBeenCalled();
  });

  it("exposes empty no-drag slots for dashboard actions", () => {
    installDesktopShell();
    render(<DesktopTitleBar />);

    for (const id of [
      "desktop-titlebar-actions-left",
      "desktop-titlebar-actions-right",
    ]) {
      const slot = document.getElementById(id);
      expect(slot).not.toBeNull();
      expect(slot!.className).toContain("app-region-no-drag");
    }
  });

  it("opens the real shortcut list from the keyboard button", async () => {
    installDesktopShell();
    const user = userEvent.setup();
    render(<DesktopTitleBar />);

    await user.click(
      screen.getByRole("button", { name: "Keyboard shortcuts" })
    );
    // Radix Popover content has no landmark role; assert on its rows.
    expect(
      await screen.findByText("Expand or collapse the sidebar")
    ).toBeInTheDocument();
    expect(screen.getByText("Go back one page")).toBeInTheDocument();
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(0);
    expect(screen.getByText("=")).toBeInTheDocument();
    expect(screen.getAllByText("Alt")).toHaveLength(2);
    await user.keyboard("{Escape}");
  });
});
