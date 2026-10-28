// OS-level global hotkey for the desktop shell: one action, "show or hide
// the main window", backed by Electron's globalShortcut and the device
// keybinding store.
//
// Semantics:
// - Window hidden, minimized, unfocused, or missing -> show + focus
//   (delegated to the lifecycle's showMainWindow, which also recreates a
//   destroyed window).
// - Window visible AND focused -> hide.
// - Disabled by default; nothing registers until the user opts in.
//
// Registration is honest: globalShortcut.register() returning false means
// the combo is owned by the OS or another app. Rebinding rolls back to the
// previously registered combo and reports the failure; a stored
// enabled-but-unregistrable intent is reported live via status() instead
// of being silently dropped.
"use strict";

const { isValidCombo } = require("./keybindings");

const GLOBAL_SHORTCUT_IPC_CHANNELS = Object.freeze({
  getState: "desktopShortcuts:getState",
  setWindowBinding: "desktopShortcuts:setWindowBinding",
  setGlobalToggle: "desktopShortcuts:setGlobalToggle",
});

// Canonical combo -> Electron accelerator. "Mod" is the platform primary
// modifier; the named punctuation tokens map to their literal keys.
const ACCELERATOR_KEY_TOKENS = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Plus: "Plus",
};

function comboToAccelerator(combo) {
  if (!isValidCombo(combo)) return null;
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((part) =>
    part === "Mod" ? "CommandOrControl" : part,
  );
  return [...modifiers, ACCELERATOR_KEY_TOKENS[key] ?? key].join("+");
}

function createGlobalToggleHotkey({
  globalShortcut,
  store,
  getWindow,
  showMainWindow,
  logger = console,
} = {}) {
  if (!globalShortcut) throw new Error("globalShortcut is required");
  if (!store) throw new Error("keybindings store is required");
  if (typeof showMainWindow !== "function") {
    throw new Error("showMainWindow is required");
  }
  const resolveWindow = typeof getWindow === "function" ? getWindow : () => undefined;

  // The accelerator this manager currently holds — the only one it may
  // unregister. Status is read back from globalShortcut.isRegistered, never
  // assumed from our own bookkeeping.
  let heldAccelerator = null;
  // Last registration failure observed while applying state ("occupied").
  let lastError = null;

  function liveWindow() {
    const win = resolveWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function toggle() {
    const win = liveWindow();
    if (win && win.isVisible() && win.isFocused()) {
      win.hide();
      return;
    }
    void showMainWindow();
  }

  function acceleratorFor(combo) {
    return comboToAccelerator(combo);
  }

  function releaseHeld() {
    if (!heldAccelerator) return;
    try {
      globalShortcut.unregister(heldAccelerator);
    } catch {
      // An unregister failure must not wedge a re-apply.
    }
    heldAccelerator = null;
  }

  // Register the stored combo when enabled. Returns the accelerator now
  // held, or null when disabled/failed — the caller reports via status().
  function apply() {
    const desired = store.read().globalToggleWindow;
    releaseHeld();
    lastError = null;
    if (!desired.enabled) return null;
    const accelerator = acceleratorFor(desired.combo);
    if (!accelerator) {
      lastError = "invalid";
      return null;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, toggle) === true;
    } catch (error) {
      logger.error("Global shortcut registration failed", error);
      ok = false;
    }
    if (!ok) {
      lastError = "occupied";
      return null;
    }
    heldAccelerator = accelerator;
    return accelerator;
  }

  function status() {
    const desired = store.read().globalToggleWindow;
    const accelerator = desired.enabled ? acceleratorFor(desired.combo) : null;
    let registered = false;
    if (accelerator && typeof globalShortcut.isRegistered === "function") {
      try {
        registered = globalShortcut.isRegistered(accelerator) === true;
      } catch {
        registered = false;
      }
    }
    return {
      enabled: desired.enabled,
      combo: desired.combo,
      registered,
      error: lastError,
    };
  }

  // Persist new intent and reconcile the OS registration. Rebind failure
  // while enabled rolls back to the previous combo — the last working
  // registration is restored and reported, never silently dropped. An
  // enable that fails to register keeps the persisted intent and is
  // reported through status().error instead.
  function setGlobalToggle(patch) {
    const previous = store.read().globalToggleWindow;
    const next = store.setGlobalToggle(patch);
    const desired = next.globalToggleWindow;
    apply();
    if (
      desired.enabled &&
      desired.combo !== previous.combo &&
      lastError === "occupied"
    ) {
      store.setGlobalToggle({ combo: previous.combo });
      apply();
      return { ok: false, code: "occupied" };
    }
    return { ok: true };
  }

  function dispose() {
    releaseHeld();
    try {
      globalShortcut.unregisterAll();
    } catch {
      // Teardown must never block an in-progress quit.
    }
  }

  return {
    apply,
    dispose,
    setGlobalToggle,
    status,
    toggle,
    get heldAccelerator() {
      return heldAccelerator;
    },
  };
}

module.exports = {
  GLOBAL_SHORTCUT_IPC_CHANNELS,
  comboToAccelerator,
  createGlobalToggleHotkey,
};
