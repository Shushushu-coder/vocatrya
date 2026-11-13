"use client";
import TasksContainer from "@/components/tasks/TasksContainer";
import { ActivityType } from "@/models/activity.model";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ActivityTypeTaskCount } from "@/components/tasks/tasks-container/useTasksList";

type TasksPageClientProps = {
  activityTypes: ActivityType[];
  activityTypesWithCounts: ActivityTypeTaskCount[];
  totalTasks: number;
};

function TasksPageClient({
  activityTypes,
  activityTypesWithCounts,
  totalTasks,
}: TasksPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [filterKey, setFilterKey] = useState<string | undefined>(
    searchParams.get("activityType") ?? undefined,
  );

  const onFilterChange = (filter: string | undefined) => {
    setFilterKey(filter);
    const params = new URLSearchParams(searchParams.toString());
    if (filter) {
      params.set("activityType", filter);
    } else {
      params.delete("activityType");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  return (
    <div className="col-span-3 h-full">
      <TasksContainer
        activityTypes={activityTypes}
        filterKey={filterKey}
        onFilterChange={onFilterChange}
        initialTypeCounts={activityTypesWithCounts}
        initialTotalTasks={totalTasks}
      />
    </div>
  );
}

export default TasksPageClient;
