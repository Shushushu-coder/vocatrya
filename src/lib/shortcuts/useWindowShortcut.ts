"use client";

// Registry-driven window keydown listener. One hook instance binds one
// registry action to its effective (possibly user-rebound) combo, honoring
// the action's declared guards — editable-element suppression and IME
// composition — exactly as the pre-registry hard-coded listeners did.
// The handler decides whether to preventDefault, matching the original
// semantics where a no-op shortcut (e.g. back with empty history) left the
// event alone.

import { useEffect, useRef } from "react";
import { comboMatchesEvent } from "./combos";
import { SHORTCUT_ACTIONS, type WindowShortcutActionId } from "./registry";
import { useShortcutSnapshot } from "./bindings";
import { isDesktopShell } from "@/components/desktop/desktopShell";

export function useWindowShortcut(
  actionId: WindowShortcutActionId,
  handler: (event: KeyboardEvent) => void,
) {
  const combo = useShortcutSnapshot().window[actionId];
  const action = SHORTCUT_ACTIONS[actionId];
  const desktopOnly = action.scope === "desktopOnly";
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!combo) return;
    if (desktopOnly && !isDesktopShell()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (action.suppressWhileComposing && event.isComposing) return;
      if (action.suppressInEditable) {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('input, textarea, [contenteditable="true"]')) {
          return;
        }
      }
      if (!comboMatchesEvent(event, combo)) return;
      handlerRef.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [combo, desktopOnly, action]);
}
