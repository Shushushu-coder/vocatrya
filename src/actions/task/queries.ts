"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { TaskGroupBy, TaskStatus } from "@/models/task.model";
import { APP_CONSTANTS } from "@/lib/constants";
import { requireUser } from "../shared";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { orderTasksByDue, withDueDto } from "@/lib/tasks/dueTime";

const TASK_INCLUDE = {
  activityType: true,
};

// The columns the due ordering needs — nothing more is fetched before the
// page is sliced (§5.3: sort the whole matching set, hydrate this page only).
const TASK_DUE_SORT_SELECT = {
  id: true,
  dueOn: true,
  dueDate: true,
  duePrecision: true,
  priority: true,
} as const;

// Stored precision is normalized once at the DTO boundary via
// dueTime.withDueDto (a "use server" file may only export async functions,
// so the mapper lives with the rest of the due-reading contract).

function getTasksOrderBy(groupBy?: TaskGroupBy) {
  switch (groupBy) {
    case "createdDate":
      return [
        { createdAt: "desc" as const },
        { priority: "desc" as const },
        { id: "asc" as const },
      ];
    case "updatedDate":
      return [
        { updatedAt: "desc" as const },
        { priority: "desc" as const },
        { createdAt: "desc" as const },
        { id: "asc" as const },
      ];
    case "activityType":
      return [
        { activityType: { label: "asc" as const } },
        { priority: "desc" as const },
        { createdAt: "desc" as const },
        { id: "asc" as const },
      ];
    default:
      return [
        { priority: "desc" as const },
        { createdAt: "desc" as const },
        { updatedAt: "desc" as const },
        { id: "asc" as const },
      ];
  }
}

export const getTasksList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  filter?: string,
  statusFilter?: TaskStatus[],
  search?: string,
  groupBy?: TaskGroupBy,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const timeZone = await getUserTimeZone(user.id);

    const offset = (page - 1) * limit;

    const whereClause: any = {
      userId: user.id,
    };

    if (filter) {
      whereClause.activityTypeId = filter;
    }

    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }

    if (search) {
      whereClause.OR = [
        { title: { contains: search } },
        { description: { contains: search } },
        { activityType: { label: { contains: search } } },
      ];
    }

    // §5.3: the mixed dateOnly/instant key cannot be expressed in Prisma
    // orderBy and sorting one fetched page would paginate wrongly — so the
    // full matching set is sorted first, and only this page is hydrated.
    if (groupBy === "dueDate") {
      const sortRows = await prisma.task.findMany({
        where: whereClause,
        select: TASK_DUE_SORT_SELECT,
      });
      const orderedIds = orderTasksByDue(sortRows, timeZone).map((r) => r.id);
      const pageIds = orderedIds.slice(offset, offset + limit);
      const position = new Map(pageIds.map((id, index) => [id, index]));
      const pageRows = await prisma.task.findMany({
        where: { id: { in: pageIds }, userId: user.id },
        include: TASK_INCLUDE,
      });
      pageRows.sort(
        (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
      );
      return {
        success: true,
        data: pageRows.map(withDueDto),
        total: sortRows.length,
        timeZone,
      };
    }

    const [data, total] = await Promise.all([
      prisma.task.findMany({
        where: whereClause,
        include: TASK_INCLUDE,
        orderBy: getTasksOrderBy(groupBy),
        skip: offset,
        take: limit,
      }),
      prisma.task.count({
        where: whereClause,
      }),
    ]);

    return {
      success: true,
      data: data.map(withDueDto),
      total,
      timeZone,
    };
  } catch (error) {
    const msg = "Failed to fetch tasks list.";
    return handleError(error, msg);
  }
};

export const getTaskById = async (taskId: string): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        userId: user.id,
      },
      include: TASK_INCLUDE,
    });

    if (!task) {
      return { success: false, message: "Task not found" };
    }

    return {
      success: true,
      data: withDueDto(task),
    };
  } catch (error) {
    const msg = "Failed to fetch task.";
    return handleError(error, msg);
  }
};

export const getActivityTypesWithTaskCounts = async (options?: {
  statuses?: TaskStatus[];
  search?: string;
}): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // `statuses` omitted keeps the historical "open work" definition, which
    // equals the toolbar's default status set; an explicit array reflects the
    // current status filter, with [] meaning no status restriction.
    const excludedStatuses = ["complete", "cancelled"];

    const taskFilter: any = {};
    if (options?.statuses === undefined) {
      taskFilter.status = { notIn: excludedStatuses };
    } else if (options.statuses.length > 0) {
      taskFilter.status = { in: options.statuses };
    }

    if (options?.search) {
      taskFilter.OR = [
        { title: { contains: options.search } },
        { description: { contains: options.search } },
        { activityType: { label: { contains: options.search } } },
      ];
    }

    const activityTypes = await prisma.activityType.findMany({
      where: {
        createdBy: user.id,
      },
      include: {
        _count: {
          select: {
            Tasks: {
              where: taskFilter,
            },
          },
        },
      },
    });

    const data = activityTypes
      .map((type) => ({
        id: type.id,
        label: type.label,
        value: type.value,
        taskCount: type._count.Tasks,
      }))
      .sort((a, b) => b.taskCount - a.taskCount);

    const totalTasks = await prisma.task.count({
      where: {
        userId: user.id,
        ...taskFilter,
      },
    });

    return { success: true, data, totalTasks };
  } catch (error) {
    const msg = "Failed to fetch activity types with task counts.";
    return handleError(error, msg);
  }
};
