// Shortcut registry, combo normalization, keybinding persistence wiring,
// and the Shortcuts settings surface. Desktop-mode tests stub the
// vocatryaDesktop bridge; the bindings module is a singleton, so each
// test that needs isolation re-imports it after vi.resetModules().
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  comboFromEvent,
  comboMatchesEvent,
  comboToAccelerator,
  comboToDisplayKeys,
  isValidCombo,
  normalizeEventKey,
  parseCombo,
} from "@/lib/shortcuts/combos";
import { SHORTCUT_ACTIONS, WINDOW_ACTION_IDS } from "@/lib/shortcuts/registry";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/settings",
}));

afterEach(() => {
  delete (window as { vocatryaWindow?: unknown }).vocatryaWindow;
  delete (window as { vocatryaDesktop?: unknown }).vocatryaDesktop;
  vi.restoreAllMocks();
});

function mockBridge(state?: {
  window?: Partial<VocatryaShortcutState["window"]>;
  global?: Partial<VocatryaShortcutState["global"]>;
}) {
  const current: VocatryaShortcutState = {
    window: {
      toggleSidebar: "Mod+B",
      historyBack: "Alt+Left",
      historyForward: "Alt+Right",
      ...state?.window,
    },
    global: {
      enabled: false,
      combo: "Mod+Alt+V",
      registered: false,
      error: null,
      ...state?.global,
    },
  };
  const bridge = {
    getShortcutState: vi.fn(async () => JSON.parse(JSON.stringify(current))),
    setWindowShortcut: vi.fn(
      async (input: { action: keyof VocatryaShortcutState["window"]; combo: string | null }) => {
        current.window[input.action] = input.combo;
        return { ok: true as const, state: JSON.parse(JSON.stringify(current)) };
      },
    ),
    setGlobalShortcut: vi.fn(
      async (input: { enabled?: boolean; combo?: string }) => {
        if (input.enabled !== undefined) current.global.enabled = input.enabled;
        if (input.combo !== undefined) current.global.combo = input.combo;
        if (current.global.enabled) current.global.registered = true;
        return { ok: true as const, state: JSON.parse(JSON.stringify(current)) };
      },
    ),
  };
  (window as { vocatryaDesktop?: unknown }).vocatryaDesktop = bridge;
  (window as { vocatryaWindow?: unknown }).vocatryaWindow = {
    setTheme: vi.fn(),
  };
  return { bridge, current };
}

async function freshSettings() {
  vi.resetModules();
  const { default: Component } = await import(
    "@/components/settings/ShortcutsSettings"
  );
  return Component;
}

