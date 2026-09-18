import JSZip from "jszip";
import pkg from "../../../package.json";
import { APP_CONSTANTS } from "@/lib/constants";
import { preflightZip } from "@/lib/ai/import/extract-text";
import { modelsForBackup } from "./ordering";
import {
  BACKUP_FORMAT_VERSION,
  BackupError,
  ManifestSchema,
  SUPPORTED_BACKUP_FORMAT_VERSIONS,
  type BackupData,
  type BackupManifest,
} from "./schema";
import { normalizeManifest } from "./compat";

export { BackupError };

export function countRows(
  data: BackupData,
  options?: { includeSensitiveData?: boolean },
): Record<string, number> {
  const includeSensitiveData = options?.includeSensitiveData === true;
  const counts: Record<string, number> = {};
  for (const group of [
    ...modelsForBackup(includeSensitiveData),
    "_JobToTag",
    "_QuestionToTag",
  ] as const) {
    counts[group] = (data as unknown as Record<string, unknown[]>)[group].length;
  }
  return counts;
}

export function buildManifest(
  data: BackupData,
  sourceEmail: string,
  options?: { includeSensitiveData?: boolean },
): BackupManifest {
  const includeSensitiveData = options?.includeSensitiveData === true;
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appName: "Vocatrya",
    appVersion: pkg.version,
    exportedAt: new Date().toISOString(),
    sourceEmail,
    counts: countRows(data, { includeSensitiveData }),
    containsSensitiveData: includeSensitiveData,
  };
}

// Entry count and uncompressed size are read out of the zip's own central
// directory before JSZip parses anything and before a single byte is inflated
// — decompressing to measure is the zip bomb, not the guard. preflightZip is
// the same routine extractDocx already runs on untrusted .docx uploads; it is
// reused rather than reimplemented, and reusing it is what keeps this file off
// JSZip's private `_data.uncompressedSize`, which no public API exposes and a
// minor JSZip release could rename out from under a `?? 0`.
export async function openBackupZip(bytes: Buffer): Promise<JSZip> {
  let preflight: { entries: number; uncompressedBytes: number };
  try {
    preflight = preflightZip(bytes);
  } catch {
    throw new BackupError("That file is not a readable zip archive.");
  }

  if (preflight.entries > APP_CONSTANTS.BACKUP_MAX_ENTRIES) {
    throw new BackupError(
      `Backup has too many entries (${preflight.entries}); the limit is ${APP_CONSTANTS.BACKUP_MAX_ENTRIES}.`,
    );
  }

  if (preflight.uncompressedBytes > APP_CONSTANTS.BACKUP_MAX_UNCOMPRESSED_BYTES) {
    throw new BackupError(
      "Backup expands to more than the allowed uncompressed size.",
    );
  }

  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new BackupError("That file is not a readable zip archive.");
  }
}

export async function readManifest(zip: JSZip): Promise<BackupManifest> {
  const entry = zip.file("manifest.json");
  if (!entry) {
    throw new BackupError("Backup is missing manifest.json.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await entry.async("string"));
  } catch {
    throw new BackupError("manifest.json is not valid JSON.");
  }

  const found = (raw as { formatVersion?: unknown })?.formatVersion;
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    if (
      found !== undefined &&
      !SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(found as 1 | 2 | 3)
    ) {
      throw new BackupError(
        `This backup was made by a different version of Vocatrya. Expected format version 1, 2 or ${BACKUP_FORMAT_VERSION}, found ${String(found)}.`,
      );
    }
    throw new BackupError("manifest.json is missing required fields.");
  }
  return normalizeManifest(parsed.data);
}
