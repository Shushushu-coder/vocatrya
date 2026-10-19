import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const {
  DESKTOP_SETTINGS_DEFAULTS,
  DESKTOP_SETTINGS_FILE_NAME,
  createDesktopSettingsStore,
  sanitizeDesktopSettings,
} = createRequire(import.meta.url)("./desktop-settings.js");

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-settings-"));
  const filePath = path.join(root, "config", DESKTOP_SETTINGS_FILE_NAME);
  return { root, filePath, store: createDesktopSettingsStore({ filePath }) };
}

describe("desktop settings store", () => {
  it("returns compatible defaults when the file is missing", () => {
    const { root, store } = makeStore();
    expect(store.read()).toEqual({ closeToTray: false, startMinimized: false });
    expect(store.lastReadError).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists updates atomically and reads them back", () => {
    const { root, filePath, store } = makeStore();
    const next = store.update({ closeToTray: true });
    expect(next.closeToTray).toBe(true);
    expect(next.startMinimized).toBe(false);
    const fresh = createDesktopSettingsStore({ filePath });
    expect(fresh.read()).toEqual({ closeToTray: true, startMinimized: false });
    // The write is a rename of a complete document — no .tmp debris remains.
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([DESKTOP_SETTINGS_FILE_NAME]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges patches over stored values", () => {
    const { root, store } = makeStore();
    store.update({ closeToTray: true });
    const next = store.update({ startMinimized: true });
    expect(next).toEqual({ closeToTray: true, startMinimized: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown keys and non-boolean values without writing", () => {
    const { root, filePath, store } = makeStore();
    expect(() => store.update({ openAtLogin: true })).toThrow(/Unknown desktop setting/);
    expect(() => store.update({ closeToTray: "yes" })).toThrow(/must be a boolean/);
    expect(() => store.update(null)).toThrow(/must be an object/);
    expect(fs.existsSync(filePath)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to defaults on a corrupt file and recovers on next update", () => {
    const { root, filePath, store } = makeStore();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not json !!!", "utf8");
    expect(store.read()).toEqual({ ...DESKTOP_SETTINGS_DEFAULTS });
    expect(store.lastReadError).toBeTruthy();
    const next = store.update({ closeToTray: true });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(next);
    // The update's internal read still saw the corrupt file — the flag is
    // honest about the last read, and a fresh read clears it.
    expect(store.lastReadError).toBeTruthy();
    expect(store.read().closeToTray).toBe(true);
    expect(store.lastReadError).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ignores unknown fields and coerces missing fields to defaults", () => {
    expect(sanitizeDesktopSettings({ closeToTray: true, hacker: 1 })).toEqual({
      closeToTray: true,
      startMinimized: false,
    });
    expect(sanitizeDesktopSettings(null)).toEqual({ ...DESKTOP_SETTINGS_DEFAULTS });
    expect(sanitizeDesktopSettings({ closeToTray: "true" })).toEqual({
      ...DESKTOP_SETTINGS_DEFAULTS,
    });
  });

  it("surfaces write failures instead of pretending the setting landed", () => {
    const { root, filePath } = makeStore();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // A directory squatting on the file path makes the rename fail for real.
    fs.mkdirSync(filePath);
    const store = createDesktopSettingsStore({ filePath });
    expect(() => store.update({ closeToTray: true })).toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
