import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { registerInputPreferencesIpc } = createRequire(import.meta.url)("./input-preferences.js");
const snapshot = JSON.stringify({ enterBehavior: "next", editEntry: "end", hintMode: "off", autoFocus: true });

function bridge(filePath, fsImpl) {
  const handlers = new Map();
  const mainFrame = { url: "http://127.0.0.1:4321/dashboard" };
  const win = { isDestroyed: () => false, webContents: { mainFrame } };
  registerInputPreferencesIpc({ ipcMain: { on: (name, fn) => handlers.set(name, fn) }, filePath, fsImpl,
    getWindow: () => win, getOrigin: () => "http://127.0.0.1:4321" });
  return (operation, value, overrides = {}) => {
    const event = { sender: win.webContents, senderFrame: mainFrame, ...overrides };
    handlers.get(`inputPreferences:${operation}`)(event, value);
    return event.returnValue;
  };
}

describe("device input preferences", () => {
  it("survives a new process/session independently of the renderer origin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-input-prefs-"));
    try {
      const file = path.join(dir, "config", "input-preferences.json");
      const first = bridge(file);
      expect(first("read")).toEqual({ ok: true, value: null });
      expect(first("write", snapshot)).toEqual({ ok: true, value: snapshot });
      expect(bridge(file)("read")).toEqual({ ok: true, value: snapshot });
      expect(fs.readdirSync(path.dirname(file))).toEqual(["input-preferences.json"]);
      expect(first("write", JSON.stringify({ enterBehavior: "submit" }))).toEqual({ ok: false });
      expect(first("read").value).toBe(snapshot);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects foreign contents, subframes and foreign origins before touching storage", () => {
    const request = bridge("unused", { readFileSync: () => { throw new Error("must not read"); } });
    expect(request("read", null, { sender: {} })).toEqual({ ok: false });
    expect(request("write", snapshot, { senderFrame: { url: "https://foreign.test" } })).toEqual({ ok: false });
    expect(request("write", snapshot, { senderFrame: { url: "http://127.0.0.1:4321/dashboard" } })).toEqual({ ok: false });
  });

  it("reports atomic write failure without publishing an unpersisted snapshot", () => {
    const request = bridge("unused", {
      readFileSync: () => snapshot, mkdirSync() {}, writeFileSync() {},
      renameSync() { throw new Error("disk full"); }, rmSync() {},
    });
    expect(request("read").value).toBe(snapshot);
    expect(request("write", snapshot.replace('"next"', '"newline"'))).toEqual({ ok: false });
    expect(request("read").value).toBe(snapshot);
  });
});
