// RESUME-BUILDER B7: device-local storage contract for the preview pane —
// defaults for empty or corrupt snapshots, per-key fallback on invalid
// values, web localStorage behavior and restart persistence across origins.
import { vi } from "vitest";

import {
  DEFAULT_RESUME_PREVIEW_PREFERENCES,
  RESUME_PREVIEW_MIN_WIDTH,
  RESUME_PREVIEW_STORAGE_KEY,
  readResumePreviewPreferences,
  writeResumePreviewPreferences,
} from "@/lib/resumePreviewPreferences";

const KEY = RESUME_PREVIEW_STORAGE_KEY;

describe("resume preview preferences storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("retains desktop preferences when a new loopback origin has empty localStorage", () => {
    let device: string | null = null;
    const bridge = {
      printToPDF: vi.fn(),
      readPreviewPreferences: () => device,
      writePreviewPreferences: (raw: string) => { device = raw; return raw; },
    };
    window.vocatryaResume = bridge;
    try {
      writeResumePreviewPreferences({ hidden: true, width: 1026 });
      // Simulate a relaunch on a different ephemeral port: the browser store
      // for the new origin is empty but the device file carries the snapshot.
      localStorage.clear();
      expect(readResumePreviewPreferences()).toEqual({ hidden: true, width: 1026 });
      const previous = device;
      bridge.writePreviewPreferences = () => { throw new Error("disk full"); };
      expect(() => writeResumePreviewPreferences({ hidden: false, width: 480 })).toThrow("disk full");
      expect(device).toBe(previous);
      expect(readResumePreviewPreferences()).toEqual({ hidden: true, width: 1026 });
    } finally { delete window.vocatryaResume; }
  });

  it("migrates a reachable browser snapshot into the desktop device store", () => {
    const raw = JSON.stringify({ ...DEFAULT_RESUME_PREVIEW_PREFERENCES, width: 640 });
    localStorage.setItem(KEY, raw);
    const write = vi.fn((value: string) => value);
    window.vocatryaResume = {
      printToPDF: vi.fn(),
      readPreviewPreferences: () => null,
      writePreviewPreferences: write,
    };
    try {
      expect(readResumePreviewPreferences().width).toBe(640);
      expect(write).toHaveBeenCalledWith(raw);
    } finally { delete window.vocatryaResume; }
  });

  it("returns the defaults when nothing is stored", () => {
    expect(readResumePreviewPreferences()).toEqual({ hidden: false, width: 480 });
  });

  it("falls back to defaults on a corrupt snapshot", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readResumePreviewPreferences()).toEqual(DEFAULT_RESUME_PREVIEW_PREFERENCES);
  });

  it("falls back per key on invalid values and keeps valid ones", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ hidden: "yes", width: RESUME_PREVIEW_MIN_WIDTH + 46 }),
    );
    expect(readResumePreviewPreferences()).toEqual({ hidden: false, width: 326 });
    localStorage.setItem(
      KEY,
      JSON.stringify({ hidden: true, width: Number.NaN }),
    );
    expect(readResumePreviewPreferences()).toEqual({ hidden: true, width: 480 });
    localStorage.setItem(KEY, JSON.stringify({ hidden: true, width: 40 }));
    expect(readResumePreviewPreferences()).toEqual({ hidden: true, width: 480 });
  });

  it("round-trips through localStorage on web and sanitizes before writing", () => {
    writeResumePreviewPreferences({ hidden: true, width: 1026 });
    expect(localStorage.getItem(KEY)).toBe('{"hidden":true,"width":1026}');
    expect(readResumePreviewPreferences()).toEqual({ hidden: true, width: 1026 });
    writeResumePreviewPreferences({ hidden: false, width: 10 });
    expect(readResumePreviewPreferences()).toEqual({ hidden: false, width: 480 });
  });
});
