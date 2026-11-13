"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getActivityTypesWithTaskCounts,
  getTasksList,
  updateTaskStatus,
} from "@/actions/task.actions";
import { toastActionResult, toastError } from "@/lib/toast";
import { Task, TaskGroupBy, TaskStatus } from "@/models/task.model";
import { APP_CONSTANTS } from "@/lib/constants";
import { useI18n } from "@/i18n";
import { runtimeTimeZone } from "@/lib/datetime";

const DEFAULT_STATUS_FILTER: TaskStatus[] = ["in-progress", "needs-attention"];

export type ActivityTypeTaskCount = {
  id: string;
  label: string;
  value: string;
  taskCount: number;
};

// Owns the task list itself: pagination, search, status/group filters,
// infinite scroll, and the optimistic status-change update.
export function useTasksList({
  filterKey,
  initialTypeCounts,
  initialTotalTasks,
  onTasksChanged,
}: {
  filterKey?: string;
  initialTypeCounts?: ActivityTypeTaskCount[];
  initialTotalTasks?: number;
  onTasksChanged?: () => void;
}) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [page, setPage] = useState(1);
  const [totalTasks, setTotalTasks] = useState(0);
  const [typeCounts, setTypeCounts] = useState<ActivityTypeTaskCount[]>(
    initialTypeCounts ?? [],
  );
  const [typeTotal, setTypeTotal] = useState(initialTotalTasks ?? 0);
  const [timeZone, setTimeZone] = useState<string>(() => runtimeTimeZone());
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [groupBy, setGroupBy] = useState<TaskGroupBy>("none");
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>(
    DEFAULT_STATUS_FILTER,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const hasSearched = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const tasksPerPage = APP_CONSTANTS.RECORDS_PER_PAGE;

  const loadTasks = useCallback(
    async (
      pageNum: number,
      filter?: string,
      statuses?: TaskStatus[],
      search?: string,
      group?: TaskGroupBy,
    ) => {
      if (pageNum === 1) setInitialLoading(true);
      else setLoadingMore(true);
      const { success, data, total, message, timeZone: zone } =
        await getTasksList(
          pageNum,
          tasksPerPage,
          filter,
          statuses,
          search,
          group,
        );
      if (success && data) {
        setTasks((prev) => (pageNum === 1 ? data : [...prev, ...data]));
        setTotalTasks(total);
        setPage(pageNum);
        if (typeof zone === "string") setTimeZone(zone);
      } else {
        toastError(message);
      }
      setInitialLoading(false);
      setLoadingMore(false);
    },
    [tasksPerPage],
  );

  // Per-category chip counts apply every other active filter (status, search)
  // but never the current category restriction itself, so the strip stays
  // usable while a category is selected.
  const refreshTypeCounts = useCallback(
    async (statuses?: TaskStatus[], search?: string) => {
      const result = await getActivityTypesWithTaskCounts({
        statuses,
        search,
      });
      if (result?.success) {
        setTypeCounts(result.data);
        setTypeTotal(result.totalTasks);
      }
    },
    [],
  );

  const reloadTasks = useCallback(async () => {
    await loadTasks(
      1,
      filterKey,
      statusFilter,
      searchTerm || undefined,
      groupBy,
    );
    await refreshTypeCounts(statusFilter, searchTerm || undefined);
    onTasksChanged?.();
  }, [
    loadTasks,
    filterKey,
    statusFilter,
    searchTerm,
    groupBy,
    refreshTypeCounts,
    onTasksChanged,
  ]);

  const onChangeTaskStatus = async (taskId: string, status: TaskStatus) => {
    const originalTasks = [...tasks];
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, status } : task)),
    );

    const result = await updateTaskStatus(taskId, status);
    if (result.success) {
      await refreshTypeCounts(statusFilter, searchTerm || undefined);
      onTasksChanged?.();
    } else {
      setTasks(originalTasks);
    }
    toastActionResult(result, { success: t("tasks.statusUpdated") });
  };

  useEffect(() => {
    (async () => {
      await loadTasks(
        1,
        filterKey,
        statusFilter,
        searchTerm || undefined,
        groupBy,
      );
      await refreshTypeCounts(statusFilter, searchTerm || undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTasks, filterKey, statusFilter, groupBy]);

  // Debounced search effect
  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      loadTasks(1, filterKey, statusFilter, searchTerm || undefined, groupBy);
      refreshTypeCounts(statusFilter, searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // Infinite scroll: auto-load next page when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          !initialLoading &&
          !loadingMore &&
          tasks.length < totalTasks
        ) {
          loadTasks(
            page + 1,
            filterKey,
            statusFilter,
            searchTerm || undefined,
            groupBy,
          );
        }
      },
      { threshold: APP_CONSTANTS.INTERSECTION_OBSERVER_THRESHOLD },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    tasks.length,
    totalTasks,
    page,
    filterKey,
    statusFilter,
    searchTerm,
    groupBy,
    initialLoading,
    loadingMore,
    loadTasks,
  ]);

  const onGroupByChange = (value: string) => {
    setGroupBy(value as TaskGroupBy);
  };

  const toggleStatusFilter = (status: TaskStatus) => {
    setStatusFilter((prev) =>
      prev.includes(status)
        ? prev.filter((s) => s !== status)
        : [...prev, status],
    );
  };

  return {
    tasks,
    totalTasks,
    typeCounts,
    typeTotal,
    timeZone,
    initialLoading,
    loadingMore,
    groupBy,
    onGroupByChange,
    statusFilter,
    toggleStatusFilter,
    searchTerm,
    setSearchTerm,
    sentinelRef,
    reloadTasks,
    onChangeTaskStatus,
  };
}
