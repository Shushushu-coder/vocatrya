"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { toastSuccess, toastError } from "@/lib/toast";
import { clearDiscoveredJobs } from "@/actions/automation.actions";
import { useI18n } from "@/i18n";

interface ClearJobsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  includeNew: boolean;
  onIncludeNewChange: (includeNew: boolean) => void;
  newCount: number;
  automationId: string;
  onRefresh: () => void;
}

export function ClearJobsDialog({
  open,
  onOpenChange,
  includeNew,
  onIncludeNewChange,
  newCount,
  automationId,
  onRefresh,
}: ClearJobsDialogProps) {
  const { t } = useI18n();
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    const result = await clearDiscoveredJobs({
      automationId,
      includeNew,
    });
    setClearing(false);
    onOpenChange(false);

    if (result.success) {
      toastSuccess(
        t("automations.removedJobs", { count: result.deleted ?? 0 }),
        t("automations.discoveredJobsCleared"),
      );
      onRefresh();
    } else {
      toastError(result.message);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("automations.clearDiscoveredJobs")}</AlertDialogTitle>
          <AlertDialogDescription>
            {includeNew && newCount > 0
              ? t("automations.clearJobsDescriptionWithNew")
              : t("automations.clearJobsDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {newCount > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={includeNew}
              onChange={(e) => onIncludeNewChange(e.target.checked)}
            />
            {t("automations.alsoDeleteNew", { count: newCount })}
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearing}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={clearing}
            onClick={(e) => {
              e.preventDefault();
              handleClear();
            }}
          >
            {clearing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("common.delete")
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
