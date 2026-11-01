"use client";

/**
 * RESUME-BUILDER: device-local preference for the resume preview pane
 * (hidden flag + width).
 *
 * - Storage: Electron keeps a validated snapshot in the app-owned device
 *   config file via `window.vocatryaResume` — independent of the backend's
 *   ephemeral loopback port. Web uses localStorage under the same key the
 *   pane always used. Each invalid or missing field falls back to its
 *   default on read.
 * - A reachable same-origin localStorage snapshot migrates into the device
 *   file once when the bridge is present; values stored under an older
 *   launch's port are not reachable and are not recovered.
 */
export type ResumePreviewPreferences = {
  hidden: boolean;
  width: number;
};

export const RESUME_PREVIEW_STORAGE_KEY = "vocatrya.resumePreview";
export const RESUME_PREVIEW_MIN_WIDTH = 280;

export const DEFAULT_RESUME_PREVIEW_PREFERENCES: ResumePreviewPreferences = {
  hidden: false,
  width: 480,
};

function sanitize(raw: unknown): ResumePreviewPreferences {
  const d = DEFAULT_RESUME_PREVIEW_PREFERENCES;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    hidden: typeof r.hidden === "boolean" ? r.hidden : d.hidden,
    width:
      typeof r.width === "number" && Number.isFinite(r.width) && r.width >= RESUME_PREVIEW_MIN_WIDTH
        ? r.width
        : d.width,
  };
}

function readRawResumePreviewPreferences(): string | null {
  if (typeof window === "undefined") return null;
  const bridge = window.vocatryaResume;
  if (typeof bridge?.readPreviewPreferences !== "function") {
    return localStorage.getItem(RESUME_PREVIEW_STORAGE_KEY);
  }
  const saved = bridge.readPreviewPreferences();
  if (saved !== null) return saved;
  // Migrate a currently reachable old snapshot once; future ports read the
  // device file. Sanitizing first also preserves per-key fallback behavior.
  const legacy = localStorage.getItem(RESUME_PREVIEW_STORAGE_KEY);
  if (!legacy) return null;
  return bridge.writePreviewPreferences(
    JSON.stringify(sanitize(JSON.parse(legacy))),
  );
}

export function readResumePreviewPreferences(): ResumePreviewPreferences {
  try {
    return sanitize(JSON.parse(readRawResumePreviewPreferences() ?? "null"));
  } catch {
    return { ...DEFAULT_RESUME_PREVIEW_PREFERENCES };
  }
}

/**
 * Persist the pane snapshot. The device file is authoritative on desktop —
 * browser storage is only a mirror there. Returns the stored preferences; a
 * storage failure is reported to the caller.
 */
export function writeResumePreviewPreferences(
  next: ResumePreviewPreferences,
): ResumePreviewPreferences {
  const value = sanitize(next);
  const raw = JSON.stringify(value);
  if (typeof window !== "undefined") {
    const write = window.vocatryaResume?.writePreviewPreferences;
    if (typeof write === "function") {
      write(raw);
      try { localStorage.setItem(RESUME_PREVIEW_STORAGE_KEY, raw); } catch { /* Device write succeeded. */ }
    } else {
      localStorage.setItem(RESUME_PREVIEW_STORAGE_KEY, raw);
    }
  }
  return value;
}
