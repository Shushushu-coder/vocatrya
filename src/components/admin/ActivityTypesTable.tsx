"use client";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { MoreVertical, Pencil, Trash } from "lucide-react";
import { useState } from "react";
import {
  deleteActivityTypeById,
  updateActivityType,
} from "@/actions/activity.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import { AlertDialog } from "@/models/alertDialog.model";
import { useI18n } from "@/i18n";

type ActivityTypeRow = {
  id: string;
  label: string;
  value: string;
  _count?: { Tasks?: number };
};

type ActivityTypesTableProps = {
  activityTypes: ActivityTypeRow[];
  reloadActivityTypes: () => void;
};

function ActivityTypesTable({
  activityTypes,
  reloadActivityTypes,
}: ActivityTypesTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });
  const [editTarget, setEditTarget] = useState<ActivityTypeRow | null>(null);

  const onDelete = (at: ActivityTypeRow) => {
    const taskCount = at._count?.Tasks ?? 0;

    if (taskCount > 0) {
      const links = t(
        taskCount === 1 ? "library.taskCountOne" : "library.taskCountMany",
        { count: taskCount },
      );

      setAlert({
        openState: true,
        title: t("library.itemInUseTitle", {
          item: t("library.activityTypeItem"),
        }),
        description: t("library.itemInUseDescription", {
          item: t("library.activityTypeItem"),
          links,
        }),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: at.id,
      });
    }
  };

  const deleteType = async (id: string | undefined) => {
    if (!id) return;
    const { success, message } = await deleteActivityTypeById(id);
    if (success) {
      toastSuccess(t("library.activityTypeDeleted"));
      reloadActivityTypes();
    } else {
      toastError(message);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.label")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("library.value")}
            </TableHead>
            <TableHead>{t("library.tasksCount")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activityTypes.map((at) => (
            <TableRow key={at.id}>
              <TableCell className="font-medium">{at.label}</TableCell>
              <TableCell className="font-medium hidden sm:table-cell">
                {at.value}
              </TableCell>
              <TableCell className="font-medium">
                {at._count?.Tasks ?? 0}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-haspopup="true" size="icon" variant="ghost">
                      <MoreVertical className="h-4 w-4" />
                      <span className="sr-only">{t("common.toggleMenu")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setEditTarget(at)}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      {t("common.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600 cursor-pointer"
                      onClick={() => onDelete(at)}
                    >
                      <Trash className="mr-2 h-4 w-4" />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DictionaryLabelDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        title={`${t("common.edit")} ${t("library.activityTypeItem")}`}
        fieldLabel={t("common.name")}
        initialLabel={editTarget?.label ?? ""}
        submit={(label) => updateActivityType(editTarget!.id, label)}
        onSaved={reloadActivityTypes}
      />
      <DeleteAlertDialog
        pageTitle="activity type"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteType(alert.itemId)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default ActivityTypesTable;
