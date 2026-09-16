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
import { MoreVertical, Trash } from "lucide-react";
import { useState } from "react";
import { deleteActivityTypeById } from "@/actions/activity.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { AlertDialog } from "@/models/alertDialog.model";
import { useI18n } from "@/i18n";

type ActivityTypeRow = {
  id: string;
  label: string;
  value: string;
  totalDuration: number;
  _count?: { Activities?: number; Tasks?: number };
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

  const onDelete = (at: ActivityTypeRow) => {
    const activityCount = at._count?.Activities ?? 0;
    const taskCount = at._count?.Tasks ?? 0;

    if (activityCount > 0 || taskCount > 0) {
      const links = [
        activityCount > 0
          ? t(
              activityCount === 1
                ? "library.activityCountOne"
                : "library.activityCountMany",
              { count: activityCount },
            )
          : "",
        taskCount > 0
          ? t(taskCount === 1 ? "library.taskCountOne" : "library.taskCountMany", {
              count: taskCount,
            })
          : "",
      ]
        .filter(Boolean)
        .join(t("library.listSeparator"));

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

  const formatHours = (minutes: number) => {
    const hours = minutes / 60;
    return hours % 1 === 0 ? hours.toString() : hours.toFixed(1);
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
            <TableHead>{t("library.activitiesCount")}</TableHead>
            <TableHead>{t("library.tasksCount")}</TableHead>
            <TableHead>{t("library.totalHours")}</TableHead>
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
                {at._count?.Activities ?? 0}
              </TableCell>
              <TableCell className="font-medium">
                {at._count?.Tasks ?? 0}
              </TableCell>
              <TableCell className="font-medium">
                {t("common.hoursValue", {
                  count: formatHours(at.totalDuration),
                })}
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
