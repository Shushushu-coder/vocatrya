// Unified shortcut registry: every bindable action declares its identity,
// scope, default combo, and the guards its listener applies. The persisted
// store (desktop/main/keybindings.js) mirrors the window-action ids and
// defaults declared here — keep the two in sync.
//
// Scopes:
// - "window": a keydown listener on the app window; works in any host.
// - "desktopOnly": a window listener that only makes sense inside the
//   Electron shell (history navigation needs window.navigation).
// - "global": an OS-level globalShortcut registered by the main process —
//   it fires even while the window is hidden or unfocused.
export type ShortcutScope = "window" | "desktopOnly" | "global";

export type WindowShortcutActionId =
  | "toggleSidebar"
  | "historyBack"
  | "historyForward";

export type ShortcutActionId = WindowShortcutActionId | "toggleWindow";

export type ShortcutAction = {
  id: ShortcutActionId;
  scope: ShortcutScope;
  // Canonical combo (see combos.ts); the value the store falls back to.
  defaultCombo: string;
  rebindable: boolean;
  // Listener guards copied 1:1 from the pre-registry handlers:
  // toggleSidebar stayed out of editable elements; the history keys only
  // checked isComposing. Both are per-action so a rebound combo keeps the
  // same target semantics.
  suppressInEditable: boolean;
  suppressWhileComposing: boolean;
};

export const SHORTCUT_ACTIONS: Record<ShortcutActionId, ShortcutAction> = {
  toggleSidebar: {
    id: "toggleSidebar",
    scope: "window",
    defaultCombo: "Mod+B",
    rebindable: true,
    suppressInEditable: true,
    suppressWhileComposing: false,
  },
  historyBack: {
    id: "historyBack",
    scope: "desktopOnly",
    defaultCombo: "Alt+Left",
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: true,
  },
  historyForward: {
    id: "historyForward",
    scope: "desktopOnly",
    defaultCombo: "Alt+Right",
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: true,
  },
  toggleWindow: {
    id: "toggleWindow",
    scope: "global",
    defaultCombo: "Mod+Alt+V",
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: false,
  },
};

export const WINDOW_ACTION_IDS = [
  "toggleSidebar",
  "historyBack",
  "historyForward",
] as const satisfies readonly WindowShortcutActionId[];
