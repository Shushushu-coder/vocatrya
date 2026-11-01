import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { registerResumePreviewPreferencesIpc } = createRequire(import.meta.url)("./resume-preview-preferences.js");
const snapshot = JSON.stringify({ hidden: true, width: 1026 });

function bridge(filePath, fsImpl) {
  const handlers = new Map();
  const mainFrame = { url: "http://127.0.0.1:4321/dashboard" };
  const win = { isDestroyed: () => false, webContents: { mainFrame } };
  registerResumePreviewPreferencesIpc({ ipcMain: { on: (name, fn) => handlers.set(name, fn) }, filePath, fsImpl,
    getWindow: () => win, getOrigin: () => "http://127.0.0.1:4321" });
  return (operation, value, overrides = {}) => {
    const event = { sender: win.webContents, senderFrame: mainFrame, ...overrides };
    handlers.get(`resumePreviewPreferences:${operation}`)(event, value);
    return event.returnValue;
  };
}

describe("device resume preview preferences", () => {
  it("survives a new process/session independently of the renderer origin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-preview-prefs-"));
    try {
      const file = path.join(dir, "config", "resume-preview-preferences.json");
      const first = bridge(file);
      expect(first("read")).toEqual({ ok: true, value: null });
      expect(first("write", snapshot)).toEqual({ ok: true, value: snapshot });
      expect(bridge(file)("read")).toEqual({ ok: true, value: snapshot });
      expect(fs.readdirSync(path.dirname(file))).toEqual(["resume-preview-preferences.json"]);
      expect(first("write", JSON.stringify({ hidden: "yes", width: 1026 }))).toEqual({ ok: false });
      expect(first("read").value).toBe(snapshot);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects malformed snapshots before touching storage", () => {
    const request = bridge("unused", { readFileSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
    for (const bad of [
      "{not json",
      JSON.stringify({ hidden: true }),
      JSON.stringify({ hidden: true, width: "wide" }),
      JSON.stringify({ hidden: true, width: -1 }),
      JSON.stringify({ hidden: true, width: Number.POSITIVE_INFINITY }),
      JSON.stringify({ hidden: true, width: 480, extra: 1 }),
      JSON.stringify([true, 480]),
    ]) {
      expect(request("write", bad)).toEqual({ ok: false });
    }
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
    expect(request("write", snapshot.replace("1026", "480"))).toEqual({ ok: false });
    expect(request("read").value).toBe(snapshot);
  });
});
