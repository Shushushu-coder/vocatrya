"use client";
import { CirclePlay, MoreVertical, Trash } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { format } from "date-fns";
import { Activity, ActivityType } from "@/models/activity.model";
import { deleteActivityById } from "@/actions/activity.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { useMemo, useState } from "react";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { useI18n } from "@/i18n";

interface ActivitiesTableProps {
  activities: Activity[];
  reloadActivities: () => void;
  onStartActivity: (activityId: string) => void;
}

function ActivitiesTable({
  activities,
  reloadActivities,
  onStartActivity,
}: ActivitiesTableProps) {
  const { t, formatDate } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const [activityIdToDelete, setActivityIdToDelete] = useState<string>();
  const calculateDuration = (totalMinutes: number) => {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return totalMinutes === 0
      ? t("activities.durationZero")
      : t("activities.durationHoursMins", { hours, minutes });
  };

  const onDeleteActivity = useMemo(
    () => (id: string) => {
      setAlertOpen(true);
      setActivityIdToDelete(id);
    },
    [],
  );

  const deleteActivity = async () => {
    const { success, message } = await deleteActivityById(activityIdToDelete!);
    if (success) {
      toastSuccess(t("activities.activityDeleted"));
      reloadActivities();
    } else {
      toastError(message);
    }
  };
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden md:table-cell">
              {t("common.date")}
            </TableHead>
            <TableHead>{t("activities.activity")}</TableHead>
            <TableHead className="whitespace-nowrap">
              {t("activities.projectActivityType")}
              <br />
              {t("activities.activityTypeHint")}
            </TableHead>
            <TableHead className="hidden md:table-cell whitespace-nowrap">
              {t("common.startTime")}
            </TableHead>
            <TableHead className="hidden md:table-cell whitespace-nowrap">
              {t("common.endTime")}
            </TableHead>
            <TableHead>{t("activities.duration")}</TableHead>
            <TableHead>
              <span>{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activities?.map((activity: Activity) => {
            return (
              <TableRow
                key={activity.id}
                className="cursor-pointer group relative"
              >
                <TableCell className="hidden md:table-cell w-[120px]">
                  {activity.startTime
                    ? formatDate(activity.startTime)
                    : t("common.notAvailable")}
                </TableCell>
                <TableCell className="font-medium">
                  {activity.activityName}
                </TableCell>
                <TableCell className="font-medium">
                  {(activity.activityType as ActivityType)?.label}
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap">
                  {format(activity.startTime, "p")}
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap">
                  {format(activity.endTime!, "p")}
                </TableCell>
                <TableCell>
                  {activity.startTime &&
                    activity.endTime &&
                    calculateDuration(activity.duration ?? 0)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center flex-nowrap">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          aria-haspopup="true"
                          size="icon"
                          variant="ghost"
                        >
                          <MoreVertical className="h-4 w-4" />
                          <span className="sr-only">{t("common.toggleMenu")}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[200px]">
                        <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            className="cursor-pointer text-green-600"
                            onClick={() => onStartActivity(activity.id!)}
                          >
                            <CirclePlay className="mr-2 h-4 w-4" />
                            {t("activities.startActivity")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 cursor-pointer"
                            onClick={() => onDeleteActivity(activity.id!)}
                          >
                            <Trash className="mr-2 h-4 w-4" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      title={t("activities.startActivity")}
                      aria-haspopup="true"
                      size="icon"
                      variant="ghost"
                      onClick={() => onStartActivity(activity.id!)}
                      className="opacity-0 group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-300"
                    >
                      <span>
                        <CirclePlay className="text-green-600" />
                      </span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle={t("activities.activityNoun")}
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={deleteActivity}
      />
    </>
  );
}

export default ActivitiesTable;
