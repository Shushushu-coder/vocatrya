import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { createKeybindingsStore, KEYBINDINGS_FILE_NAME } = createRequire(
  import.meta.url,
)("./keybindings.js");
const { createGlobalToggleHotkey } = createRequire(import.meta.url)(
  "./global-shortcuts.js",
);
const {
  createShortcutsIpc,
  findConflict,
  registerShortcutsIpc,
} = createRequire(import.meta.url)("./shortcuts-ipc.js");

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-shortcuts-ipc-"));
  const filePath = path.join(root, "config", KEYBINDINGS_FILE_NAME);
  return { root, store: createKeybindingsStore({ filePath }) };
}

function makeHotkey(store) {
  const held = new Set();
  return createGlobalToggleHotkey({
    globalShortcut: {
      register: (accel, cb) => {
        held.add(accel);
        held.cb = cb;
        return true;
      },
      unregister: (accel) => held.delete(accel),
      unregisterAll: () => held.clear(),
      isRegistered: (accel) => held.has(accel),
    },
    store,
    getWindow: () => null,
    showMainWindow: () => {},
  });
}

function makeService(store) {
  return createShortcutsIpc({ store, hotkey: makeHotkey(store) });
}

describe("shortcuts IPC service", () => {
  it("getState composes window bindings and live global status", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    const state = service.getState();
    expect(state).toEqual({
      window: {
        toggleSidebar: "Mod+B",
        historyBack: "Alt+Left",
        historyForward: "Alt+Right",
        zoomIn: "Mod+Equal",
        zoomOut: "Mod+Minus",
        zoomReset: "Mod+0",
      },
      global: {
        enabled: false,
        combo: "Mod+Alt+V",
        registered: false,
        error: null,
      },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("setWindowBinding writes and returns the authoritative state", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    const result = service.setWindowBinding({
      action: "toggleSidebar",
      combo: "Mod+Shift+B",
    });
    expect(result.ok).toBe(true);
    expect(result.state.window.toggleSidebar).toBe("Mod+Shift+B");
    expect(store.read().window.toggleSidebar).toBe("Mod+Shift+B");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a combo already held by another action", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    const conflict = service.setWindowBinding({
      action: "historyBack",
      combo: "Mod+B",
    });
    expect(conflict).toEqual({
      ok: false,
      code: "conflict",
      conflictingAction: "toggleSidebar",
    });
    expect(store.read().window.historyBack).toBe("Alt+Left");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a combo held by the enabled global hotkey, both directions", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    service.setGlobalToggle({ enabled: true });

    expect(
      service.setWindowBinding({ action: "toggleSidebar", combo: "Mod+Alt+V" }),
    ).toEqual({
      ok: false,
      code: "conflict",
      conflictingAction: "toggleWindow",
    });
    expect(
      service.setGlobalToggle({ combo: "Alt+Left" }),
    ).toEqual({
      ok: false,
      code: "conflict",
      conflictingAction: "historyBack",
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("cleared bindings no longer participate in conflicts", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    service.setWindowBinding({ action: "toggleSidebar", combo: null });
    const result = service.setWindowBinding({
      action: "historyBack",
      combo: "Mod+B",
    });
    expect(result.ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects malformed payloads before touching the store", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    expect(() =>
      service.setWindowBinding({ action: "bogus", combo: "Mod+Q" }),
    ).toThrow(/Unknown window shortcut action/);
    expect(() =>
      service.setWindowBinding({ action: "toggleSidebar", combo: "Q" }),
    ).toThrow(/Invalid key combination/);
    expect(() => service.setGlobalToggle({ combo: "F9" })).toThrow(
      /not a valid combination/,
    );
    expect(() => service.setGlobalToggle({})).toThrow(/must not be empty/);
    expect(() => service.setGlobalToggle({ volume: 1 })).toThrow(
      /Unknown global hotkey field/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("setGlobalToggle enables the hotkey and reports live registration", () => {
    const { root, store } = makeStore();
    const service = makeService(store);
    const result = service.setGlobalToggle({ enabled: true });
    expect(result.ok).toBe(true);
    expect(result.state.global).toEqual({
      enabled: true,
      combo: "Mod+Alt+V",
      registered: true,
      error: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("findConflict", () => {
  it("detects window/window and window/global collisions only when enabled", () => {
    const base = {
      window: {
        toggleSidebar: "Mod+B",
        historyBack: "Alt+Left",
        historyForward: null,
      },
      globalToggleWindow: { enabled: false, combo: "Mod+Alt+V" },
    };
    expect(findConflict(base, "historyForward", "Mod+Equal")).toBeNull();
    expect(findConflict(base, "historyForward", "Mod+B")).toBe("toggleSidebar");
    expect(findConflict(base, "historyForward", "Mod+Alt+V")).toBeNull();
    expect(
      findConflict(
        {
          ...base,
          globalToggleWindow: { enabled: true, combo: "Mod+Alt+V" },
        },
        "historyForward",
        "Mod+Alt+V",
      ),
    ).toBe("toggleWindow");
    expect(
      findConflict(
        {
          ...base,
          globalToggleWindow: { enabled: true, combo: "Mod+Alt+V" },
        },
        "toggleWindow",
        "Alt+Left",
      ),
    ).toBe("historyBack");
  });

  it("treats zoom-in default aliases as taken, and frees them after a rebind", () => {
    const base = {
      window: {
        toggleSidebar: "Mod+B",
        historyBack: "Alt+Left",
        historyForward: "Alt+Right",
        zoomIn: "Mod+Equal",
        zoomOut: "Mod+Minus",
        zoomReset: "Mod+0",
      },
      globalToggleWindow: { enabled: false, combo: "Mod+Alt+V" },
    };
    expect(findConflict(base, "historyBack", "Mod+Shift+Plus")).toBe("zoomIn");
    expect(findConflict(base, "historyBack", "Mod+Plus")).toBe("zoomIn");
    expect(findConflict(base, "zoomIn", "Mod+Shift+Plus")).toBeNull();
    expect(
      findConflict(
        { ...base, window: { ...base.window, zoomIn: "Mod+Shift+K" } },
        "historyBack",
        "Mod+Equal",
      ),
    ).toBeNull();
    expect(
      findConflict(
        { ...base, window: { ...base.window, zoomIn: "Mod+Shift+K" } },
        "historyBack",
        "Mod+Shift+Plus",
      ),
    ).toBeNull();
  });
});

describe("registerShortcutsIpc sender trust", () => {
  function makeHarness() {
    const handlers = new Map();
    const ipcMain = {
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel),
    };
    const mainFrame = { url: "http://127.0.0.1:4000/dashboard" };
    const webContents = { mainFrame };
    const win = {
      webContents,
      isDestroyed: () => false,
    };
    const { root, store } = makeStore();
    const release = registerShortcutsIpc(ipcMain, {
      store,
      hotkey: makeHotkey(store),
      getWindow: () => win,
      getOrigin: () => "http://127.0.0.1:4000",
    });
    return { handlers, webContents, mainFrame, release, root };
  }

  it("serves the main window's own frame and rejects everything else", () => {
    const { handlers, webContents, mainFrame, root } = makeHarness();
    const getState = handlers.get("desktopShortcuts:getState");
    expect(typeof getState).toBe("function");

    const trusted = getState({ sender: webContents, senderFrame: mainFrame });
    expect(trusted.window.toggleSidebar).toBe("Mod+B");

    expect(() =>
      getState({
        sender: {},
        senderFrame: mainFrame,
      }),
    ).toThrow(/Untrusted shortcuts sender/);
    expect(() =>
      getState({
        sender: webContents,
        senderFrame: { url: "https://evil.example/" },
      }),
    ).toThrow(/Untrusted shortcuts sender/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("release removes every registered handler", () => {
    const { handlers, release, root } = makeHarness();
    expect(handlers.size).toBe(5);
    release();
    expect(handlers.size).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
