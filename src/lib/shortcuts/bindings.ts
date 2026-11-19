"use client";

// Renderer-side keybinding state. The device-level store lives in the
// desktop main process (keybindings.json, read/written over the
// vocatryaDesktop bridge); outside the Electron shell there is no store,
// so the snapshot honestly reports the compiled-in defaults with
// bridgeAvailable=false — listeners still bind the defaults exactly like
// the pre-feature hard-coded keys did.

import { useSyncExternalStore } from "react";
import {
  matchingCombos,
  SHORTCUT_ACTIONS,
  WINDOW_ACTION_IDS,
  type ShortcutActionId,
  type WindowShortcutActionId,
} from "./registry";
import { isValidCombo } from "./combos";

export type WindowBindings = Record<WindowShortcutActionId, string | null>;

export type GlobalToggleState = {
  enabled: boolean;
  combo: string;
  // Live OS registration status reported by the main process.
  registered: boolean;
  // Last reported registration failure code ("occupied") or null.
  error: string | null;
};

export type ShortcutSnapshot = {
  // True once the bridge answered (or proved absent). Until then the
  // snapshot carries defaults — identical to the legacy hard-coded keys.
  loaded: boolean;
  bridgeAvailable: boolean;
  window: WindowBindings;
  global: GlobalToggleState;
};

export type ShortcutWriteResult = VocatryaShortcutWriteResult;

function defaultWindowBindings(): WindowBindings {
  const bindings = {} as WindowBindings;
  for (const id of WINDOW_ACTION_IDS) {
    bindings[id] = SHORTCUT_ACTIONS[id].defaultCombo;
  }
  return bindings;
}

const DEFAULT_SNAPSHOT: ShortcutSnapshot = {
  loaded: false,
  bridgeAvailable: false,
  window: defaultWindowBindings(),
  global: {
    enabled: false,
    combo: SHORTCUT_ACTIONS.toggleWindow.defaultCombo,
    registered: false,
    error: null,
  },
};

let snapshot: ShortcutSnapshot = DEFAULT_SNAPSHOT;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function sanitizeWindow(raw: unknown): WindowBindings {
  const bindings = defaultWindowBindings();
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const id of WINDOW_ACTION_IDS) {
      const value = record[id];
      if (value === null) bindings[id] = null;
      else if (typeof value === "string" && isValidCombo(value)) {
        bindings[id] = value;
      }
    }
  }
  return bindings;
}

function sanitizeGlobal(raw: unknown): GlobalToggleState {
  const base = DEFAULT_SNAPSHOT.global;
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    combo:
      typeof record.combo === "string" && isValidCombo(record.combo)
        ? record.combo
        : base.combo,
    registered: record.registered === true,
    error: typeof record.error === "string" ? record.error : null,
  };
}

function applyState(state: VocatryaShortcutState) {
  snapshot = {
    loaded: true,
    bridgeAvailable: true,
    window: sanitizeWindow(state.window),
    global: sanitizeGlobal(state.global),
  };
  emit();
}

function bridge(): VocatryaDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.vocatryaDesktop;
}

function ensureLoaded() {
  if (snapshot.loaded || loadPromise) return;
  const candidate = bridge();
  if (!candidate || typeof candidate.getShortcutState !== "function") {
    snapshot = { ...snapshot, loaded: true };
    emit();
    return;
  }
  loadPromise = candidate
    .getShortcutState()
    .then((state) => {
      if (state && typeof state === "object") applyState(state);
      else snapshot = { ...snapshot, loaded: true };
    })
    .catch(() => {
      // A failed read must not wedge the listeners: keep defaults.
      snapshot = { ...snapshot, loaded: true };
    })
    .finally(() => {
      loadPromise = null;
      emit();
    });
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  ensureLoaded();
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot(): ShortcutSnapshot {
  return DEFAULT_SNAPSHOT;
}

export function useShortcutSnapshot(): ShortcutSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function heldCombos(
  state: Pick<ShortcutSnapshot, "window" | "global">,
  actionId: ShortcutActionId,
): string[] {
  if (actionId === "toggleWindow") {
    return state.global.enabled ? [state.global.combo] : [];
  }
  return matchingCombos(SHORTCUT_ACTIONS[actionId], state.window[actionId]);
}

// Conflict check across every rebindable action: two live actions may
// never share a canonical combo. Cleared (null) bindings never conflict.
// Zoom-in's default aliases count as held by zoom-in until it is rebound.
export function findComboConflict(
  state: Pick<ShortcutSnapshot, "window" | "global">,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutActionId | null {
  const ids: ShortcutActionId[] = [...WINDOW_ACTION_IDS, "toggleWindow"];
  for (const id of ids) {
    if (id === actionId) continue;
    if (heldCombos(state, id).includes(combo)) return id;
  }
  return null;
}

export async function writeWindowBinding(
  action: WindowShortcutActionId,
  combo: string | null,
): Promise<ShortcutWriteResult> {
  const candidate = bridge();
  if (!candidate || typeof candidate.setWindowShortcut !== "function") {
    return { ok: false, code: "unsupported" };
  }
  const result = await candidate.setWindowShortcut({ action, combo });
  if (result && result.ok === true && result.state) {
    applyState(result.state);
    return { ok: true, state: result.state };
  }
  return result && result.ok === false
    ? result
    : { ok: false, code: "invalid" };
}

export async function writeGlobalToggle(input: {
  enabled?: boolean;
  combo?: string;
}): Promise<ShortcutWriteResult> {
  const candidate = bridge();
  if (!candidate || typeof candidate.setGlobalShortcut !== "function") {
    return { ok: false, code: "unsupported" };
  }
  // Drop undefined fields — a present-but-undefined key would fail the main
  // process's payload validation.
  const payload: { enabled?: boolean; combo?: string } = {};
  if (input.enabled !== undefined) payload.enabled = input.enabled;
  if (input.combo !== undefined) payload.combo = input.combo;
  const result = await candidate.setGlobalShortcut(payload);
  if (result && result.ok === true && result.state) {
    applyState(result.state);
    return { ok: true, state: result.state };
  }
  if (result && result.ok === false) {
    // A refused write may still carry the authoritative state (e.g. the
    // store after a rollback) — converge on it.
    if (result.state) applyState(result.state);
    return result;
  }
  return { ok: false, code: "invalid" };
}
