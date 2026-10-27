"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  MoreVertical,
  Pencil,
  Tags,
  Trash,
  CirclePlay,
  Check,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Flame,
  AlignLeft,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { StatusBadge } from "../StatusBadge";
import { TASK_STATUS_BADGE_COLORS } from "@/lib/badge-colors";
import { format, isToday, parse } from "date-fns";
import { runtimeTimeZone } from "@/lib/datetime";
import {
  formatTaskDue,
  taskDueDateGroup,
  type TaskDueDateGroup,
} from "@/lib/tasks/dueTime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { useState } from "react";
import {
  Task,
  TASK_STATUSES,
  TaskGroupBy,
  TaskStatus,
} from "@/models/task.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { getDescriptionExcerpt, hasDescription } from "@/lib/tasks/description";
import { useI18n, getLocalizedTaskStatus } from "@/i18n";

type TasksTableProps = {
  tasks: Task[];
  deleteTask: (id: string) => void;
  editTask: (id: string) => void;
  onChangeTaskStatus: (id: string, status: TaskStatus) => void;
  onStartActivity: (id: string) => void;
  groupBy?: TaskGroupBy;
  timeZone?: string;
};

type PriorityLevel = "low" | "medium" | "high" | "critical";

function getPriorityLevel(priority: number): PriorityLevel {
  if (priority <= 3) return "low";
  if (priority <= 6) return "medium";
  if (priority <= 8) return "high";
  return "critical";
}

const priorityConfig: Record<
  PriorityLevel,
  { icon: React.ElementType; color: string; label: string }
> = {
  low: {
    icon: ArrowDown,
    color: "text-green-600 bg-green-100 dark:bg-green-900/30",
    label: "Low",
  },
  medium: {
    icon: ArrowRight,
    color: "text-cyan-600 bg-cyan-100 dark:bg-cyan-900/30",
    label: "Medium",
  },
  high: {
    icon: ArrowUp,
    color: "text-orange-600 bg-orange-100 dark:bg-orange-900/30",
    label: "High",
  },
  critical: {
    icon: Flame,
    color: "text-red-600 bg-red-100 dark:bg-red-900/30",
    label: "Critical",
  },
};

type DateGroup = TaskDueDateGroup;

type CreatedDateGroup = string; // Format: "YYYY-MM-DD"
type UpdatedDateGroup = string; // Format: "YYYY-MM-DD"

function groupTasksByDate(
  tasks: Task[],
  timeZone: string,
): Record<DateGroup, Task[]> {
  const groups: Record<DateGroup, Task[]> = {
    Overdue: [],
    Today: [],
    Tomorrow: [],
    "This Week": [],
    Later: [],
    "No Due Date": [],
  };

  tasks.forEach((task) => {
    const group = taskDueDateGroup(task, timeZone);
    groups[group].push(task);
  });

  return groups;
}

function groupTasksByActivityType(tasks: Task[]): Record<string, Task[]> {
  const groups: Record<string, Task[]> = {};

  tasks.forEach((task) => {
    const key = task.activityType?.label || "No Activity Type";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(task);
  });

  return groups;
}

function groupTasksByCreatedDate(
  tasks: Task[],
): Record<CreatedDateGroup, Task[]> {
  const groups: Record<CreatedDateGroup, Task[]> = {};

  tasks.forEach((task) => {
    const dateStr = format(new Date(task.createdAt), "yyyy-MM-dd");
    const key = dateStr;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(task);
  });

  return groups;
}

function groupTasksByUpdatedDate(
  tasks: Task[],
): Record<UpdatedDateGroup, Task[]> {
  const groups: Record<UpdatedDateGroup, Task[]> = {};

  tasks.forEach((task) => {
    const dateStr = format(new Date(task.updatedAt), "yyyy-MM-dd");
    const key = dateStr;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(task);
  });

  return groups;
}

