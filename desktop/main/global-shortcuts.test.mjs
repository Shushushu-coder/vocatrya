import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const {
  GLOBAL_SHORTCUT_IPC_CHANNELS,
  comboToAccelerator,
  createGlobalToggleHotkey,
} = createRequire(import.meta.url)("./global-shortcuts.js");
const { createKeybindingsStore, KEYBINDINGS_FILE_NAME } = createRequire(
  import.meta.url,
)("./keybindings.js");

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-hotkey-"));
  const filePath = path.join(root, "config", KEYBINDINGS_FILE_NAME);
  return {
    root,
    store: createKeybindingsStore({ filePath }),
  };
}

// Minimal globalShortcut double: register() can be told to refuse specific
// accelerators (simulating an OS-held combo) and always tells the truth via
// isRegistered.
function makeGlobalShortcut(refusals = new Set()) {
  const held = new Set();
  const callbacks = new Map();
  return {
    held,
    callbacks,
    register: vi.fn((accelerator, callback) => {
      if (refusals.has(accelerator) || held.has(accelerator)) return false;
      held.add(accelerator);
      callbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator) => {
      held.delete(accelerator);
      callbacks.delete(accelerator);
    }),
    unregisterAll: vi.fn(() => {
      held.clear();
      callbacks.clear();
    }),
    isRegistered: vi.fn((accelerator) => held.has(accelerator)),
  };
}

function makeWindow({ visible = true, focused = true } = {}) {
  return {
    visible,
    focused,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isFocused() {
      return this.focused;
    },
    hide: vi.fn(function hide() {
      this.visible = false;
      this.focused = false;
    }),
  };
}

function makeHotkey({ store, globalShortcut, window }) {
  const showMainWindow = vi.fn(async () => {});
  const hotkey = createGlobalToggleHotkey({
    globalShortcut,
    store,
    getWindow: () => window,
    showMainWindow,
  });
  return { hotkey, showMainWindow };
}

describe("comboToAccelerator", () => {
  it("translates Mod and named punctuation tokens", () => {
    expect(comboToAccelerator("Mod+B")).toBe("CommandOrControl+B");
    expect(comboToAccelerator("Mod+Alt+V")).toBe("CommandOrControl+Alt+V");
    expect(comboToAccelerator("Alt+Left")).toBe("Alt+Left");
    expect(comboToAccelerator("Mod+Shift+Comma")).toBe(
      "CommandOrControl+Shift+,",
    );
    expect(comboToAccelerator("Mod+Plus")).toBe("CommandOrControl+Plus");
    expect(comboToAccelerator("B")).toBeNull();
    expect(comboToAccelerator(null)).toBeNull();
  });
});

