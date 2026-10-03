"use client";
import { useEffect } from "react";

export function ResumePrintReady({ versionId }: { versionId: string }) {
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      if (active && document.querySelector('[data-testid="resume-print-preview"]')) {
        document.documentElement.dataset.resumePrintReady = versionId;
      }
    });
    return () => {
      active = false;
      delete document.documentElement.dataset.resumePrintReady;
    };
  }, [versionId]);
  return null;
}
