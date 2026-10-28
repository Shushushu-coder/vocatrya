"use client";

/**
 * SET-INPUT-PREFERENCES: device-local input preferences for structured
 * profile/material fields (wiki MVP_IMPLEMENTATION.md 试用新增需求 §4).
 *
 * - Storage: one JSON snapshot under APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY
 *   via the shared localstorage.utils helpers; each of the four keys falls back
 *   to its default when missing or invalid.
 * - Effect: `updateInputPreferences` writes and dispatches a same-tab event so
 *   mounted fields switch behavior without a restart; the `storage` event
 *   covers other tabs.
 * - Fields opt in with `data-input-pref-field` inside a `data-input-pref-region`
 *   container. Nothing is bound globally: Enter/Tab behavior lives on the wired
 *   inputs only, and the chain skips hidden/disabled/read-only controls.
 */
import * as React from "react";
import { useI18n } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";

export type EnterBehavior = "newline" | "next";
export type EditEntryStrategy = "click" | "end" | "select-all";
export type HintMode = "always" | "focus" | "off";

export type InputPreferences = {
  /** Enter inserts a newline (multiline) or keeps the field behavior. */
  enterBehavior: EnterBehavior;
  /** Selection applied when a field leaves display state for editing. */
  editEntry: EditEntryStrategy;
  /** Field-level shortcut hint visibility. */
  hintMode: HintMode;
  /** Focus the first editable field on an explicit continuous-edit entry. */
  autoFocus: boolean;
};

export const DEFAULT_INPUT_PREFERENCES: InputPreferences = {
  enterBehavior: "newline",
  editEntry: "click",
  hintMode: "focus",
  autoFocus: false,
};

const ENTER_BEHAVIORS: readonly EnterBehavior[] = ["newline", "next"];
const EDIT_ENTRIES: readonly EditEntryStrategy[] = [
  "click",
  "end",
  "select-all",
];
const HINT_MODES: readonly HintMode[] = ["always", "focus", "off"];

/** Same-tab invalidation channel; the native `storage` event covers others. */
export const INPUT_PREFERENCES_CHANGED_EVENT =
  "vocatrya:input-preferences-changed";

export const INPUT_PREF_REGION_ATTR = "data-input-pref-region";
export const INPUT_PREF_FIELD_ATTR = "data-input-pref-field";

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function readInputPreferences(): InputPreferences {
  try {
    const raw: unknown = getFromLocalStorage(
      APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY,
      null,
    );
    const d = DEFAULT_INPUT_PREFERENCES;
    if (typeof raw !== "object" || raw === null) return d;
    const r = raw as Record<string, unknown>;
    return {
      enterBehavior: pick(r.enterBehavior, ENTER_BEHAVIORS, d.enterBehavior),
      editEntry: pick(r.editEntry, EDIT_ENTRIES, d.editEntry),
      hintMode: pick(r.hintMode, HINT_MODES, d.hintMode),
      autoFocus: typeof r.autoFocus === "boolean" ? r.autoFocus : d.autoFocus,
    };
  } catch {
    return DEFAULT_INPUT_PREFERENCES;
  }
}

/**
 * Merge a patch into the stored snapshot and notify mounted fields. Returns
 * the persisted preferences; a storage failure is reported to the caller.
 */
export function updateInputPreferences(
  patch: Partial<InputPreferences>,
): InputPreferences {
  const next = { ...readInputPreferences(), ...patch };
  saveToLocalStorage(APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(INPUT_PREFERENCES_CHANGED_EVENT));
  }
  return next;
}

let cachedRaw: string | null | undefined;
let cachedSnapshot: InputPreferences = DEFAULT_INPUT_PREFERENCES;

