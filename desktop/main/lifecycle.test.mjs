import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { createDesktopLifecycle, createLoginItemsAdapter } = createRequire(import.meta.url)("./lifecycle.js");
const { createDesktopSettingsStore } = createRequire(import.meta.url)("./desktop-settings.js");

const ORIGIN = "http://127.0.0.1:3737";

function makeWindow() {
  const win = new EventEmitter();
  win.state = { destroyed: false, minimized: false, visible: true, focused: false };
  win.webContents = { mainFrame: { url: `${ORIGIN}/signin` } };
  win.isDestroyed = () => win.state.destroyed;
  win.isMinimized = () => win.state.minimized;
  win.isVisible = () => win.state.visible;
  win.hide = vi.fn(() => {
    win.state.visible = false;
  });
  win.show = vi.fn(() => {
    win.state.visible = true;
  });
  win.restore = vi.fn(() => {
    win.state.minimized = false;
  });
  win.focus = vi.fn(() => {
    win.state.focused = true;
  });
  win.minimize = vi.fn(() => {
    win.state.minimized = true;
    win.state.visible = true;
  });
  // Simulates the OS-level close: listeners see a cancelable event, and the
  // window is destroyed only when nobody prevented default.
  win.close = () => {
    const event = { preventDefault: vi.fn(() => (event.defaultPrevented = true)), defaultPrevented: false };
    win.emit("close", event);
    if (!event.defaultPrevented) win.state.destroyed = true;
    return event;
  };
  return win;
}

class FakeTray extends EventEmitter {
  static instances = [];
  constructor(image) {
    super();
    if (image === "THROW") throw new Error("tray icon rejected by OS");
    this.image = image;
    this.destroyed = false;
    FakeTray.instances.push(this);
  }
  setToolTip(text) {
    this.tooltip = text;
  }
  setContextMenu(menu) {
    this.menu = menu;
  }
  destroy() {
    this.destroyed = true;
  }
}

function makeLoginItems() {
  const state = { openAtLogin: false };
  const adapter = {
    supported: true,
    getOpenAtLogin: vi.fn(() => state.openAtLogin),
    setOpenAtLogin: vi.fn((enabled) => {
      state.openAtLogin = enabled;
    }),
    state,
  };
  return adapter;
}

function makeHarness({ settings, loginItems, window, createWindow } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-lifecycle-"));
  const store =
    settings && typeof settings.read === "function"
      ? settings
      : createDesktopSettingsStore({ filePath: path.join(root, "config", "desktop-settings.json") });
  if (settings && typeof settings.read !== "function") store.update(settings);
  const app = { quit: vi.fn(), isPackaged: false };
  const Menu = { buildFromTemplate: vi.fn((template) => template) };
  const win = window === undefined ? makeWindow() : window;
  const windows = [win].filter(Boolean);
  const lifecycle = createDesktopLifecycle({
    app,
    Tray: FakeTray,
    Menu,
    trayIconPath: "icon.ico",
    settingsStore: store,
    loginItems: loginItems === undefined ? makeLoginItems() : loginItems,
    getWindow: () => windows[0],
    createWindow: createWindow || null,
  });
  FakeTray.instances = [];
  return {
    app,
    lifecycle,
    Menu,
    root,
    store,
    window: win,
    pushWindow(w) {
      windows[0] = w;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("close-to-tray interception", () => {
  it("lets the close through when closeToTray is off (compatible default)", () => {
    const { lifecycle, window, cleanup } = makeHarness();
    lifecycle.ensureTray();
    lifecycle.attachWindow(window);
    const event = window.close();
    expect(event.defaultPrevented).toBe(false);
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.state.destroyed).toBe(true);
    cleanup();
  });

  it("hides to the tray instead of closing when enabled", () => {
    const { lifecycle, store, window, cleanup } = makeHarness({ settings: { closeToTray: true } });
    lifecycle.ensureTray();
    lifecycle.attachWindow(window);
    const event = window.close();
    expect(event.defaultPrevented).toBe(true);
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.state.visible).toBe(false);
    expect(window.state.destroyed).toBe(false);
    expect(lifecycle.getState().closeToTrayActive).toBe(true);
    cleanup();
    void store;
  });

  it("does not hide when the tray is unavailable — never strands the window", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-lc-notray-"));
    const store = createDesktopSettingsStore({ filePath: path.join(root, "s.json") });
    store.update({ closeToTray: true });
    const window = makeWindow();
    const lc = createDesktopLifecycle({
      app: { quit: vi.fn() },
      Tray: class {
        constructor() {
          throw new Error("tray denied");
        }
      },
      Menu: { buildFromTemplate: (t) => t },
      trayIconPath: "icon.ico",
      settingsStore: store,
      loginItems: makeLoginItems(),
      getWindow: () => window,
      logger: { error: () => {} },
    });
    expect(lc.ensureTray()).toBeNull();
    lc.attachWindow(window);
    const event = window.close();
    expect(event.defaultPrevented).toBe(false);
    expect(window.state.destroyed).toBe(true);
    expect(lc.getState().closeToTrayActive).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a close during a real quit is never re-intercepted by close-to-tray", () => {
    const { lifecycle, window, cleanup } = makeHarness({ settings: { closeToTray: true } });
    lifecycle.ensureTray();
    lifecycle.attachWindow(window);
    lifecycle.beginQuit();
    const event = window.close();
    expect(event.defaultPrevented).toBe(false);
    expect(window.state.destroyed).toBe(true);
    cleanup();
  });
});

