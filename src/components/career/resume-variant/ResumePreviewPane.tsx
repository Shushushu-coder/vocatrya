"use client";
import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  DEFAULT_RESUME_PREVIEW_PREFERENCES,
  RESUME_PREVIEW_MIN_WIDTH as MIN_WIDTH,
  readResumePreviewPreferences,
  writeResumePreviewPreferences,
} from "@/lib/resumePreviewPreferences";
import "./ResumePreview.css";

export function ResumePreviewPane({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [restored, setRestored] = useState(false);
  const [hidden, setHidden] = useState(DEFAULT_RESUME_PREVIEW_PREFERENCES.hidden);
  const [width, setWidth] = useState(DEFAULT_RESUME_PREVIEW_PREFERENCES.width);
  useEffect(() => {
    const stored = readResumePreviewPreferences();
    setHidden(stored.hidden);
    setWidth(stored.width);
    // Persistence stays gated until the stored snapshot has been applied in a
    // committed render — the initial default render never reaches the store,
    // including under StrictMode's mount-effect replay.
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      writeResumePreviewPreferences({ hidden, width });
    } catch {
      // Persisting the pane preference is best-effort.
    }
  }, [restored, hidden, width]);
  if (hidden) {
    return (
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={() => setHidden(false)}>{t("resumeBuilder.showPreview")}</Button>
      </div>
    );
  }
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* Pointer capture is unavailable in some test renderers. */ }
    const move = (next: PointerEvent) => {
      if (!Number.isFinite(startX) || !Number.isFinite(next.clientX)) return;
      const limit = Math.round(window.innerWidth * 0.7);
      setWidth(Math.min(limit, Math.max(MIN_WIDTH, startWidth - (next.clientX - startX))));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <div className="resume-preview-pane flex w-full min-w-0 gap-2 lg:shrink-0" style={{ ["--resume-preview-width" as string]: `${width}px` }} data-testid="resume-preview-pane">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resumeBuilder.resizePreview")}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        className="hidden w-2 shrink-0 cursor-col-resize rounded bg-border lg:block"
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? 24 : -24;
          setWidth((current) => Math.min(Math.round(window.innerWidth * 0.7), Math.max(MIN_WIDTH, current + delta)));
        }}
      />
      <div className="min-w-0 flex-1 lg:sticky lg:top-4 lg:max-h-[85vh] lg:overflow-y-auto">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("resumeVariants.preview")}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setHidden(true)}>{t("resumeBuilder.hidePreview")}</Button>
        </div>
        {children}
      </div>
    </div>
  );
}
