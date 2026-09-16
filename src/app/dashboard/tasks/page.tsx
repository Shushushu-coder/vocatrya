import TasksPageClient from "./TasksPageClient";
import { getAllActivityTypes } from "@/actions/activity.actions";
import { getActivityTypesWithTaskCounts } from "@/actions/task.actions";
import React from "react";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.tasks") };
}

async function Tasks() {
  const [activityTypes, activityTypesWithCounts] = await Promise.all([
    getAllActivityTypes(),
    getActivityTypesWithTaskCounts(),
  ]);

  return (
    <TasksPageClient
      activityTypes={activityTypes || []}
      activityTypesWithCounts={activityTypesWithCounts?.data || []}
      totalTasks={activityTypesWithCounts?.totalTasks || 0}
    />
  );
}

export default Tasks;
