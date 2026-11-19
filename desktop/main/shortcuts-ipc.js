// Renderer-facing IPC for the device keybinding store and the global
// show/hide hotkey. Same trust model as the lifecycle surface: every
// handler rejects senders that are not the main window's own main frame on
// the backend origin.
//
// Every write resolves to the authoritative snapshot the renderer should
// converge on — the persisted bindings plus the live OS registration
// status — or an { ok:false, code } refusal for expected user-facing
// failures (conflict, occupied accelerator, invalid payload).
"use strict";

const {
  GLOBAL_ACTION_ID,
  WINDOW_ACTION_IDS,
  heldCombos,
  isValidCombo,
} = require("./keybindings");
const { GLOBAL_SHORTCUT_IPC_CHANNELS } = require("./global-shortcuts");

function readWindowBindingPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Shortcut payload must be an object");
  }
  const { action, combo } = payload;
  if (!WINDOW_ACTION_IDS.includes(action)) {
    throw new Error(`Unknown window shortcut action: ${action}`);
  }
  if (combo !== null && !isValidCombo(combo)) {
    throw new Error("Invalid key combination");
  }
  return { action, combo };
}

function readGlobalTogglePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Global hotkey payload must be an object");
  }
  const patch = {};
  for (const key of Object.keys(payload)) {
    if (key === "enabled") {
      if (typeof payload.enabled !== "boolean") {
        throw new Error("Global hotkey enabled must be a boolean");
      }
      patch.enabled = payload.enabled;
    } else if (key === "combo") {
      if (!isValidCombo(payload.combo)) {
        throw new Error("Global hotkey combo is not a valid combination");
      }
      patch.combo = payload.combo;
    } else {
      throw new Error(`Unknown global hotkey field: ${key}`);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Global hotkey patch must not be empty");
  }
  return patch;
}

// Two live actions may never share a canonical combo. Returns the id of
// the action already holding `combo`, or null. The enabled global hotkey
// participates because a shared combo would double-fire while focused.
// Zoom-in's default aliases count as held until that action is rebound.
function findConflict(state, actionId, combo) {
  const ids = [...WINDOW_ACTION_IDS, GLOBAL_ACTION_ID];
  for (const id of ids) {
    if (id === actionId) continue;
    if (heldCombos(state, id).includes(combo)) return id;
  }
  return null;
}

function createShortcutsIpc({ store, hotkey } = {}) {
  if (!store) throw new Error("keybindings store is required");
  if (!hotkey) throw new Error("global hotkey manager is required");

  // The renderer-visible snapshot: persisted window bindings plus the
  // global toggle's intent and live registration status.
  function getState() {
    const stored = store.read();
    const status = hotkey.status();
    return {
      window: { ...stored.window },
      global: {
        enabled: status.enabled,
        combo: status.combo,
        registered: status.registered,
        error: status.error,
      },
    };
  }

  function setWindowBinding(payload) {
    const { action, combo } = readWindowBindingPayload(payload);
    if (combo !== null) {
      const conflicting = findConflict(store.read(), action, combo);
      if (conflicting) {
        return { ok: false, code: "conflict", conflictingAction: conflicting };
      }
    }
    store.setWindowBinding(action, combo);
    return { ok: true, state: getState() };
  }

  function setGlobalToggle(payload) {
    const patch = readGlobalTogglePayload(payload);
    const stored = store.read().globalToggleWindow;
    const enabled =
      typeof patch.enabled === "boolean" ? patch.enabled : stored.enabled;
    const combo =
      typeof patch.combo === "string" ? patch.combo : stored.combo;
    // A conflict only matters while the hotkey is live: enabling (or
    // rebinding under enabled) must not collide with a window binding.
    if (enabled) {
      const conflicting = findConflict(store.read(), GLOBAL_ACTION_ID, combo);
      if (conflicting) {
        return { ok: false, code: "conflict", conflictingAction: conflicting };
      }
    }
    const result = hotkey.setGlobalToggle(patch);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        state: getState(),
      };
    }
    return { ok: true, state: getState() };
  }

  return { getState, setGlobalToggle, setWindowBinding };
}

function registerShortcutsIpc(ipcMain, { store, hotkey, getWindow, getOrigin }) {
  const resolveWindow = typeof getWindow === "function" ? getWindow : () => undefined;
  const service = createShortcutsIpc({ store, hotkey });

  function assertTrustedSender(event) {
    const win = resolveWindow();
    const window = win && !win.isDestroyed() ? win : null;
    const origin = typeof getOrigin === "function" ? getOrigin() : getOrigin;
    if (!window || typeof origin !== "string" || !origin) {
      throw new Error("Untrusted shortcuts sender");
    }
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin
    ) {
      throw new Error("Untrusted shortcuts sender");
    }
  }

  const handlers = {
    [GLOBAL_SHORTCUT_IPC_CHANNELS.getState]: () => service.getState(),
    [GLOBAL_SHORTCUT_IPC_CHANNELS.setWindowBinding]: (_event, payload) =>
      service.setWindowBinding(payload),
    [GLOBAL_SHORTCUT_IPC_CHANNELS.setGlobalToggle]: (_event, payload) =>
      service.setGlobalToggle(payload),
    [GLOBAL_SHORTCUT_IPC_CHANNELS.suspend]: () => {
      hotkey.suspend();
    },
    [GLOBAL_SHORTCUT_IPC_CHANNELS.resume]: () => {
      hotkey.resume();
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload) => {
      assertTrustedSender(event);
      return handler(event, payload);
    });
  }
  return () => {
    for (const channel of Object.keys(handlers)) {
      ipcMain.removeHandler(channel);
    }
  };
}

module.exports = {
  createShortcutsIpc,
  findConflict,
  registerShortcutsIpc,
};
