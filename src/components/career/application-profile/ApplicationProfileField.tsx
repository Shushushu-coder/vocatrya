"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";

type ApplicationProfileFieldProps = {
  label: string;
  value?: string | null;
  emptyText?: string;
  helper?: string;
  onCopyValue?: () => Promise<string | null>;
  revealSlot?: React.ReactNode;
  editSlot?: React.ReactNode;
  testId?: string;
};

export function ApplicationProfileField({
  label,
  value,
  emptyText,
  helper,
  onCopyValue,
  revealSlot,
  editSlot,
  testId,
}: ApplicationProfileFieldProps) {
  const { t } = useI18n();
  const [copying, setCopying] = useState(false);
  const trimmed = value?.trim() ?? "";
  const isEmpty = trimmed.length === 0;

  async function handleCopy() {
    const text = onCopyValue ? await onCopyValue() : trimmed;
    const copyText = (text ?? "").trim();
    if (!copyText) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(copyText);
      toastSuccess(t("common.copied"));
    } catch {
      toastError(t("applicationProfile.copyFailed"));
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 py-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-1">
          {revealSlot}
          {!isEmpty && (
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleCopy} disabled={copying}>
              {t("common.copy")}
            </Button>
          )}
          {editSlot}
        </div>
      </div>
      <div className="text-sm text-foreground">
        {isEmpty ? (
          <span className="text-muted-foreground">{emptyText ?? t("applicationProfile.emptyValue")}</span>
        ) : (
          <span>{trimmed}</span>
        )}
      </div>
      {helper && <div className="text-xs text-muted-foreground">{helper}</div>}
    </div>
  );
}