describe("global toggle hotkey", () => {
  it("stays unregistered while disabled and registers on enable", () => {
    const { root, store } = makeStore();
    const globalShortcut = makeGlobalShortcut();
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });

    hotkey.apply();
    expect(globalShortcut.register).not.toHaveBeenCalled();
    expect(hotkey.status()).toEqual({
      enabled: false,
      combo: "Mod+Alt+V",
      registered: false,
      error: null,
    });

    const result = hotkey.setGlobalToggle({ enabled: true });
    expect(result.ok).toBe(true);
    expect(globalShortcut.register).toHaveBeenCalledWith(
      "CommandOrControl+Alt+V",
      expect.any(Function),
    );
    const status = hotkey.status();
    expect(status.enabled).toBe(true);
    expect(status.registered).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("toggles: visible+focused hides, anything else restores via showMainWindow", async () => {
    const { root, store } = makeStore();
    const globalShortcut = makeGlobalShortcut();
    const window = makeWindow();
    const { hotkey, showMainWindow } = makeHotkey({
      store,
      globalShortcut,
      window,
    });
    hotkey.setGlobalToggle({ enabled: true });
    const press = globalShortcut.callbacks.get("CommandOrControl+Alt+V");

    press();
    expect(window.hide).toHaveBeenCalled();
    expect(showMainWindow).not.toHaveBeenCalled();

    press();
    expect(showMainWindow).toHaveBeenCalledTimes(1);

    const minimized = makeWindow({ visible: true, focused: false });
    minimized.isMinimized = () => true;
    const { hotkey: second, showMainWindow: secondShow } = makeHotkey({
      store,
      globalShortcut: makeGlobalShortcut(),
      window: minimized,
    });
    second.setGlobalToggle({ enabled: true });
    second.toggle();
    expect(secondShow).toHaveBeenCalledTimes(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rebind: unregister old combo then register the new one", () => {
    const { root, store } = makeStore();
    const globalShortcut = makeGlobalShortcut();
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });
    hotkey.setGlobalToggle({ enabled: true });

    const order = [];
    globalShortcut.unregister.mockImplementation((a) => order.push(["u", a]));
    globalShortcut.register.mockImplementation((a, cb) => {
      order.push(["r", a]);
      globalShortcut.held.add(a);
      globalShortcut.callbacks.set(a, cb);
      return true;
    });

    const result = hotkey.setGlobalToggle({ combo: "Mod+Shift+Space" });
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      ["u", "CommandOrControl+Alt+V"],
      ["r", "CommandOrControl+Shift+Space"],
    ]);
    expect(store.read().globalToggleWindow.combo).toBe("Mod+Shift+Space");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rolls back to the working combo when the new one is occupied", () => {
    const { root, store } = makeStore();
    // The OS pretends to own CommandOrControl+Shift+Q.
    const globalShortcut = makeGlobalShortcut(
      new Set(["CommandOrControl+Shift+Q"]),
    );
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });
    hotkey.setGlobalToggle({ enabled: true });
    expect(hotkey.status().registered).toBe(true);

    const result = hotkey.setGlobalToggle({ combo: "Mod+Shift+Q" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("occupied");
    // Store rolls back and the previous accelerator is held again.
    expect(store.read().globalToggleWindow.combo).toBe("Mod+Alt+V");
    const status = hotkey.status();
    expect(status.combo).toBe("Mod+Alt+V");
    expect(status.registered).toBe(true);
    expect(status.error).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the persisted intent and reports the failure when enabling an occupied combo", () => {
    const { root, store } = makeStore();
    store.setGlobalToggle({ combo: "Mod+Shift+Q" });
    const globalShortcut = makeGlobalShortcut(
      new Set(["CommandOrControl+Shift+Q"]),
    );
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });
    const result = hotkey.setGlobalToggle({ enabled: true });
    expect(result.ok).toBe(true);
    const status = hotkey.status();
    expect(status.enabled).toBe(true);
    expect(status.registered).toBe(false);
    expect(status.error).toBe("occupied");
    expect(store.read().globalToggleWindow.enabled).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("restore on startup applies a stored enabled intent", () => {
    const { root, store } = makeStore();
    store.setGlobalToggle({ enabled: true, combo: "Mod+Shift+Space" });
    const globalShortcut = makeGlobalShortcut();
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });
    hotkey.apply();
    expect(globalShortcut.isRegistered("CommandOrControl+Shift+Space")).toBe(
      true,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("dispose unregisters everything", () => {
    const { root, store } = makeStore();
    const globalShortcut = makeGlobalShortcut();
    const { hotkey } = makeHotkey({ store, globalShortcut, window: null });
    hotkey.setGlobalToggle({ enabled: true });
    hotkey.dispose();
    expect(globalShortcut.unregisterAll).toHaveBeenCalled();
    expect(globalShortcut.held.size).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("IPC channel contract", () => {
  it("exposes the three channels the preload invokes", () => {
    expect(GLOBAL_SHORTCUT_IPC_CHANNELS).toEqual({
      getState: "desktopShortcuts:getState",
      setWindowBinding: "desktopShortcuts:setWindowBinding",
      setGlobalToggle: "desktopShortcuts:setGlobalToggle",
    });
  });
});
