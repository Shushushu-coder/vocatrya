"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { canonicalizeEntityValue } from "@/lib/jobs/canonicalize";
import {
  APP_CONSTANTS,
  JOB_STATUSES,
  JOB_STATUS_VALUES,
} from "@/lib/constants";
import {
  missingDefaultJobSources,
  resolveJobSourceIdentity,
} from "@/lib/jobs/jobSources";
import { requireUser } from "../shared";

// The JobStatus table has no explicit ordering column, and its physical row
// order is an accident of seed/upsert history — not a business contract. Sort
// in canonical JOB_STATUSES order (unknown values keep their relative order at
// the end) so callers can rely on a deterministic list.
const STATUS_ORDER = new Map(
  JOB_STATUS_VALUES.map((value, index) => [value, index] as const),
);

// JobStatus is global reference data with no createdBy column, so unlike every
// other list here it is not scoped to the current user.
export const getStatusList = async (): Promise<any | undefined> => {
  try {
    let statuses = await prisma.jobStatus.findMany();
    if (statuses.length === 0) {
      for (const status of JOB_STATUSES) {
        await prisma.jobStatus.upsert({
          where: { value: status.value },
          update: {},
          create: { label: status.label, value: status.value },
        });
      }
      statuses = await prisma.jobStatus.findMany();
    }
    return statuses
      .slice()
      .sort(
        (a, b) =>
          (STATUS_ORDER.get(a.value) ?? STATUS_ORDER.size) -
          (STATUS_ORDER.get(b.value) ?? STATUS_ORDER.size),
      );
  } catch (error) {
    const msg = "Failed to fetch status list. ";
    return handleError(error, msg);
  }
};

async function ensureDefaultJobSources(userId: string) {
  const existing = await prisma.jobSource.findMany({
    where: { createdBy: userId },
    select: { value: true },
  });
  const missing = missingDefaultJobSources(existing.map((row) => row.value));
  if (missing.length === 0) return;
  for (const source of missing) {
    await prisma.jobSource.upsert({
      where: { value_createdBy: { value: source.value, createdBy: userId } },
      update: {},
      create: { ...source, createdBy: userId },
    });
  }
}

export const getJobSourceList = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    await ensureDefaultJobSources(user.id);
    const list = await prisma.jobSource.findMany({
      where: {
        createdBy: user.id,
      },
    });
    return list;
  } catch (error) {
    const msg = "Failed to fetch job source list. ";
    return handleError(error, msg);
  }
};

export const createLocation = async (
  label: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const value = canonicalizeEntityValue(label.trim());

    if (!value) {
      throw new Error("Please provide location name");
    }

    const existing = await prisma.location.findFirst({
      where: { value, createdBy: user.id },
    });
    if (existing) {
      return { data: existing, success: true };
    }

    const location = await prisma.location.create({
      data: { label, value, createdBy: user.id },
    });

    return { data: location, success: true };
  } catch (error) {
    const msg = "Failed to create job location. ";
    return handleError(error, msg);
  }
};

export const createJobSource = async (
  label: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const identity = resolveJobSourceIdentity(
      label,
      APP_CONSTANTS.MAX_JOB_SOURCE_LABEL_LENGTH,
    );
    if ("error" in identity) {
      throw new Error(
        identity.error === "too-long"
          ? "Job source name is too long"
          : "Please provide job source name",
      );
    }

    const existing = await prisma.jobSource.findFirst({
      where: { value: identity.value, createdBy: user.id },
    });
    if (existing) {
      return { data: existing, success: true };
    }

    const jobSource = await prisma.jobSource.create({
      data: {
        label: identity.label,
        value: identity.value,
        createdBy: user.id,
      },
    });

    return { data: jobSource, success: true };
  } catch (error) {
    const msg = "Failed to create job source. ";
    return handleError(error, msg);
  }
};
