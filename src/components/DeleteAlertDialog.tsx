import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { buttonVariants } from "./ui/button";
import { useI18n } from "@/i18n";

interface DeleteAlertDialogProps {
  pageTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  alertTitle?: string;
  alertDescription?: string;
  deleteAction?: boolean;
  actionLabel?: string;
  actionVariant?: "destructive" | "default";
}

export function DeleteAlertDialog({
  pageTitle,
  open,
  onOpenChange,
  onDelete,
  alertTitle,
  alertDescription,
  deleteAction = true,
  actionLabel,
  actionVariant = "destructive",
}: DeleteAlertDialogProps) {
  const { t } = useI18n();

  const title =
    alertTitle ??
    (t("common.confirmDeleteTitle") +
      (pageTitle ? ` (${pageTitle})` : ""));
  const description =
    alertDescription ?? t("common.confirmDeleteDescription");
  const confirmBtn = actionLabel ?? t("common.delete");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          {deleteAction && (
            <AlertDialogAction
              className={buttonVariants({ variant: actionVariant })}
              onClick={onDelete}
            >
              {confirmBtn}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
