"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useSaveStatus } from "@/context/SaveStatusContext";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

// Quiet autosave feedback rendered next to the editing surface that raised
// it — callers place it in their own header/toolbar row instead of a global
// window-spanning bar. Failures stay visible until the next save attempt;
// "saved" fades back out on its own.
export function SaveStatusIndicator({ className }: { className?: string }) {
  const { t } = useI18n();
  const { status } = useSaveStatus();

  if (status === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-state={status}
      className={cn(
        "pointer-events-none inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-xs shadow-sm",
        status === "error"
          ? "border-destructive/40 text-destructive"
          : "text-muted-foreground",
        className,
      )}
    >
      {status === "saving" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("common.saving")}
        </>
      ) : status === "saved" ? (
        <>
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />
          {t("common.saved")}
        </>
      ) : (
        <>
          <XCircle className="h-3.5 w-3.5" />
          {t("common.saveFailed")}
        </>
      )}
    </div>
  );
}
