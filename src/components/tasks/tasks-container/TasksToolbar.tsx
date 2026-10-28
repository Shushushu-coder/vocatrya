"use client";
import { useEffect, useState } from "react";
import { Filter, ListFilter, PlusCircle } from "lucide-react";
import { Button } from "../../ui/button";
import { CardTitle } from "../../ui/card";
import { ResponsiveCardHeader } from "../../ResponsiveCardHeader";
import { SearchInput } from "../../SearchInput";
import { RecordsCount } from "../../RecordsCount";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { TaskGroupBy, TaskStatus, TASK_STATUSES } from "@/models/task.model";
import { useI18n, getLocalizedTaskStatus } from "@/i18n";

// Presentational: the Tasks card header — title/count, search, status
// filter dropdown, group-by select, and New Task.
export function TasksToolbar({
  tasksCount,
  totalTasks,
  initialLoading,
  searchTerm,
  onSearchTermChange,
  statusFilter,
  onToggleStatusFilter,
  groupBy,
  onGroupByChange,
  onAddTask,
}: {
  tasksCount: number;
  totalTasks: number;
  initialLoading: boolean;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  statusFilter: TaskStatus[];
  onToggleStatusFilter: (status: TaskStatus) => void;
  groupBy: TaskGroupBy;
  onGroupByChange: (value: string) => void;
  onAddTask: () => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch with Radix UI components
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <ResponsiveCardHeader>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <CardTitle>{t("tasks.title")}</CardTitle>
        {!initialLoading && totalTasks > 0 && (
          <RecordsCount
            count={tasksCount}
            total={totalTasks}
            label={t("tasks.recordsLabel")}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
        <SearchInput
          value={searchTerm}
          onChange={onSearchTermChange}
          placeholder={t("tasks.searchPlaceholder")}
        />
        {mounted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1">
                <Filter className="h-3.5 w-3.5" />
                <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
                  {t("common.status")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {t("tasks.filterByStatusLabel")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.keys(TASK_STATUSES) as TaskStatus[]).map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={statusFilter.includes(status)}
                  onCheckedChange={() => onToggleStatusFilter(status)}
                >
                  {getLocalizedTaskStatus(status, t)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1">
            <Filter className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
              {t("common.status")}
            </span>
          </Button>
        )}
        {mounted ? (
          <Select value={groupBy} onValueChange={onGroupByChange}>
            <SelectTrigger className="w-[140px] h-8">
              <ListFilter className="h-3.5 w-3.5" />
              <SelectValue placeholder={t("tasks.groupBy")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t("tasks.groupBy")}</SelectLabel>
                <SelectSeparator />
                <SelectItem value="none">{t("common.none")}</SelectItem>
                <SelectItem value="createdDate">
                  {t("tasks.createdDate")}
                </SelectItem>
                <SelectItem value="dueDate">{t("tasks.dueDate")}</SelectItem>
                <SelectItem value="updatedDate">
                  {t("tasks.updatedDate")}
                </SelectItem>
                <SelectItem value="activityType">
                  {t("tasks.activityType")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1 w-[140px]">
            <ListFilter className="h-3.5 w-3.5" />
            <span>{t("tasks.groupBy")}</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1"
          onClick={onAddTask}
          data-testid="add-task-btn"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
            {t("tasks.newTask")}
          </span>
        </Button>
      </div>
    </ResponsiveCardHeader>
  );
}
