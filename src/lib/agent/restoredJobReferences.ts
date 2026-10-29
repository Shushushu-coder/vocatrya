// Restore provenance is separate from user-selected context and historical
// prose. It must survive context edits and subsequent backup/restore cycles.
export const RESTORED_JOB_REFERENCES = "restoredJobReferences";

export function restoredJobReferences(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? "null")?.[RESTORED_JOB_REFERENCES];
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function withRestoredJobReferences(
  raw: string | null | undefined,
  ids: readonly string[],
): string | null | undefined {
  if (ids.length === 0) return raw;
  const value: unknown = raw == null ? { version: 1, items: [] } : JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conversation context cannot retain restore references");
  }
  return JSON.stringify({
    ...value,
    [RESTORED_JOB_REFERENCES]: [...new Set(ids)],
  });
}
