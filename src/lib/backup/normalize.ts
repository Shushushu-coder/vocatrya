import path from "path";
import { APP_CONSTANTS } from "@/lib/constants";
import { sniffFileType } from "@/lib/ai/import/extract-text";
import { calculateNextRunAt } from "@/lib/scraper/schedule";

const NON_TERMINAL_RUN_STATUSES = new Set(["running", "cancelling"]);

const IMPORT_MIME: Record<"pdf" | "docx", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Basename of the entry only, with both separators handled — a zip written on
// Windows carries backslashes that posix path.basename would keep.
export function isAbsoluteStorageKey(key: string): boolean {
  if (!key) return false;
  if (/^[a-zA-Z]:[\\/]/.test(key)) return true;
  if (key.startsWith("\\\\") || key.startsWith("//")) return true;
  if (key.startsWith("/") || key.startsWith("\\")) return true;
  return false;
}

// ResumeArtifact.storageKey is a relative/logical key. Restore never writes a
// source-machine absolute path; artifact bytes are not in the v2 zip.
export function logicalResumeArtifactStorageKey(
  artifactId: string,
  fileName: string,
): string {
  const base = safeEntryName(fileName);
  return `resume-artifacts/${artifactId}/${base}`;
}

export function safeEntryName(entryName: string): string {
  const flattened = entryName.replace(/\\/g, "/");
  const base = path.posix.basename(flattened);
  if (!base || base === "." || base === "..") return "file";
  return base;
}

// The column is always rebuilt server-side. The path in the backup is read only
// to locate the zip entry: UPLOADS_DIR differs between dev and prod, and the
// resume download route reads whatever path it is handed. The extension comes
// from the sniffed bytes rather than the carried name, so a payload cannot pick
// what lands in the uploads directory — resume.pdf.exe becomes <id>-resume.pdf.
export function importedFilePath(
  newFileId: string,
  entryName: string,
  kind: "pdf" | "docx",
): string {
  const base = safeEntryName(entryName).replace(/\.[^.]+$/, "");
  return path.join(
    APP_CONSTANTS.UPLOADS_DIR,
    "files",
    "resumes",
    `${newFileId}-${base}.${kind}`,
  );
}

// The same gate the upload route applies, on the same helper: size, then magic
// bytes. Returns null for anything that is not really a resume, so the caller
// can drop the bytes and keep going instead of failing the whole import. The
// mimeType is what File.fileType is set to — never the value in the payload.
export function checkImportedFile(
  bytes: Buffer,
): { kind: "pdf" | "docx"; mimeType: string } | null {
  if (bytes.length === 0 || bytes.length > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES) {
    return null;
  }
  const kind = sniffFileType(bytes);
  if (!kind) return null;
  return { kind, mimeType: IMPORT_MIME[kind] };
}

// A run restored as running or cancelling holds the single-active slot forever:
// runDueAutomations skips the automation and reapStaleRuns only reaps running.
export function normalizeAutomationRun<
  T extends { status: string; errorMessage: string | null; completedAt: Date | null },
>(row: T): T {
  if (!NON_TERMINAL_RUN_STATUSES.has(row.status)) return row;
  return {
    ...row,
    status: "failed",
    errorMessage: "interrupted",
    completedAt: new Date(),
  };
}

// Imported automations arrive with a nextRunAt in the past, so every one of
// them would fire on the next hourly tick. Recompute forward instead.
export function normalizeAutomation<
  T extends { status: string; scheduleHour: number; nextRunAt: Date | null },
>(row: T): T {
  if (row.status !== "active") return { ...row, nextRunAt: null };
  return { ...row, nextRunAt: calculateNextRunAt(row.scheduleHour) };
}

// A backup carries connection metadata only — credential and runtime login
// state never leave the source machine. A CONNECTED ACCOUNT_LOGIN row would
// therefore be a lie on the target: it claims a live login the restore does
// not have. Normalize it to REAUTH_REQUIRED so the user re-authenticates
// before the connection can serve traffic. Other statuses (DISCONNECTED,
// ERROR, already REAUTH_REQUIRED) describe connection state that survives
// the move and are kept verbatim.
export function normalizeAIConnection<
  T extends { authType: string; status: string },
>(row: T): T {
  if (row.authType !== "ACCOUNT_LOGIN" || row.status !== "CONNECTED") {
    return row;
  }
  return { ...row, status: "REAUTH_REQUIRED" };
}
