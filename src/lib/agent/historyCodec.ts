import { gzipSync, gunzipSync } from "node:zlib";
const PREFIX = "vocatrya-chat-gzip-v1:";
const MAX_BYTES = 32 * 1024 * 1024;

/** Disk encoding only. Backups and all model/UI consumers receive original JSON. */
export function decodeHistory(raw: string): string {
  if (!raw.startsWith(PREFIX)) return raw;
  const text = gunzipSync(Buffer.from(raw.slice(PREFIX.length), "base64"), { maxOutputLength: MAX_BYTES }).toString("utf8");
  if (!Array.isArray(JSON.parse(text))) throw new Error("Invalid compressed conversation history");
  return text;
}
export function compressHistory(raw: string): string {
  if (raw.startsWith(PREFIX) || Buffer.byteLength(raw) > MAX_BYTES) return raw;
  if (!Array.isArray(JSON.parse(raw))) throw new Error("Invalid conversation history");
  const encoded = PREFIX + gzipSync(Buffer.from(raw), { level: 6 }).toString("base64");
  return Buffer.byteLength(encoded) < Buffer.byteLength(raw) ? encoded : raw;
}
