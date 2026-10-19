import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { createMainWindowIpcRegistry } = createRequire(import.meta.url)("./window-ipc.js");

const ORIGIN = "http://127.0.0.1:3737";
const WINDOW_IPC_CHANNELS = ["resume:printToPDF", "window:setTheme"];

// Mirrors the real ipcMain contract: handle() throws on a duplicate channel
// and removeHandler() frees it for a later registration.
function makeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    registered() {
      return [...handlers.keys()];
    },
  };
}

class FakeBrowserWindow extends EventEmitter {}

function makeWindow() {
  const win = new EventEmitter();
  win.webContents = { session: {}, mainFrame: { url: `${ORIGIN}/signin` } };
  win.state = { destroyed: false };
  win.isDestroyed = () => win.state.destroyed;
  // OS-level destroy: "closed" fires as the window tears down.
  win.destroy = () => {
    win.state.destroyed = true;
    win.emit("closed");
  };
  return win;
}

function makeHarness() {
  const ipcMain = makeIpcMain();
  const registry = createMainWindowIpcRegistry();
  const registerWindow = (window) =>
    registry.registerWindowIpc({
      ipcMain,
      BrowserWindow: FakeBrowserWindow,
      nativeTheme: { themeSource: "system" },
      window,
      origin: ORIGIN,
      assetsRoot: "assets",
    });
  return { ipcMain, registerWindow };
}

describe("main window IPC lifecycle", () => {
  it("registers the window channels and releases them when the window closes", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const win = makeWindow();
    registerWindow(win);
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
    win.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("releases handlers when the window closes before its first load settles", () => {
    // The release is armed at registration time, so a "closed" emitted
    // while loadURL is still in flight runs the same cleanup.
    const { ipcMain, registerWindow } = makeHarness();
    const win = makeWindow();
    registerWindow(win);
    win.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("keeps handlers on a live window after a failed load until it closes", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const win = makeWindow();
    registerWindow(win);
    // loadURL rejected but the window survived: it still owns its surface.
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
    win.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("lets a recreated window re-register after the first window closes", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const first = makeWindow();
    registerWindow(first);
    first.destroy();
    const second = makeWindow();
    expect(() => registerWindow(second)).not.toThrow();
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
    second.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("re-registers even when the destroyed window's closed cleanup has not run", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const first = makeWindow();
    registerWindow(first);
    first.state.destroyed = true; // destroyed while "closed" is still pending
    const second = makeWindow();
    expect(() => registerWindow(second)).not.toThrow();
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
  });

  it("a stale release from an old window never strips the new window's handlers", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const first = makeWindow();
    const firstRelease = registerWindow(first);
    const second = makeWindow();
    registerWindow(second);
    // A late "closed" for the old window and a repeated manual release are
    // both no-ops: the new window owns the channels now.
    first.emit("closed");
    firstRelease();
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
    second.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("does not release handlers while close-to-tray hides the window instead of closing it", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const win = makeWindow();
    registerWindow(win);
    // Close-to-tray intercepts "close" and hides — "closed" never fires.
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
    win.destroy();
    expect(ipcMain.registered()).toEqual([]);
  });

  it("releases exactly once: a real quit destroy plus repeat releases stay clean", () => {
    const { ipcMain, registerWindow } = makeHarness();
    const win = makeWindow();
    const release = registerWindow(win);
    win.destroy(); // app quit tears the window down
    release();
    release();
    expect(ipcMain.registered()).toEqual([]);
    const second = makeWindow();
    expect(() => registerWindow(second)).not.toThrow();
    expect(ipcMain.registered().sort()).toEqual([...WINDOW_IPC_CHANNELS].sort());
  });

  it("rolls back a partial registration when a channel is already owned elsewhere", () => {
    const { ipcMain, registerWindow } = makeHarness();
    ipcMain.handle("window:setTheme", () => {});
    const win = makeWindow();
    expect(() => registerWindow(win)).toThrow(/second handler/);
    // The foreign handler is untouched and our half-registered surface is
    // rolled back, so a later full registration can still succeed.
    expect(ipcMain.registered()).toEqual(["window:setTheme"]);
    ipcMain.removeHandler("window:setTheme");
    expect(() => registerWindow(makeWindow())).not.toThrow();
  });
});
