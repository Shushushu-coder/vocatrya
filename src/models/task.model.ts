import { ActivityType } from "./activity.model";
import type { TaskDuePrecision } from "@/lib/tasks/dueTime";

export const TASK_STATUSES = {
  "in-progress": "In Progress",
  complete: "Complete",
  "needs-attention": "Needs Attention",
  cancelled: "Cancelled",
} as const;

export type TaskStatus = keyof typeof TASK_STATUSES;

export type TaskGroupBy =
  "none" | "createdDate" | "dueDate" | "updatedDate" | "activityType";

export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: number;
  percentComplete: number;
  dueDate?: Date | null;
  dueOn?: string | null;
  duePrecision?: TaskDuePrecision | null;
  activityTypeId?: string | null;
  activityType?: ActivityType | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskWithActivityType extends Task {
  activityType: ActivityType | null;
}
