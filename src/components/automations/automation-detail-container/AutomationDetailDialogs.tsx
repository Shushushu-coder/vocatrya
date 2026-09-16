"use client";

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
import { useI18n } from "@/i18n";

interface AutomationDetailDialogsProps {
  abortConfirmOpen: boolean;
  onAbortConfirmOpenChange: (open: boolean) => void;
  onAbortRun: () => void;
  deleteConfirmOpen: boolean;
  onDeleteConfirmOpenChange: (open: boolean) => void;
  onDelete: () => void;
  isDeleting: boolean;
}

export function AutomationDetailDialogs({
  abortConfirmOpen,
  onAbortConfirmOpenChange,
  onAbortRun,
  deleteConfirmOpen,
  onDeleteConfirmOpenChange,
  onDelete,
  isDeleting,
}: AutomationDetailDialogsProps) {
  const { t } = useI18n();
  return (
    <>
      <AlertDialog
        open={abortConfirmOpen}
        onOpenChange={onAbortConfirmOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("automations.abortThisRun")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.abortDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("automations.keepRunning")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={(e) => {
                e.preventDefault();
                onAbortRun();
              }}
            >
              {t("automations.abortRunConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={onDeleteConfirmOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("automations.deleteAutomation")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t("common.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
