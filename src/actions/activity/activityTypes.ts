"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { requireUser } from "../shared";

export const getAllActivityTypes = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const activityTypes = await prisma.activityType.findMany({
      where: {
        createdBy: user.id,
      },
    });
    return activityTypes;
  } catch (error) {
    const msg = "Failed to fetch all activity types. ";
    return handleError(error, msg);
  }
};

export const createActivityType = async (
  label: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const value = label.trim().toLowerCase();
    if (!value) {
      throw new Error("Activity type label cannot be empty.");
    }

    const upsertedActivityType = await prisma.activityType.upsert({
      where: { value_createdBy: { value, createdBy: user.id } },
      update: { label },
      create: { label, value, createdBy: user.id },
    });

    return upsertedActivityType;
  } catch (error) {
    const msg = "Failed to create activity type. ";
    console.error(msg, error);
    throw new Error(msg);
  }
};

export const updateActivityType = async (
  activityTypeId: string,
  label: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const existing = await prisma.activityType.findFirst({
      where: { id: activityTypeId, createdBy: user.id },
    });
    if (!existing) {
      throw new Error("Activity type not found");
    }

    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      throw new Error("Activity type label cannot be empty.");
    }

    // Keep the create path's key rule: label.trim().toLowerCase(), not the
    // shared canonicalizer other dictionaries use.
    let value = existing.value;
    if (trimmedLabel !== existing.label) {
      value = trimmedLabel.toLowerCase();
      const conflict = await prisma.activityType.findFirst({
        where: { value, createdBy: user.id },
      });
      if (conflict && conflict.id !== activityTypeId) {
        throw new Error("Activity type already exists!");
      }
    }

    const res = await prisma.activityType.update({
      where: { id: activityTypeId, createdBy: user.id },
      data: { label: trimmedLabel, value },
    });
    return { success: true, data: res };
  } catch (error) {
    const msg = "Failed to update activity type.";
    return handleError(error, msg);
  }
};

export const getActivityTypeList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const skip = (page - 1) * limit;
    const whereClause = { createdBy: user.id };

    const total = await prisma.activityType.count({ where: whereClause });

    // Task categories with their linked-task counts, most-used first.
    const allTypes = await prisma.activityType.findMany({
      where: whereClause,
      select: {
        id: true,
        label: true,
        value: true,
        _count: { select: { Tasks: true } },
      },
    });

    const sorted = allTypes.sort(
      (a, b) => (b._count?.Tasks ?? 0) - (a._count?.Tasks ?? 0),
    );

    const data = sorted.slice(skip, skip + limit);

    return { data, total };
  } catch (error) {
    const msg = "Failed to fetch activity type list. ";
    return handleError(error, msg);
  }
};

export const deleteActivityTypeById = async (
  activityTypeId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const tasks = await prisma.task.count({
      where: { activityTypeId, userId: user.id },
    });

    if (tasks > 0) {
      throw new Error(
        `Activity type cannot be deleted because it is linked to ${tasks} task(s).`,
      );
    }

    const res = await prisma.activityType.delete({
      where: { id: activityTypeId, createdBy: user.id },
    });

    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete activity type.";
    return handleError(error, msg);
  }
};