describe("combo normalization", () => {
  it("maps event keys to canonical tokens", () => {
    expect(normalizeEventKey("b")).toBe("B");
    expect(normalizeEventKey("B")).toBe("B");
    expect(normalizeEventKey("ArrowLeft")).toBe("Left");
    expect(normalizeEventKey(" ")).toBe("Space");
    expect(normalizeEventKey("Enter")).toBe("Enter");
    expect(normalizeEventKey("Escape")).toBe("Esc");
    expect(normalizeEventKey(",")).toBe("Comma");
    expect(normalizeEventKey("+")).toBe("Plus");
    expect(normalizeEventKey("F12")).toBe("F12");
    expect(normalizeEventKey("Control")).toBeNull();
    expect(normalizeEventKey("?")).toBeNull();
    expect(normalizeEventKey(undefined)).toBeNull();
  });

  it("validates canonical combos and requires a strong modifier", () => {
    for (const good of ["Mod+B", "Alt+Left", "Mod+Alt+V", "Alt+Shift+F4"]) {
      expect(isValidCombo(good)).toBe(true);
    }
    for (const bad of ["B", "Shift+B", "Mod+Mod+B", "Mod+", "Ctrl+B"]) {
      expect(isValidCombo(bad)).toBe(false);
    }
  });

  it("builds a combo from an event with Mod = ctrl or meta", () => {
    expect(
      comboFromEvent({ key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
    ).toBe("Mod+B");
    expect(
      comboFromEvent({ key: "b", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }),
    ).toBe("Mod+B");
    expect(
      comboFromEvent({ key: "ArrowLeft", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }),
    ).toBe("Alt+Left");
    expect(
      comboFromEvent({ key: "v", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }),
    ).toBe("Mod+Alt+V");
    expect(
      comboFromEvent({ key: "b", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }),
    ).toBeNull();
    expect(
      comboFromEvent({ key: "b", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }),
    ).toBeNull();
  });

  it("matches exactly: extra or missing modifiers break the match", () => {
    const press = (init: Partial<KeyboardEvent>) => ({
      key: "b",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });
    expect(comboMatchesEvent(press({ ctrlKey: true }), "Mod+B")).toBe(true);
    expect(comboMatchesEvent(press({ metaKey: true }), "Mod+B")).toBe(true);
    expect(comboMatchesEvent(press({ ctrlKey: true, shiftKey: true }), "Mod+B")).toBe(false);
    expect(comboMatchesEvent(press({ ctrlKey: true, altKey: true }), "Mod+B")).toBe(false);
    expect(comboMatchesEvent(press({ ctrlKey: true }), "Mod+Shift+B")).toBe(false);
    expect(comboMatchesEvent(press({}), "Mod+B")).toBe(false);
    expect(parseCombo("Mod+Alt+V")?.key).toBe("V");
  });

  it("renders display chips and Electron accelerators", () => {
    expect(comboToDisplayKeys("Mod+B")).toEqual(["Ctrl", "B"]);
    expect(comboToDisplayKeys("Alt+Left")).toEqual(["Alt", "←"]);
    expect(comboToDisplayKeys("Mod+Alt+V")).toEqual(["Ctrl", "Alt", "V"]);
    expect(comboToAccelerator("Mod+B")).toBe("CommandOrControl+B");
    expect(comboToAccelerator("Mod+Alt+V")).toBe("CommandOrControl+Alt+V");
    expect(comboToAccelerator("Alt+Comma")).toBe("Alt+,");
    expect(comboToAccelerator("Mod+Plus")).toBe("CommandOrControl+Plus");
  });
});

describe("registry defaults", () => {
  it("preserves the pre-registry hard-coded bindings", () => {
    expect(SHORTCUT_ACTIONS.toggleSidebar.defaultCombo).toBe("Mod+B");
    expect(SHORTCUT_ACTIONS.historyBack.defaultCombo).toBe("Alt+Left");
    expect(SHORTCUT_ACTIONS.historyForward.defaultCombo).toBe("Alt+Right");
    expect(SHORTCUT_ACTIONS.toggleWindow.defaultCombo).toBe("Mod+Alt+V");
    for (const id of WINDOW_ACTION_IDS) {
      expect(SHORTCUT_ACTIONS[id].rebindable).toBe(true);
    }
  });
});

describe("window shortcut listeners", () => {
  it("toggles the sidebar on the default combo and suppresses inside inputs", async () => {
    vi.resetModules();
    const { SidebarProvider, useSidebar } = await import(
      "@/context/SidebarContext"
    );
    function Probe() {
      const ctx = useSidebar();
      return (
        <div>
          <span data-testid="expanded">{String(ctx.expanded)}</span>
          <input data-testid="field" />
        </div>
      );
    }
    render(
      <SidebarProvider initialExpanded={true}>
        <Probe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId("expanded")).toHaveTextContent("true");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByTestId("expanded")).toHaveTextContent("false");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(screen.getByTestId("expanded")).toHaveTextContent("true");

    // Inside an editable target the combo stays with the control (bold).
    const input = screen.getByTestId("field");
    input.focus();
    fireEvent.keyDown(input, { key: "b", ctrlKey: true });
    expect(screen.getByTestId("expanded")).toHaveTextContent("true");

    // Extra modifiers do not match the recorded combo.
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("expanded")).toHaveTextContent("true");
  });
});

