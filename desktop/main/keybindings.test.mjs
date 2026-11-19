import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const {
  GLOBAL_TOGGLE_DEFAULT_COMBO,
  KEYBINDINGS_FILE_NAME,
  WINDOW_ACTION_IDS,
  WINDOW_BINDING_DEFAULTS,
  createKeybindingsStore,
  isValidCombo,
  sanitizeKeybindings,
} = createRequire(import.meta.url)("./keybindings.js");

const DEFAULT_STATE = {
  window: { ...WINDOW_BINDING_DEFAULTS },
  globalToggleWindow: { enabled: false, combo: GLOBAL_TOGGLE_DEFAULT_COMBO },
};

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-keybindings-"));
  const filePath = path.join(root, "config", KEYBINDINGS_FILE_NAME);
  return { root, filePath, store: createKeybindingsStore({ filePath }) };
}

describe("combo validation", () => {
  it("accepts canonical combos and rejects malformed ones", () => {
    expect(isValidCombo("Mod+B")).toBe(true);
    expect(isValidCombo("Alt+Left")).toBe(true);
    expect(isValidCombo("Mod+Alt+V")).toBe(true);
    expect(isValidCombo("Mod+Shift+F5")).toBe(true);
    expect(isValidCombo("Alt+Comma")).toBe(true);
    for (const bad of [
      "B",
      "Shift+B",
      "Ctrl+B",
      "Mod+",
      "Mod+Mod+B",
      "Mod+Unknown+B",
      "Mod+Hyper+B",
      "",
      null,
      42,
    ]) {
      expect(isValidCombo(bad)).toBe(false);
    }
  });
});

describe("keybindings store", () => {
  it("returns compatible defaults when the file is missing", () => {
    const { root, store } = makeStore();
    expect(store.read()).toEqual(DEFAULT_STATE);
    expect(store.lastReadError).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists a rebind atomically and reads it back in a fresh store", () => {
    const { root, filePath, store } = makeStore();
    const next = store.setWindowBinding("toggleSidebar", "Mod+Shift+B");
    expect(next.window.toggleSidebar).toBe("Mod+Shift+B");
    const fresh = createKeybindingsStore({ filePath });
    expect(fresh.read().window.toggleSidebar).toBe("Mod+Shift+B");
    // Atomic write leaves no temp debris.
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([
      KEYBINDINGS_FILE_NAME,
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps an explicit null (cleared binding) instead of resetting it", () => {
    const { root, filePath, store } = makeStore();
    store.setWindowBinding("historyBack", null);
    const fresh = createKeybindingsStore({ filePath });
    expect(fresh.read().window.historyBack).toBeNull();
    expect(fresh.read().window.historyForward).toBe("Alt+Right");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown actions, invalid combos, and non-object global patches", () => {
    const { root, filePath, store } = makeStore();
    expect(() => store.setWindowBinding("openDrawer", "Mod+D")).toThrow(
      /Unknown window shortcut action/,
    );
    expect(() => store.setWindowBinding("toggleSidebar", "B")).toThrow(
      /Invalid key combination/,
    );
    expect(() => store.setGlobalToggle(null)).toThrow(/must be an object/);
    expect(() => store.setGlobalToggle({ enabled: "yes" })).toThrow(
      /must be a boolean/,
    );
    expect(() => store.setGlobalToggle({ combo: "F5" })).toThrow(
      /not a valid combination/,
    );
    expect(fs.existsSync(filePath)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to defaults on a corrupt file and recovers on next write", () => {
    const { root, filePath, store } = makeStore();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ nope !!!", "utf8");
    expect(store.read()).toEqual(DEFAULT_STATE);
    expect(store.lastReadError).toBeTruthy();
    store.setWindowBinding("historyForward", "Alt+Right");
    expect(store.read().window.historyForward).toBe("Alt+Right");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("sanitize drops unknown keys, resets malformed combos, keeps null", () => {
    const state = sanitizeKeybindings({
      window: {
        toggleSidebar: "Alt+S",
        historyBack: null,
        historyForward: "not-a-combo",
        hacker: "Mod+X",
      },
      globalToggleWindow: { enabled: true, combo: "Mod+Shift+W", extra: 1 },
      unrelated: true,
    });
    expect(state).toEqual({
      window: {
        ...WINDOW_BINDING_DEFAULTS,
        toggleSidebar: "Alt+S",
        historyBack: null,
        historyForward: "Alt+Right",
      },
      globalToggleWindow: { enabled: true, combo: "Mod+Shift+W" },
    });
    expect(sanitizeKeybindings(null)).toEqual(DEFAULT_STATE);
    expect(sanitizeKeybindings("junk")).toEqual(DEFAULT_STATE);
  });

  it("covers every declared window action id", () => {
    expect(WINDOW_ACTION_IDS).toEqual([
      "toggleSidebar",
      "historyBack",
      "historyForward",
      "zoomIn",
      "zoomOut",
      "zoomReset",
    ]);
    for (const id of WINDOW_ACTION_IDS) {
      expect(typeof DEFAULT_STATE.window[id]).toBe("string");
    }
  });
});