describe("tray surface", () => {
  it("builds a menu with open + quit entries and restores on click", async () => {
    const { lifecycle, window, cleanup } = makeHarness({ settings: { closeToTray: true } });
    const tray = lifecycle.ensureTray();
    expect(tray.tooltip).toBe("Vocatrya");
    const labels = tray.menu.map((item) => item.label || item.type);
    expect(labels).toEqual(["打开 Vocatrya", "separator", "退出 Vocatrya"]);
    window.state.visible = false;
    tray.emit("click");
    await Promise.resolve();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    cleanup();
  });

  it("menu quit latches quitting and asks the app to quit", () => {
    const { lifecycle, app, cleanup } = makeHarness();
    const tray = lifecycle.ensureTray();
    tray.menu.find((item) => item.label === "退出 Vocatrya").click();
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(lifecycle.isQuitting()).toBe(true);
    cleanup();
  });

  it("menu open recreates a missing window through the injected factory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-lc2-"));
    const created = makeWindow();
    created.state.visible = false;
    const factory = vi.fn(async () => {});
    let current = null;
    const lc = createDesktopLifecycle({
      app: { quit: vi.fn() },
      Tray: FakeTray,
      Menu: { buildFromTemplate: (t) => t },
      trayIconPath: "icon.ico",
      settingsStore: createDesktopSettingsStore({ filePath: path.join(root, "desktop-settings.json") }),
      loginItems: makeLoginItems(),
      getWindow: () => current,
      createWindow: async () => {
        factory();
        current = created;
      },
    });
    FakeTray.instances = [];
    await lc.showMainWindow();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(created.show).toHaveBeenCalled();
    expect(created.focus).toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tray creation failure degrades to no tray instead of crashing startup", () => {
    const app = { quit: vi.fn() };
    const store = createDesktopSettingsStore({
      filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-lc3-")), "s.json"),
    });
    const logger = { error: vi.fn() };
    const lc = createDesktopLifecycle({
      app,
      Tray: class {
        constructor() {
          throw new Error("denied");
        }
      },
      Menu: { buildFromTemplate: (t) => t },
      trayIconPath: "icon.ico",
      settingsStore: store,
      loginItems: makeLoginItems(),
      getWindow: () => null,
      logger,
    });
    expect(lc.ensureTray()).toBeNull();
    expect(lc.getState().trayAvailable).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("window restore", () => {
  it("restores a minimized window", async () => {
    const { lifecycle, window, cleanup } = makeHarness();
    lifecycle.ensureTray();
    window.state.minimized = true;
    await lifecycle.showMainWindow();
    expect(window.restore).toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    cleanup();
  });

  it("shows a tray-hidden window", async () => {
    const { lifecycle, window, cleanup } = makeHarness({ settings: { closeToTray: true } });
    lifecycle.ensureTray();
    lifecycle.attachWindow(window);
    window.close();
    expect(window.state.visible).toBe(false);
    await lifecycle.showMainWindow();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    cleanup();
  });

  it("un-hides before restoring a hidden+minimized window", async () => {
    const { lifecycle, window, cleanup } = makeHarness();
    lifecycle.ensureTray();
    window.state.visible = false;
    window.state.minimized = true;
    await lifecycle.showMainWindow();
    expect(window.show).toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    cleanup();
  });

  it("surfaces a recreate failure through the logger instead of a stray rejection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-lc4-"));
    const logger = { error: vi.fn() };
    const lc = createDesktopLifecycle({
      app: { quit: vi.fn() },
      Tray: FakeTray,
      Menu: { buildFromTemplate: (t) => t },
      trayIconPath: "icon.ico",
      settingsStore: createDesktopSettingsStore({ filePath: path.join(root, "s.json") }),
      loginItems: makeLoginItems(),
      getWindow: () => null,
      createWindow: async () => {
        throw new Error("backend not ready");
      },
      logger,
    });
    await lc.showMainWindow();
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][1].message).toContain("backend not ready");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("launch minimized", () => {
  it("reports startMinimized from the settings document", () => {
    const { lifecycle, cleanup } = makeHarness({ settings: { startMinimized: true } });
    expect(lifecycle.shouldStartMinimized()).toBe(true);
    cleanup();
  });

  it("minimizes once ready-to-show fires", () => {
    const { lifecycle, window, cleanup } = makeHarness({ settings: { startMinimized: true } });
    lifecycle.attachWindow(window);
    window.emit("ready-to-show");
    expect(window.minimize).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("shows the hidden launch window before minimizing it", () => {
    // On Windows minimize() is a no-op on a never-shown window — the handler
    // must show() first so the OS can actually minimize it.
    const { lifecycle, window, cleanup } = makeHarness({ settings: { startMinimized: true } });
    window.state.visible = false;
    lifecycle.attachWindow(window);
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.minimize).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("never minimizes when startMinimized is off", () => {
    const { lifecycle, window, cleanup } = makeHarness();
    lifecycle.attachWindow(window);
    window.emit("ready-to-show");
    expect(window.minimize).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("login items (real OS state)", () => {
  it("reads the real OS login state", () => {
    const loginItems = makeLoginItems();
    loginItems.state.openAtLogin = true;
    const { lifecycle, cleanup } = makeHarness({ loginItems });
    expect(lifecycle.getState().openAtLogin).toBe(true);
    expect(lifecycle.getState().openAtLoginSupported).toBe(true);
    cleanup();
  });

  it("enables and verifies the write by reading the OS state back", () => {
    const loginItems = makeLoginItems();
    const { lifecycle, cleanup } = makeHarness({ loginItems });
    const state = lifecycle.setOpenAtLogin(true);
    expect(loginItems.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(state.openAtLogin).toBe(true);
    cleanup();
  });

  it("fails loudly when the OS write does not take effect", () => {
    const loginItems = makeLoginItems();
    loginItems.setOpenAtLogin = vi.fn(() => {}); // write lands nowhere
    const { lifecycle, cleanup } = makeHarness({ loginItems });
    expect(() => lifecycle.setOpenAtLogin(true)).toThrow(/did not take effect/);
    cleanup();
  });

  it("propagates adapter write errors verbatim", () => {
    const loginItems = makeLoginItems();
    loginItems.setOpenAtLogin = vi.fn(() => {
      throw new Error("registry access denied");
    });
    const { lifecycle, cleanup } = makeHarness({ loginItems });
    expect(() => lifecycle.setOpenAtLogin(true)).toThrow(/registry access denied/);
    cleanup();
  });

  it("reports unsupported platforms instead of faking capability", () => {
    const { lifecycle, cleanup } = makeHarness({ loginItems: { supported: false } });
    const state = lifecycle.getState();
    expect(state.openAtLoginSupported).toBe(false);
    expect(state.openAtLogin).toBe(false);
    expect(() => lifecycle.setOpenAtLogin(true)).toThrow(/not supported/);
    cleanup();
  });

  it("surfaces a read error without faking the enabled flag", () => {
    const loginItems = makeLoginItems();
    loginItems.getOpenAtLogin = vi.fn(() => {
      throw new Error("registry read failed");
    });
    const { lifecycle, cleanup } = makeHarness({ loginItems });
    const state = lifecycle.getState();
    expect(state.openAtLogin).toBe(false);
    expect(state.openAtLoginError).toContain("registry read failed");
    cleanup();
  });

  it("win32 adapter passes an explicit exe path and dev app args", () => {
    const app = {
      isPackaged: false,
      getAppPath: () => "C:\\repo",
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
    };
    const adapter = createLoginItemsAdapter({ app, platform: "win32" });
    expect(adapter.supported).toBe(true);
    adapter.setOpenAtLogin(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: process.execPath,
      args: ["C:\\repo"],
    });
    const packaged = createLoginItemsAdapter({
      app: { ...app, isPackaged: true },
      platform: "win32",
    });
    packaged.setOpenAtLogin(false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
      path: process.execPath,
      args: [],
    });
  });

  it("non-supported platforms expose no adapter capability", () => {
    const adapter = createLoginItemsAdapter({
      app: { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() },
      platform: "linux",
    });
    expect(adapter.supported).toBe(false);
  });
});

describe("explicit quit", () => {
  it("quit() latches the flag and quits the app once", () => {
    const { lifecycle, app, cleanup } = makeHarness();
    lifecycle.quit();
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(lifecycle.isQuitting()).toBe(true);
    cleanup();
  });
});

describe("lifecycle IPC boundary", () => {
  function makeIpcHarness() {
    const harness = makeHarness({ settings: { closeToTray: true } });
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
    const unregister = harness.lifecycle.registerIpc(ipcMain, () => ORIGIN);
    const handlers = new Map(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
    const goodEvent = {
      sender: harness.window.webContents,
      senderFrame: harness.window.webContents.mainFrame,
    };
    return { ...harness, ipcMain, handlers, goodEvent, unregister };
  }

  it("registers exactly the six lifecycle channels", () => {
    const { handlers, cleanup } = makeIpcHarness();
    expect([...handlers.keys()].sort()).toEqual([
      "desktopLifecycle:getState",
      "desktopLifecycle:quit",
      "desktopLifecycle:setCloseToTray",
      "desktopLifecycle:setOpenAtLogin",
      "desktopLifecycle:setStartMinimized",
      "desktopLifecycle:showWindow",
    ]);
    cleanup();
  });

  it("returns real state to the trusted main window", () => {
    const { handlers, goodEvent, cleanup } = makeIpcHarness();
    const state = handlers.get("desktopLifecycle:getState")(goodEvent);
    expect(state.closeToTray).toBe(true);
    cleanup();
  });

  it("rejects foreign senders, subframes, and foreign origins", () => {
    const { handlers, goodEvent, window, cleanup } = makeIpcHarness();
    const getState = handlers.get("desktopLifecycle:getState");
    expect(() => getState({ ...goodEvent, sender: {} })).toThrow(/Untrusted/);
    expect(() =>
      getState({ ...goodEvent, senderFrame: { url: goodEvent.senderFrame.url } }),
    ).toThrow(/Untrusted/);
    window.webContents.mainFrame.url = "https://evil.example/";
    expect(() => getState(goodEvent)).toThrow(/Untrusted/);
    cleanup();
  });

  it("applies boolean toggles through IPC and persists them", () => {
    const { handlers, goodEvent, store, cleanup } = makeIpcHarness();
    const next = handlers.get("desktopLifecycle:setStartMinimized")(goodEvent, { enabled: true });
    expect(next.startMinimized).toBe(true);
    expect(store.read().startMinimized).toBe(true);
    expect(() =>
      handlers.get("desktopLifecycle:setCloseToTray")(goodEvent, { enabled: "yes" }),
    ).toThrow(/boolean/);
    cleanup();
  });

  it("quits via IPC through the same latched path", () => {
    const { handlers, goodEvent, app, lifecycle, cleanup } = makeIpcHarness();
    handlers.get("desktopLifecycle:quit")(goodEvent);
    expect(app.quit).toHaveBeenCalled();
    expect(lifecycle.isQuitting()).toBe(true);
    cleanup();
  });

  it("unregister removes every handler", () => {
    const { ipcMain, unregister, cleanup } = makeIpcHarness();
    unregister();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(6);
    cleanup();
  });
});
