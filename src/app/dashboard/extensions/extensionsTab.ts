// Shared by the server page (resolves ?tab= for deep links) and the client
// tabs. Kept out of the "use client" module so the server can call it.
export const EXTENSIONS_TAB_IDS = [
  "connections",
  "skills",
  "companion",
] as const;
export type ExtensionsTabId = (typeof EXTENSIONS_TAB_IDS)[number];

export function resolveExtensionsTab(
  raw: string | string[] | undefined,
): ExtensionsTabId {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (EXTENSIONS_TAB_IDS as readonly string[]).includes(value ?? "")
    ? (value as ExtensionsTabId)
    : "connections";
}