// The stored JSON string keys the cache: a write or a cross-tab storage
// event changes it, while unchanged content reuses the snapshot so
// useSyncExternalStore never sees a fresh-but-equal object per read.
function getClientSnapshot(): InputPreferences {
  let raw: string | null;
  try {
    raw = localStorage.getItem(APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSnapshot = readInputPreferences();
  }
  return cachedSnapshot;
}

function subscribeInputPreferences(onChange: () => void) {
  window.addEventListener(INPUT_PREFERENCES_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(INPUT_PREFERENCES_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useInputPreferences(): InputPreferences {
  // SSR/hydration renders the shared defaults via getServerSnapshot; the
  // stored values apply right after hydration. A useState initializer would
  // read localStorage during hydration and mismatch the server-rendered
  // settings selects for anyone with non-default preferences.
  return React.useSyncExternalStore(
    subscribeInputPreferences,
    getClientSnapshot,
    () => DEFAULT_INPUT_PREFERENCES,
  );
}

/** IME composition in progress: Enter confirms candidates, never navigates. */
export function isImeKeyEvent(e: {
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return e.nativeEvent?.isComposing === true || e.keyCode === 229;
}

function isFieldVisible(el: HTMLElement): boolean {
  if (el.closest("[hidden]")) return false;
  // offsetParent is also null for fixed-position elements and in documents
  // without layout (jsdom) — walk ancestors so display/visibility still gate.
  let node: HTMLElement | null = el;
  while (node) {
    const style = window.getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    node = node.parentElement;
  }
  return true;
}

function isEligibleField(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const control = el as HTMLInputElement | HTMLTextAreaElement;
  if (control.disabled || control.readOnly) return false;
  // Hidden fields (collapsed cards, inactive force-mounted tabs) are skipped.
  return isFieldVisible(el);
}

export function listRegionFields(
  region: Element | null | undefined,
): HTMLElement[] {
  if (!region) return [];
  return Array.from(
    region.querySelectorAll(`[${INPUT_PREF_FIELD_ATTR}]`),
  ).filter(isEligibleField);
}

function regionOf(el: HTMLElement): Element | null {
  return el.closest(`[${INPUT_PREF_REGION_ATTR}]`);
}

export function isLastRegionField(el: HTMLElement): boolean {
  const fields = listRegionFields(regionOf(el));
  return fields.length > 0 && fields[fields.length - 1] === el;
}

export function focusRegionField(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/**
 * Move focus to the next eligible field in the same region. Returns true when
 * focus moved; false means `current` was already the last field.
 */
export function focusNextRegionField(current: HTMLElement): boolean {
  const fields = listRegionFields(regionOf(current));
  const index = fields.indexOf(current);
  const next = index >= 0 ? fields[index + 1] : undefined;
  if (!next) return false;
  focusRegionField(next);
  return true;
}

/**
 * Focus the first eligible field of a region after an explicit user entry
 * (auto-focus preference). Coarse-pointer devices keep their native behavior
 * so a virtual keyboard is never forced open.
 */
export function focusFirstRegionField(
  region: Element | null | undefined,
): boolean {
  if (typeof window === "undefined" || !region) return false;
  if (window.matchMedia?.("(pointer: coarse)").matches) return false;
  const first = listRegionFields(region)[0];
  if (!first) return false;
  focusRegionField(first);
  return true;
}

type SelectableField = HTMLInputElement | HTMLTextAreaElement;

function selectionSupported(el: HTMLElement): el is SelectableField {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  // setSelectionRange throws on types without selectable text (date, checkbox…).
  return ["text", "search", "url", "tel", "password", "email", "number", ""].includes(
    el.type,
  );
}

function applyEntryStrategy(
  el: HTMLElement,
  strategy: EditEntryStrategy,
  viaPointer: boolean,
) {
  if (!selectionSupported(el)) return;
  if (strategy === "click" && viaPointer) return;
  const apply = () => {
    // A deliberate drag-selection made on entry is the user's edit start —
    // the strategy only applies while entering edit, never over a choice.
    if (viaPointer && el.selectionStart !== el.selectionEnd) return;
    const end = el.value.length;
    try {
      if (strategy === "select-all") el.setSelectionRange(0, end);
      else el.setSelectionRange(end, end);
    } catch {
      // Some controls reject programmatic selection; entry still works.
    }
  };
  if (viaPointer) {
    // The click positions the caret on mouseup — after focus — so the
    // override is deferred past click processing.
    const defer =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn: () => void) => setTimeout(fn, 0);
    defer(apply);
  } else {
    // Keyboard/programmatic entry has no click position: the spec default is
    // text end for "click", and end/select-all for the explicit strategies.
    apply();
  }
}

export type StructuredFieldOptions = {
  /** True for multi-line editors (Shift+Enter inserts a newline). */
  multiline?: boolean;
  /**
   * Optional leave gate for Enter→next: return false to keep focus (e.g. a
   * required field left empty). Called synchronously per keypress.
   */
  canLeave?: () => boolean;
  /** Runs when canLeave() blocked a jump (surface the field-level error). */
  onLeaveBlocked?: () => void;
};

export type StructuredFieldBind = {
  "data-input-pref-field": true;
  ref: (el: HTMLElement | null) => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLElement>) => void;
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => boolean;
};

/**
 * Shared keyboard/entry behavior for one opted-in field. Callers either spread
 * `bind` onto the control or invoke its handlers from their own (autosave
 * fields compose the IME guard and their blur commit). `hint` carries the
 * preference-aware hint text plus its visibility state.
 */
export function useStructuredField({
  multiline = false,
  canLeave,
  onLeaveBlocked,
}: StructuredFieldOptions = {}) {
  const { t } = useI18n();
  const prefs = useInputPreferences();
  const [focused, setFocused] = React.useState(false);
  const [isLast, setIsLast] = React.useState(false);
  const elRef = React.useRef<HTMLElement | null>(null);
  const pointerRef = React.useRef(false);
  const canLeaveRef = React.useRef(canLeave);
  const onLeaveBlockedRef = React.useRef(onLeaveBlocked);
  React.useEffect(() => {
    canLeaveRef.current = canLeave;
    onLeaveBlockedRef.current = onLeaveBlocked;
  });

  const setEl = React.useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const refreshIsLast = React.useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    setIsLast(isLastRegionField(el));
  }, []);

  // "Always" hints and the last-field wording track live DOM order, so the
  // position is re-measured after every committed render.
  React.useEffect(() => {
    if (prefs.hintMode === "always" || focused) refreshIsLast();
  });

  const onFocus = React.useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const el = e.currentTarget;
      elRef.current = el;
      applyEntryStrategy(el, prefs.editEntry, pointerRef.current);
      pointerRef.current = false;
      setFocused(true);
      setIsLast(isLastRegionField(el));
    },
    [prefs.editEntry],
  );

  const onBlur = React.useCallback(() => {
    setFocused(false);
    pointerRef.current = false;
  }, []);

  const onMouseDown = React.useCallback(() => {
    pointerRef.current = true;
  }, []);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLElement>): boolean => {
      if (e.key !== "Enter" || e.shiftKey) return false;
      if (isImeKeyEvent(e)) return false;
      if (prefs.enterBehavior !== "next") return false;
      const el = e.currentTarget as HTMLElement;
      if (canLeaveRef.current && !canLeaveRef.current()) {
        e.preventDefault();
        onLeaveBlockedRef.current?.();
        return true;
      }
      e.preventDefault();
      // Focusing the next field blurs this one, so the per-field autosave
      // commit still runs; on the last field Enter just ends the edit.
      if (!focusNextRegionField(el)) el.blur();
      return true;
    },
    [prefs.enterBehavior],
  );

  const hintText = React.useMemo(() => {
    const parts: string[] = [];
    if (prefs.enterBehavior === "next") {
      parts.push(
        t(isLast ? "inputPrefs.hintEnterFinish" : "inputPrefs.hintEnterNext"),
      );
      if (multiline) parts.push(t("inputPrefs.hintShiftEnterNewline"));
    } else {
      if (multiline) parts.push(t("inputPrefs.hintEnterNewline"));
      parts.push(t("inputPrefs.hintTabNext"));
    }
    return parts.join(" · ");
  }, [prefs.enterBehavior, isLast, multiline, t]);

  const hintVisible = prefs.hintMode === "always" || (prefs.hintMode === "focus" && focused);

  return {
    bind: {
      [INPUT_PREF_FIELD_ATTR]: true,
      ref: setEl,
      onFocus,
      onBlur,
      onMouseDown,
      onKeyDown,
    } as StructuredFieldBind,
    hint: { visible: hintVisible, text: hintText },
    prefs,
  };
}
