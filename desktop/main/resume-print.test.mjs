import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
const { registerResumePrintIpc, CHANNEL } = createRequire(import.meta.url)("./resume-print.js");
const origin = "http://127.0.0.1:3737";

function setup({ load, ready, print, timeoutMs = 30_000 } = {}) {
  const hidden = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(), getURL: () => this.url,
        executeJavaScript: vi.fn(ready || (() => Promise.resolve(true))),
        printToPDF: vi.fn(print || (() => Promise.resolve(Buffer.from("%PDF-test")))),
        setZoomMode: vi.fn(),
        setZoomFactor: vi.fn(),
      });
      this.loadURL = vi.fn(async (url) => { this.url = url; if (load) await load(this, url); });
      this.destroy = vi.fn(() => { this.destroyed = true; this.emit("closed"); });
      hidden.push(this);
    }
    isDestroyed() { return this.destroyed; }
  }
  const mainFrame = { url: `${origin}/dashboard` };
  const window = { isDestroyed: () => false, webContents: { mainFrame, session: {} } };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
  const cleanup = registerResumePrintIpc({ ipcMain, BrowserWindow, window, origin, timeoutMs });
  const handler = ipcMain.handle.mock.calls[0][1];
  return { handler, event, hidden, window, cleanup, ipcMain };
}
afterEach(() => vi.useRealTimers());

describe("resume print IPC", () => {
  it("builds a fixed loopback URL, carries the session and prints A4 in a hidden sandbox", async () => {
    const { handler, event, hidden, window } = setup();
    expect(await handler(event, "version-1")).toEqual({ ok: true, bytes: new Uint8Array(Buffer.from("%PDF-test")) });
    expect(hidden[0].loadURL).toHaveBeenCalledWith(`${origin}/resume-print/version-1`);
    expect(hidden[0].options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: window.webContents.session } });
    expect(hidden[0].webContents.executeJavaScript.mock.calls[0][0]).toContain('dataset.resumePrintReady === expected');
    expect(hidden[0].webContents.setZoomMode).toHaveBeenCalledWith("isolated");
    expect(hidden[0].webContents.setZoomFactor).toHaveBeenCalledWith(1);
    expect(hidden[0].webContents.setZoomMode.mock.invocationCallOrder[0]).toBeLessThan(hidden[0].loadURL.mock.invocationCallOrder[0]);
    expect(hidden[0].webContents.setZoomFactor.mock.invocationCallOrder[0]).toBeLessThan(hidden[0].loadURL.mock.invocationCallOrder[0]);
    expect(hidden[0].webContents.printToPDF).toHaveBeenCalledWith({ pageSize: "A4", landscape: false, printBackground: true, preferCSSPageSize: true });
    expect(hidden[0].destroy).toHaveBeenCalledOnce();
  });
  it.each(["https://example.com", "../version", "id/other", "", null, {}, "a".repeat(129), "v\n1", "v?foo"])("rejects malformed input %j before creating a window", async (id) => {
    const { handler, event, hidden } = setup();
    expect(await handler(event, id)).toEqual({ ok: false, code: "invalid_version_id" });
    expect(hidden).toHaveLength(0);
  });
  it("rejects foreign senders, subframes and foreign origin", async () => {
    const { handler, event, hidden } = setup();
    expect(await handler({ ...event, sender: {} }, "id")).toEqual({ ok: false, code: "untrusted_sender" });
    expect(await handler({ ...event, senderFrame: { url: event.senderFrame.url } }, "id")).toEqual({ ok: false, code: "untrusted_sender" });
    event.senderFrame.url = "https://example.com";
    expect(await handler(event, "id")).toEqual({ ok: false, code: "untrusted_sender" });
    expect(hidden).toHaveLength(0);
  });
  it("joins overlapping requests for a version and allows later retries", async () => {
    const { handler, event, hidden } = setup();
    const first = handler(event, "id");
    const second = handler(event, "id");
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(hidden).toHaveLength(1);
    await handler(event, "id");
    expect(hidden).toHaveLength(2);
  });
  it.each(["load", "ready", "print"])("destroys the window when %s times out", async (phase) => {
    vi.useFakeTimers();
    const stall = () => new Promise(() => {});
    const config = { timeoutMs: 10, [phase]: stall };
    const { handler, event, hidden } = setup(config);
    const result = handler(event, "id");
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toEqual({ ok: false, code: "timeout" });
    expect(hidden[0].destroy).toHaveBeenCalledOnce();
  });
  it("destroys on load and print failure", async () => {
    const load = setup({ load: async () => { throw Object.assign(new Error("load failed"), { code: "ERR_FAILED" }); } });
    expect(await load.handler(load.event, "id")).toEqual({ ok: false, code: "load_failed" });
    expect(load.hidden[0].destroy).toHaveBeenCalledOnce();
    const print = setup({ print: async () => { throw new Error("print failed"); } });
    expect(await print.handler(print.event, "id")).toEqual({ ok: false, code: "print_failed" });
    expect(print.hidden[0].destroy).toHaveBeenCalledOnce();
  });
  it.each(["will-navigate", "will-redirect", "will-frame-navigate"])("blocks cross-origin %s", async (channel) => {
    const blocked = { preventDefault: vi.fn(), url: "https://example.com/" };
    const { handler, event, hidden } = setup({ load: async (window) => {
      if (channel === "will-frame-navigate") window.webContents.emit(channel, blocked);
      else window.webContents.emit(channel, blocked, blocked.url);
    } });
    expect(await handler(event, "id")).toEqual({ ok: false, code: "load_failed" });
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(hidden[0].destroy).toHaveBeenCalledOnce();
    expect(hidden[0].webContents.printToPDF).not.toHaveBeenCalled();
  });
  it("cleans up outstanding windows and channel when the main window closes", async () => {
    const { handler, event, cleanup, ipcMain, hidden } = setup({ ready: () => new Promise(() => {}) });
    const result = handler(event, "id");
    cleanup();
    expect(await result).toEqual({ ok: false, code: "load_failed" });
    expect(hidden[0].destroy).toHaveBeenCalledOnce();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CHANNEL);
  });
  it("preload exposes only a version-id invocation for resume printing", () => {
    const expose = vi.fn(); const invoke = vi.fn();
    vm.runInNewContext(fs.readFileSync(new URL("./preload.js", import.meta.url), "utf8"), {
      require: () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }),
    });
    const bridge = expose.mock.calls.find(([name]) => name === "vocatryaResume")[1];
    expect(Object.keys(bridge)).toEqual(["printToPDF"]);
    bridge.printToPDF("version-1");
    expect(invoke).toHaveBeenCalledWith(CHANNEL, "version-1");
    const main = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const windowIpc = fs.readFileSync(new URL("./window-ipc.js", import.meta.url), "utf8");
    expect(main).toContain("mainWindowIpc.registerWindowIpc({");
    expect(windowIpc).toContain("registerResumePrintIpc({ ipcMain, BrowserWindow, window, origin })");
    expect(windowIpc).toContain('window.once("closed", release)');
  });
});
