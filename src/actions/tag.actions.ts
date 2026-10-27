"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
import { canonicalizeEntityValue } from "@/lib/jobs/canonicalize";
import { resolveTag as resolveTagCore } from "@/lib/jobs/resolve";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";

export const getAllTags = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const list = await prisma.tag.findMany({
      where: { createdBy: user.id },
      orderBy: { label: "asc" },
    });
    return list;
  } catch (error) {
    const msg = "Failed to fetch tag list. ";
    return handleError(error, msg);
  }
};

export const getTagList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  search?: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // The Total Jobs column only exists under the legacy read family: A+B
    // has no Tag→JobOpportunity relation, and a blocked runtime must not
    // silently fall back to frozen legacy Job rows.
    const { family } = await resolveJobsReadFamily(prisma);
    if (family === "blocked") {
      return {
        success: false,
        message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      };
    }
    const ab = family === "ab";

    const skip = (page - 1) * limit;

    const whereClause: any = { createdBy: user.id };
    if (search) {
      whereClause.label = { contains: search };
    }

    const [data, total] = await Promise.all([
      prisma.tag.findMany({
        where: whereClause,
        skip,
        take: limit,
        select: {
          id: true,
          label: true,
          value: true,
          _count: {
            select: ab
              ? { questions: true, skills: true, careerSkillDetails: true }
              : {
                  jobs: true,
                  questions: true,
                  skills: true,
                  careerSkillDetails: true,
                },
          },
        },
        // A+B cannot sort on a frozen legacy count; label order stays
        // deterministic, and the label tiebreak keeps equal-count rows
        // stable across pages under the legacy family.
        orderBy: ab
          ? [{ label: "asc" }]
          : [{ jobs: { _count: "desc" } }, { label: "asc" }],
      }),
      prisma.tag.count({ where: whereClause }),
    ]);

    // jobsCountAvailable is the count contract: the client distinguishes
    // "no linked jobs" (0) from "no such relation under this family" via
    // this flag, never via the number itself.
    return { data, total, jobsCountAvailable: !ab };
  } catch (error) {
    const msg = "Failed to fetch tag list. ";
    return handleError(error, msg);
  }
};

export const createTag = async (label: string): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    if (!label.trim()) {
      throw new Error("Tag label cannot be empty.");
    }

    const { created: _, ...tag } = await resolveTagCore(label, user.id);
    return { data: tag, success: true };
  } catch (error) {
    const msg = "Failed to create tag. ";
    return handleError(error, msg);
  }
};

export const updateTag = async (
  tagId: string,
  label: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const existing = await prisma.tag.findFirst({
      where: { id: tagId, createdBy: user.id },
    });
    if (!existing) {
      throw new Error("Skill tag not found");
    }

    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      throw new Error("Tag label cannot be empty.");
    }

    // Recompute the match key only when the label actually changed, so rows
    // holding a non-derivable value keep it on unrelated saves.
    let value = existing.value;
    if (trimmedLabel !== existing.label) {
      value = canonicalizeEntityValue(trimmedLabel);
      if (!value) {
        throw new Error("Tag label cannot be empty.");
      }
      const conflict = await prisma.tag.findFirst({
        where: { value, createdBy: user.id },
      });
      if (conflict && conflict.id !== tagId) {
        throw new Error("Skill tag already exists!");
      }
    }

    const res = await prisma.tag.update({
      where: { id: tagId, createdBy: user.id },
      data: { label: trimmedLabel, value },
    });
    return { success: true, data: res };
  } catch (error) {
    const msg = "Failed to update tag.";
    return handleError(error, msg);
  }
};

export const deleteTagById = async (
  tagId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    if (typeof tagId !== "string" || !tagId.trim()) {
      throw new Error("Skill tag not found.");
    }

    // careerSkillDetails counts live AND archived material rows: archiving a
    // skill record must not free the Tag for deletion (BD-LINKS contract).
    // Counts and delete run in one transaction so a reference created
    // concurrently cannot slip between the check and the delete.
    const res = await prisma.$transaction(async (tx) => {
      const owned = await tx.tag.findFirst({
        where: { id: tagId, createdBy: user.id },
        select: { id: true },
      });
      if (!owned) throw new Error("Skill tag not found.");
      const [jobs, questions, skills, careerSkillDetails] = await Promise.all([
        tx.job.count({ where: { tags: { some: { id: tagId } } } }),
        tx.question.count({ where: { tags: { some: { id: tagId } } } }),
        tx.skill.count({ where: { tagId } }),
        tx.careerSkillDetail.count({ where: { tagId } }),
      ]);

      if (jobs > 0 || questions > 0 || skills > 0 || careerSkillDetails > 0) {
        const links = [
          jobs > 0 ? `${jobs} job(s)` : "",
          questions > 0 ? `${questions} question(s)` : "",
          skills > 0 ? `${skills} skill(s)` : "",
          careerSkillDetails > 0
            ? `${careerSkillDetails} career skill record(s)`
            : "",
        ]
          .filter(Boolean)
          .join(" and ");

        throw new Error(
          `Skill tag cannot be deleted because it is linked to ${links}.`,
        );
      }

      return tx.tag.delete({
        where: { id: tagId, createdBy: user.id },
      });
    });

    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete tag.";
    return handleError(error, msg);
  }
};
