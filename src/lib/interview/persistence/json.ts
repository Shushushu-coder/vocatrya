/**
 * Phase 3B — Frozen JSON helpers (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/validation/json.ts
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 *
 * IMPORT_REWRITE only. Snapshot/metadata payloads are stored opaquely
 * as JSON strings; the repository never inspects their internals.
 */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}