describe("ShortcutsSettings — browser surface", () => {
  it("shows defaults with the desktop-only badge and no interactive controls", async () => {
    const Component = await freshSettings();
    render(<Component />);
    const page = screen.getByTestId("shortcuts-settings");
    await waitFor(() =>
      expect(screen.getByTestId("shortcuts-env-note")).toBeInTheDocument(),
    );
    expect(page.querySelector("button, input, select, [role='switch']")).toBeNull();
    expect(screen.getAllByText("Desktop app only")).toHaveLength(4);
    expect(screen.getByText("Show or hide the main window")).toBeInTheDocument();
    const kbds = [...page.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(kbds).toEqual(expect.arrayContaining(["Ctrl", "B", "Alt", "←", "→", "V"]));
  });
});

describe("ShortcutsSettings — desktop bridge surface", () => {
  it("loads bindings and rebinding a row writes through the bridge", async () => {
    const { bridge } = mockBridge();
    const Component = await freshSettings();
    render(<Component />);
    const rebind = await screen.findByTestId("shortcut-rebind-toggleSidebar");
    fireEvent.click(rebind);
    expect(
      screen.getAllByText(/Press the new combination/i).length,
    ).toBeGreaterThan(0);
    fireEvent.keyDown(window, {
      key: "b",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(bridge.setWindowShortcut).toHaveBeenCalledWith({
        action: "toggleSidebar",
        combo: "Mod+Shift+B",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-row-toggleSidebar")).toHaveTextContent(
        "Shift",
      ),
    );
  });

  it("blocks a combo already held by another action before any write", async () => {
    const { bridge } = mockBridge();
    const Component = await freshSettings();
    render(<Component />);
    const rebind = await screen.findByTestId("shortcut-rebind-historyBack");
    fireEvent.click(rebind);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-error-historyBack")).toHaveTextContent(
        /already used/i,
      ),
    );
    expect(bridge.setWindowShortcut).not.toHaveBeenCalled();
  });

  it("clear removes the binding and reset restores the default", async () => {
    const { bridge } = mockBridge();
    const Component = await freshSettings();
    render(<Component />);
    const clear = await screen.findByTestId("shortcut-clear-historyForward");
    fireEvent.click(clear);
    await waitFor(() =>
      expect(bridge.setWindowShortcut).toHaveBeenCalledWith({
        action: "historyForward",
        combo: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-row-historyForward")).toHaveTextContent(
        "Not bound",
      ),
    );
    const reset = screen.getByTestId("shortcut-reset-historyForward");
    fireEvent.click(reset);
    await waitFor(() =>
      expect(bridge.setWindowShortcut).toHaveBeenLastCalledWith({
        action: "historyForward",
        combo: "Alt+Right",
      }),
    );
  });

  it("the global switch enables the hotkey and reports registration", async () => {
    const { bridge } = mockBridge();
    const Component = await freshSettings();
    render(<Component />);
    const toggle = await screen.findByTestId("shortcut-global-toggle");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(bridge.setGlobalShortcut).toHaveBeenCalledWith({
        enabled: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-global-status")).toHaveTextContent(
        "Registered",
      ),
    );
  });

  it("reports an occupied combo honestly instead of pretending success", async () => {
    const { bridge } = mockBridge();
    bridge.setGlobalShortcut.mockImplementation(async () => ({
      ok: true as const,
      state: {
        window: {
          toggleSidebar: "Mod+B",
          historyBack: "Alt+Left",
          historyForward: "Alt+Right",
        },
        global: {
          enabled: true,
          combo: "Mod+Alt+V",
          registered: false,
          error: "occupied",
        },
      },
    }));
    const Component = await freshSettings();
    render(<Component />);
    const toggle = await screen.findByTestId("shortcut-global-toggle");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-error-toggleWindow")).toHaveTextContent(
        /taken by the OS/i,
      ),
    );
    expect(screen.getByTestId("shortcut-global-status")).toHaveTextContent(
      /taken by the OS/i,
    );
  });
});
