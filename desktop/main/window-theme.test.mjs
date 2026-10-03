import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const { registerWindowThemeIpc } = createRequire(import.meta.url)("./window-theme.js");

describe("resolved window theme", () => {
  function setup() {
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
    const mainFrame = { url: "http://127.0.0.1:3737/dashboard" };
    const window = { isDestroyed: () => false, webContents: { mainFrame }, setIcon: vi.fn() };
    const nativeTheme = { themeSource: "system" };
    const cleanup = registerWindowThemeIpc({ ipcMain, nativeTheme, window, origin: "http://127.0.0.1:3737", assetsRoot: "assets", platform: "win32" });
    return { window, nativeTheme, ipcMain, cleanup, handler: ipcMain.handle.mock.calls[0][1], event: { sender: window.webContents, senderFrame: mainFrame } };
  }
  it("updates light, dark and light without recreating the window", () => {
    const { handler, event, window, cleanup, ipcMain } = setup();
    for (const theme of ["light", "dark", "light"]) handler(event, theme);
    expect(window.setIcon.mock.calls.map(([file]) => path.basename(file))).toEqual([
      "native-window-dark-symbol.ico", "native-window-light-symbol.ico", "native-window-dark-symbol.ico",
    ]);
    cleanup(); expect(ipcMain.removeHandler).toHaveBeenCalledWith("window:setTheme");
  });
  it("matches explicit native chrome while keeping system media queries live", () => {
    const { handler, event, nativeTheme } = setup();
    handler(event, "dark", "dark"); expect(nativeTheme.themeSource).toBe("dark");
    handler(event, "light", "light"); expect(nativeTheme.themeSource).toBe("light");
    handler(event, "dark", "system"); expect(nativeTheme.themeSource).toBe("system");
  });
  it("rejects subframes, foreign senders, origins and invalid themes", () => {
    const { handler, event } = setup();
    expect(() => handler(event, "system")).toThrow("Invalid resolved theme");
    expect(() => handler({ ...event, sender: {} }, "light")).toThrow();
    expect(() => handler({ ...event, senderFrame: { url: event.senderFrame.url } }, "light")).toThrow();
    event.senderFrame.url = "https://example.com";
    expect(() => handler(event, "dark")).toThrow();
  });
  it("changes only Optical small entries and preserves every App Icon entry", () => {
    const assets = new URL("../assets/", import.meta.url);
    function read(name) {
      const bytes = fs.readFileSync(new URL(name, assets));
      return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
        const offset = 6 + i * 16;
        const start = bytes.readUInt32LE(offset + 12);
        return { size: bytes[offset] || 256, data: bytes.subarray(start, start + bytes.readUInt32LE(offset + 8)) };
      });
    }
    const identity = read("icon.ico");
    const dark = read("native-window-dark-symbol.ico");
    const light = read("native-window-light-symbol.ico");
    expect(dark.map(entry => entry.size)).toEqual(identity.map(entry => entry.size));
    for (const [i, entry] of identity.entries()) {
      if (entry.size <= 24) expect(dark[i].data.equals(light[i].data)).toBe(false);
      else {
        expect(dark[i].data.equals(entry.data)).toBe(true);
        expect(light[i].data.equals(entry.data)).toBe(true);
      }
    }
  });
});
