// Vocatrya desktop keybinding store — the device-level companion document
// to desktop-settings.json, kept in the same app-owned config directory.
// It persists the window-level rebindable combos plus the global
// show/hide hotkey intent (enabled flag + combo).
//
// Canonical combo grammar mirrors src/lib/shortcuts/combos.ts and must stay
// in sync with it (ids and defaults duplicated here on purpose): modifier
// tokens Mod/Alt/Shift, a named key token, at least one of Mod/Alt present.
// "Mod" maps to CommandOrControl when converted into an Electron
// accelerator; the conversion lives in global-shortcuts.js.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const KEYBINDINGS_FILE_NAME = "keybindings.json";

const WINDOW_ACTION_IDS = Object.freeze([
  "toggleSidebar",
  "historyBack",
  "historyForward",
  "zoomIn",
  "zoomOut",
  "zoomReset",
]);

// Live only while zoomIn is still stored as its default. A rebind replaces
// the whole match set with that one combo. Keep this list identical to
// SHORTCUT_ACTIONS.zoomIn.defaultAliases in src/lib/shortcuts/registry.ts.
const ZOOM_IN_DEFAULT = "Mod+Equal";
const ZOOM_IN_ALIASES = Object.freeze(["Mod+Shift+Plus", "Mod+Plus"]);

const GLOBAL_ACTION_ID = "toggleWindow";

// The same defaults the renderer registry ships — a corrupt or missing
// file must reproduce the pre-feature hard-coded behavior exactly.
const WINDOW_BINDING_DEFAULTS = Object.freeze({
  toggleSidebar: "Mod+B",
  historyBack: "Alt+Left",
  historyForward: "Alt+Right",
  zoomIn: ZOOM_IN_DEFAULT,
  zoomOut: "Mod+Minus",
  zoomReset: "Mod+0",
});

const GLOBAL_TOGGLE_DEFAULT_COMBO = "Mod+Alt+V";

const MODIFIER_TOKENS = new Set(["Mod", "Alt", "Shift"]);

const KEY_TOKENS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  "Left",
  "Right",
  "Up",
  "Down",
  "Space",
  "Tab",
  "Enter",
  "Esc",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Backquote",
  "Minus",
  "Equal",
  "Plus",
]);

// Canonical combo: Modifier+Modifier+Key. At least one strong modifier
// (Mod or Alt) so a bare key or Shift+printable can never hijack typing.
function isValidCombo(combo) {
  if (typeof combo !== "string" || !combo) return false;
  const parts = combo.split("+");
  if (parts.length < 2) return false;
  if (!KEY_TOKENS.has(parts[parts.length - 1])) return false;
  const seen = new Set();
  for (const part of parts.slice(0, -1)) {
    if (!MODIFIER_TOKENS.has(part) || seen.has(part)) return false;
    seen.add(part);
  }
  return seen.has("Mod") || seen.has("Alt");
}

