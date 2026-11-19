// Canonical key-combination model shared by the window-level listeners,
// the settings editor, and (through IPC) the desktop main process, which
// keeps a mirror of the same grammar in desktop/main/keybindings.js.
//
// A canonical combo is `Modifier+Modifier+Key` joined by "+":
// - Modifiers are Mod, Alt, Shift. "Mod" is the platform primary modifier —
//   Ctrl on Windows/Linux, Cmd on macOS — which is exactly how the original
//   hard-coded Ctrl/Cmd+B listener behaved.
// - The key is a stable token: A-Z, 0-9, F1-F24, a named key (Left, Space,
//   Enter, ...) or a named punctuation token (Comma, Slash, ...) so the
//   "+" separator can never be ambiguous.
// - A "strong" modifier is required: every combo must contain Mod or Alt.
//   A bare key — or Shift alone with a printable key — would hijack
//   ordinary typing outside of text fields.
//
// Matching is exact-modifier: every recorded modifier flag must equal the
// event's (Mod ↔ ctrlKey||metaKey). An extra held modifier means no match,
// which is what makes rebinding and conflict detection meaningful.

const MODIFIER_TOKENS = ["Mod", "Alt", "Shift"] as const;
export type ShortcutModifier = (typeof MODIFIER_TOKENS)[number];

// event.key -> canonical token for keys that cannot represent themselves.
const NAMED_EVENT_KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
  Spacebar: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  Esc: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "+": "Plus",
  // Numpad plus reports "Add" on some platforms and "+" on others.
  Add: "Plus",
};

// Keys that are modifiers themselves — pressing one during capture means
// "still composing", never a completed combo.
const MODIFIER_EVENT_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "OS",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
]);

// Every key token a canonical combo may end with.
const KEY_TOKENS = new Set<string>([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.values(NAMED_EVENT_KEYS),
]);

export type ParsedCombo = {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

export function isModifierKey(eventKey: string | undefined): boolean {
  return Boolean(eventKey) && MODIFIER_EVENT_KEYS.has(eventKey as string);
}

// KeyboardEvent.key -> canonical key token, or null when the key is not
// bindable (shifted punctuation, IME output, unknown keys).
export function normalizeEventKey(eventKey: string | undefined): string | null {
  if (!eventKey) return null;
  if (/^[a-zA-Z]$/.test(eventKey)) return eventKey.toUpperCase();
  if (/^[0-9]$/.test(eventKey)) return eventKey;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(eventKey)) return eventKey;
  return NAMED_EVENT_KEYS[eventKey] ?? null;
}

export function parseCombo(combo: string | null | undefined): ParsedCombo | null {
  if (typeof combo !== "string" || !combo) return null;
  const parts = combo.split("+");
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  if (!KEY_TOKENS.has(key)) return null;
  const modifiers = parts.slice(0, -1);
  const seen = new Set<string>();
  for (const part of modifiers) {
    if (!MODIFIER_TOKENS.includes(part as ShortcutModifier) || seen.has(part)) {
      return null;
    }
    seen.add(part);
  }
  if (!seen.has("Mod") && !seen.has("Alt")) return null;
  return {
    mod: seen.has("Mod"),
    alt: seen.has("Alt"),
    shift: seen.has("Shift"),
    key,
  };
}

export function isValidCombo(combo: string | null | undefined): boolean {
  return parseCombo(combo) !== null;
}

// KeyboardEvent -> canonical combo, or null when the pressed key is not a
// bindable key. Modifiers come from the event flags so a pressed
// combination serializes the same way everywhere.
export function comboFromEvent(event: {
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = normalizeEventKey(event.key);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  const combo = parts.join("+");
  return isValidCombo(combo) ? combo : null;
}

export function comboMatchesEvent(
  event: {
    key?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  combo: string,
): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  return (
    parsed.mod === (event.ctrlKey || event.metaKey) &&
    parsed.alt === event.altKey &&
    parsed.shift === event.shiftKey &&
    normalizeEventKey(event.key) === parsed.key
  );
}

const DISPLAY_KEYS: Record<string, string> = {
  Mod: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Space: "Space",
  Esc: "Esc",
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
  Plus: "+",
};

// Canonical combo -> display labels, one entry per kbd chip.
export function comboToDisplayKeys(combo: string | null | undefined): string[] {
  const parsed = parseCombo(combo);
  if (!parsed) return [];
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.map((part) => DISPLAY_KEYS[part] ?? part);
}

// Canonical combo -> Electron accelerator. Only the "Mod" token and the
// named punctuation keys need translating; everything else already uses
// Electron's own key names (Left, Space, Enter, Esc, F1-F24, ...).
const ACCELERATOR_KEYS: Record<string, string> = {
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

export function comboToAccelerator(combo: string | null | undefined): string | null {
  const parsed = parseCombo(combo);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.mod) parts.push("CommandOrControl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(ACCELERATOR_KEYS[parsed.key] ?? parsed.key);
  return parts.join("+");
}
