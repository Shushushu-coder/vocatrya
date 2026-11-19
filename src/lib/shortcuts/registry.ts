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
  | "historyForward"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

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
  // Extra chords that match only while the stored combo is still the
  // default. A rebind replaces the whole set with the one recorded combo.
  defaultAliases?: readonly string[];
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
  // Page zoom. Mod+Equal is the unshifted "=+" key. Mod+Shift+Plus is that
  // same key with Shift held. Mod+Plus is the numpad plus. Aliases stay
  // live only while the stored combo is still Mod+Equal.
  zoomIn: {
    id: "zoomIn",
    scope: "desktopOnly",
    defaultCombo: "Mod+Equal",
    defaultAliases: ["Mod+Shift+Plus", "Mod+Plus"],
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: true,
  },
  zoomOut: {
    id: "zoomOut",
    scope: "desktopOnly",
    defaultCombo: "Mod+Minus",
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: true,
  },
  zoomReset: {
    id: "zoomReset",
    scope: "desktopOnly",
    defaultCombo: "Mod+0",
    rebindable: true,
    suppressInEditable: false,
    suppressWhileComposing: true,
  },
};

// Chords that currently fire this action. Aliases join only while the
// stored combo is still the shipped default.
export function matchingCombos(
  action: ShortcutAction,
  stored: string | null,
): string[] {
  if (!stored) return [];
  if (stored === action.defaultCombo && action.defaultAliases?.length) {
    return [stored, ...action.defaultAliases];
  }
  return [stored];
}

export const WINDOW_ACTION_IDS = [
  "toggleSidebar",
  "historyBack",
  "historyForward",
  "zoomIn",
  "zoomOut",
  "zoomReset",
] as const satisfies readonly WindowShortcutActionId[];
