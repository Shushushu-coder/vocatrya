"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { TaskStatus } from "@/models/task.model";
import { AddTaskFormSchema } from "@/models/addTaskForm.schema";
import { z } from "zod";
import { requireUser } from "../shared";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { compareDateOnly, parseDateOnly, todayDateOnly } from "@/lib/datetime";
import { withDueDto } from "@/lib/tasks/dueTime";

const WITH_ACTIVITY_TYPE = {
  activityType: true,
};

// §5.1 write contract: a form-picked day persists as `dueOn` + "dateOnly" and
// never fabricates a dueDate instant; null clears all three columns. The
// "not earlier than today" rule compares calendar days in the account zone.
async function resolveDueWrite(
  userId: string,
  dueOn: string | null,
): Promise<{
  dueOn: string | null;
  duePrecision: "dateOnly" | null;
  dueDate: null;
}> {
  if (dueOn === null) {
    return { dueOn: null, duePrecision: null, dueDate: null };
  }
  const date = parseDateOnly(dueOn);
  if (!date) {
    throw new Error("Invalid due date.");
  }
  const timeZone = await getUserTimeZone(userId);
  if (compareDateOnly(date, todayDateOnly(timeZone)) < 0) {
    throw new Error("Due date cannot be in the past.");
  }
  return { dueOn: date, duePrecision: "dateOnly", dueDate: null };
}

export const createTask = async (
  data: z.infer<typeof AddTaskFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const validatedData = AddTaskFormSchema.parse(data);

    const task = await prisma.task.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        status: validatedData.status,
        priority: validatedData.priority,
        percentComplete: validatedData.percentComplete,
        ...(await resolveDueWrite(user.id, validatedData.dueOn ?? null)),
        activityTypeId: validatedData.activityTypeId,
        userId: user.id,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: withDueDto(task) };
  } catch (error) {
    const msg = "Failed to create task.";
    return handleError(error, msg);
  }
};

export const updateTask = async (
  data: z.infer<typeof AddTaskFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    if (!data.id) {
      throw new Error("Task ID is required for update");
    }

    const validatedData = AddTaskFormSchema.parse(data);

    const task = await prisma.task.update({
      where: {
        id: data.id,
        userId: user.id,
      },
      data: {
        title: validatedData.title,
        description: validatedData.description,
        status: validatedData.status,
        priority: validatedData.priority,
        percentComplete: validatedData.percentComplete,
        // dueOn absent → the form never touched the field: write none of the
        // three due columns so a historical instant/unknown stays intact.
        ...(validatedData.dueOn !== undefined
          ? await resolveDueWrite(user.id, validatedData.dueOn)
          : {}),
        activityTypeId: validatedData.activityTypeId,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: withDueDto(task) };
  } catch (error) {
    const msg = "Failed to update task.";
    return handleError(error, msg);
  }
};

export const updateTaskStatus = async (
  taskId: string,
  status: TaskStatus
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.update({
      where: {
        id: taskId,
        userId: user.id,
      },
      data: {
        status,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: withDueDto(task) };
  } catch (error) {
    const msg = "Failed to update task status.";
    return handleError(error, msg);
  }
};

export const deleteTaskById = async (
  taskId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        userId: user.id,
      },
      include: {
        activities: {
          select: { id: true },
        },
      },
    });

    if (!task) {
      return { success: false, message: "Task not found" };
    }

    if (task.activities.length > 0) {
      return {
        success: false,
        message:
          "Cannot delete task with linked activity. Remove the activity first.",
      };
    }

    await prisma.task.delete({
      where: {
        id: taskId,
        userId: user.id,
      },
    });

    return { success: true };
  } catch (error) {
    const msg = "Failed to delete task.";
    return handleError(error, msg);
  }
};
