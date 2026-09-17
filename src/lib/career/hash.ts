import { createHash } from "node:crypto";

/**
 * Stable JSON for hashing: object keys sorted, arrays keep caller order,
 * `null` is preserved, `undefined` is omitted (missing).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      const nested = rec[key];
      if (nested === undefined) continue;
      out[key] = canonicalizeValue(nested);
    }
    return out;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Utf8(canonicalize(value));
}