function TasksTable({
  tasks,
  deleteTask,
  editTask,
  onChangeTaskStatus,
  onStartActivity,
  groupBy = "none",
  timeZone = runtimeTimeZone(),
}: TasksTableProps) {
  const { t, formatDate, locale } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const dateGroupLabels: Record<DateGroup, string> = {
    Overdue: t("tasks.overdue"),
    Today: t("common.today"),
    Tomorrow: t("common.tomorrow"),
    "This Week": t("tasks.thisWeek"),
    Later: t("tasks.later"),
    "No Due Date": t("tasks.noDueDate"),
  };
  const [taskIdToDelete, setTaskIdToDelete] = useState("");

  const onDeleteTask = (taskId: string) => {
    setAlertOpen(true);
    setTaskIdToDelete(taskId);
  };

  const renderTaskRow = (task: Task) => (
    <TableRow
      key={task.id}
      className={cn(
        "group relative h-9",
        task.status === "complete" && "opacity-60",
      )}
    >
      <TableCell className="w-[24px] py-1 pl-1 pr-1">
        <button
          onClick={() =>
            onChangeTaskStatus(
              task.id,
              task.status === "complete" ? "in-progress" : "complete",
            )
          }
          className={cn(
            "h-5 w-5 rounded-sm border flex items-center justify-center transition-colors",
            task.status === "complete"
              ? "bg-green-500 border-green-500 text-white"
              : "border-gray-300 hover:border-gray-400",
          )}
          aria-label={
            task.status === "complete"
              ? t("tasks.markAsInProgress")
              : t("tasks.markAsComplete")
          }
        >
          {task.status === "complete" && <Check className="h-3 w-3" />}
        </button>
      </TableCell>
      <TableCell
        className={cn(
          "py-1 px-2 font-medium",
          task.status === "complete" && "line-through",
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={() => editTask(task.id)}
            className="text-left hover:underline cursor-pointer"
            aria-label={`Edit ${task.title}`}
          >
            {task.title}
          </button>
          {hasDescription(task.description) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlignLeft
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label={t("tasks.hasDescription")}
                  data-testid="task-description-indicator"
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs">
                {getDescriptionExcerpt(task.description)}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </TableCell>
      <TableCell className="py-1 px-2">
        {task.activityType?.label || "—"}
      </TableCell>
      <TableCell className="hidden lg:table-cell py-1 px-2 whitespace-nowrap">
        {(() => {
          try {
            return formatTaskDue(task, locale, timeZone) ?? "—";
          } catch {
            return "—";
          }
        })()}
      </TableCell>
      <TableCell className="hidden md:table-cell py-1 px-2">
        <StatusBadge
          label={getLocalizedTaskStatus(task.status, t)}
          color={TASK_STATUS_BADGE_COLORS[task.status]}
          className="w-[110px] whitespace-nowrap justify-center"
        />
      </TableCell>
      <TableCell className="hidden md:table-cell py-1 px-2">
        {(() => {
          const level = getPriorityLevel(task.priority);
          const config = priorityConfig[level];
          const Icon = config.icon;
          return (
            <div
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                config.color,
              )}
            >
              <Icon className="h-3 w-3" />
              <span>{task.priority}</span>
            </div>
          );
        })()}
      </TableCell>
      <TableCell className="hidden md:table-cell py-1 px-2 text-center">
        {task.percentComplete}%
      </TableCell>
      <TableCell className="py-1 px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-haspopup="true"
              size="icon"
              variant="ghost"
              data-testid="task-actions-menu-btn"
            >
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">{t("common.toggleMenu")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => editTask(task.id)}
              >
                <Pencil className="mr-2 h-4 w-4" />
                {t("tasks.editTask")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Tags className="mr-2 h-4 w-4" />
                  {t("tasks.changeStatus")}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="p-0">
                    {(Object.keys(TASK_STATUSES) as TaskStatus[]).map(
                      (status) => (
                        <DropdownMenuItem
                          className="cursor-pointer"
                          key={status}
                          onSelect={() => onChangeTaskStatus(task.id, status)}
                          disabled={status === task.status}
                        >
                          <span>{getLocalizedTaskStatus(status, t)}</span>
                        </DropdownMenuItem>
                      ),
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer text-green-600"
                onClick={() => onStartActivity(task.id)}
              >
                <CirclePlay className="mr-2 h-4 w-4" />
                {t("tasks.startActivity")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 cursor-pointer"
                onClick={() => onDeleteTask(task.id)}
              >
                <Trash className="mr-2 h-4 w-4" />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
      <TableCell className="hidden sm:table-cell py-1 px-1">
        <Button
          title={t("tasks.startActivity")}
          aria-haspopup="true"
          size="icon"
          variant="ghost"
          onClick={() => onStartActivity(task.id)}
          data-testid="task-start-activity-btn"
          className="opacity-0 group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-300"
        >
          <span>
            <CirclePlay className="text-green-600" />
          </span>
        </Button>
      </TableCell>
    </TableRow>
  );

  const renderTableHeader = () => (
    <TableHeader>
      <TableRow>
        <TableHead className="w-[24px] h-9 px-1">
          <span className="sr-only">{t("tasks.completeHeader")}</span>
        </TableHead>
        <TableHead className="h-9 px-2">{t("common.title")}</TableHead>
        <TableHead className="h-9 px-2">{t("tasks.activityType")}</TableHead>
        <TableHead className="hidden lg:table-cell h-9 px-2">
          {t("tasks.dueDate")}
        </TableHead>
        <TableHead className="hidden md:table-cell h-9 px-2">
          {t("common.status")}
        </TableHead>
        <TableHead className="hidden md:table-cell h-9 px-2 text-center">
          {t("tasks.priority")}
        </TableHead>
        <TableHead className="hidden md:table-cell h-9 px-2 text-center">
          {t("tasks.percentComplete")}
        </TableHead>
        <TableHead className="h-9 px-1">
          <span className="sr-only">{t("common.actions")}</span>
        </TableHead>
        <TableHead className="hidden sm:table-cell h-9 px-1">
          <span className="sr-only">{t("tasks.startActivity")}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );

  const renderGroupedTables = (entries: [string, Task[]][]) => (
    <TooltipProvider delayDuration={300}>
      {entries.map(([label, groupTasks]) => (
        <div key={label} className="mb-6">
          <h3 className="text-sm font-semibold mb-2 px-2 py-1">
            {label} ({groupTasks.length})
          </h3>
          <Table>
            {renderTableHeader()}
            <TableBody>{groupTasks.map(renderTaskRow)}</TableBody>
          </Table>
        </div>
      ))}
      <DeleteAlertDialog
        pageTitle={t("tasks.taskNoun")}
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={() => deleteTask(taskIdToDelete)}
      />
    </TooltipProvider>
  );

  const formatDateLabel = (dateStr: string) => {
    const date = parse(dateStr, "yyyy-MM-dd", new Date());
    return isToday(date) ? t("common.today") : formatDate(date);
  };

  if (tasks.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t("tasks.emptyState")}
      </div>
    );
  }

  if (groupBy === "dueDate") {
    const groupedTasks = groupTasksByDate(tasks, timeZone);
    const groupOrder: DateGroup[] = [
      "Overdue",
      "Today",
      "Tomorrow",
      "This Week",
      "Later",
      "No Due Date",
    ];

    return renderGroupedTables(
      groupOrder
        .filter((group) => groupedTasks[group].length > 0)
        .map((group) => [dateGroupLabels[group], groupedTasks[group]]),
    );
  }

  if (groupBy === "activityType") {
    return renderGroupedTables(
      Object.entries(groupTasksByActivityType(tasks)).map(([label, group]) => [
        label === "No Activity Type" ? t("tasks.noActivityType") : label,
        group,
      ]),
    );
  }

  if (groupBy === "createdDate" || groupBy === "updatedDate") {
    const groupedTasks =
      groupBy === "createdDate"
        ? groupTasksByCreatedDate(tasks)
        : groupTasksByUpdatedDate(tasks);

    return renderGroupedTables(
      Object.keys(groupedTasks)
        .sort()
        .reverse()
        .map((dateStr) => [formatDateLabel(dateStr), groupedTasks[dateStr]]),
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Table>
        {renderTableHeader()}
        <TableBody>{tasks.map(renderTaskRow)}</TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle={t("tasks.taskNoun")}
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={() => deleteTask(taskIdToDelete)}
      />
    </TooltipProvider>
  );
}

export default TasksTable;
