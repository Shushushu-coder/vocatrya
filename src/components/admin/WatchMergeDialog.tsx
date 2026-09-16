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
import { PROVIDER_META } from "@/components/automations/ats-search-step/types";
import type { JobBoard } from "@/models/automation.model";
import { useI18n } from "@/i18n";

export type PendingMerge = {
  provider: JobBoard;
  board: { name: string; token: string; host?: "default" | "eu" };
  existing: { id: string; label: string };
};

type Props = {
  pending: PendingMerge | null;
  onConfirm: () => void;
  onCancel: () => void;
};

// There is no "create a separate entry" option: @@unique([value, createdBy])
// forbids a second row with the same canonical value.
export function WatchMergeDialog({ pending, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("automations.linkThisBoard")}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending
              ? t("companies.linkBoardDescription", {
                  name: pending.existing.label,
                  provider: PROVIDER_META[pending.provider].label,
                  token: pending.board.token,
                })
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Link board</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