// Combos that currently fire `actionId`, including zoom-in aliases while
// that action is still on its shipped default.
function heldCombos(state, actionId) {
  if (!isPlainObject(state)) return [];
  if (actionId === GLOBAL_ACTION_ID) {
    const global = state.globalToggleWindow;
    return isPlainObject(global) && global.enabled && typeof global.combo === "string"
      ? [global.combo]
      : [];
  }
  const combo = isPlainObject(state.window) ? state.window[actionId] : null;
  if (typeof combo !== "string" || !combo) return [];
  if (actionId === "zoomIn" && combo === ZOOM_IN_DEFAULT) {
    return [combo, ...ZOOM_IN_ALIASES];
  }
  return [combo];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultState() {
  return {
    window: { ...WINDOW_BINDING_DEFAULTS },
    globalToggleWindow: {
      enabled: false,
      combo: GLOBAL_TOGGLE_DEFAULT_COMBO,
    },
  };
}

// Reads never fail closed on a damaged file: unknown actions are dropped,
// malformed combos fall back to defaults, and an explicit null survives —
// null is a real state (the user cleared the binding), not corruption.
function sanitizeKeybindings(raw) {
  const state = defaultState();
  if (!isPlainObject(raw)) return state;
  if (isPlainObject(raw.window)) {
    for (const id of WINDOW_ACTION_IDS) {
      const value = raw.window[id];
      if (value === null) state.window[id] = null;
      else if (typeof value === "string" && isValidCombo(value)) {
        state.window[id] = value;
      }
    }
  }
  if (isPlainObject(raw.globalToggleWindow)) {
    const entry = raw.globalToggleWindow;
    if (typeof entry.enabled === "boolean") {
      state.globalToggleWindow.enabled = entry.enabled;
    }
    if (typeof entry.combo === "string" && isValidCombo(entry.combo)) {
      state.globalToggleWindow.combo = entry.combo;
    }
  }
  return state;
}

function createKeybindingsStore({ filePath, fsImpl = fs } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Keybindings file path is required");
  }
  let lastReadError = null;

  function read() {
    lastReadError = null;
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") lastReadError = error;
      return defaultState();
    }
    try {
      return sanitizeKeybindings(JSON.parse(raw));
    } catch (error) {
      lastReadError = error;
      return defaultState();
    }
  }

  // Validation happens here so every writer — IPC handler or future caller —
  // gets the same rules: window entries are a valid combo or null, the
  // global entry is {enabled, combo}.
  function validateWindowPatch(patch) {
    for (const key of Object.keys(patch)) {
      if (!WINDOW_ACTION_IDS.includes(key)) {
        throw new Error(`Unknown window shortcut action: ${key}`);
      }
      const value = patch[key];
      if (value !== null && !isValidCombo(value)) {
        throw new Error(`Invalid key combination for ${key}`);
      }
    }
  }

  function validateGlobalPatch(patch) {
    for (const key of Object.keys(patch)) {
      if (key === "enabled") {
        if (typeof patch.enabled !== "boolean") {
          throw new Error("globalToggleWindow.enabled must be a boolean");
        }
      } else if (key === "combo") {
        if (!isValidCombo(patch.combo)) {
          throw new Error("globalToggleWindow.combo is not a valid combination");
        }
      } else {
        throw new Error(`Unknown global hotkey setting: ${key}`);
      }
    }
  }

  // Atomic write: a full document lands in place via rename, so a crash mid
  // write can never leave a truncated file behind. Write failures propagate —
  // callers must surface them instead of pretending the binding took effect.
  function writeDocument(next) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try {
        fsImpl.rmSync(temporary, { force: true });
      } catch {
        // The temporary file may never have been created.
      }
      throw error;
    }
    return next;
  }

  function setWindowBinding(action, combo) {
    const patch = { [action]: combo };
    validateWindowPatch(patch);
    const next = read();
    next.window[action] = combo;
    return writeDocument(next);
  }

  function setGlobalToggle(patch) {
    if (!isPlainObject(patch)) {
      throw new Error("Global hotkey patch must be an object");
    }
    validateGlobalPatch(patch);
    const next = read();
    next.globalToggleWindow = { ...next.globalToggleWindow, ...patch };
    return writeDocument(next);
  }

  return {
    filePath,
    read,
    setWindowBinding,
    setGlobalToggle,
    get lastReadError() {
      return lastReadError;
    },
  };
}

module.exports = {
  GLOBAL_ACTION_ID,
  GLOBAL_TOGGLE_DEFAULT_COMBO,
  KEYBINDINGS_FILE_NAME,
  WINDOW_ACTION_IDS,
  WINDOW_BINDING_DEFAULTS,
  ZOOM_IN_ALIASES,
  ZOOM_IN_DEFAULT,
  createKeybindingsStore,
  heldCombos,
  isValidCombo,
  sanitizeKeybindings,
};
