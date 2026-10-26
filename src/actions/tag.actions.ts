"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
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
              ? { questions: true, skills: true }
              : { jobs: true, questions: true, skills: true },
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

export const deleteTagById = async (
  tagId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const [jobs, questions, skills] = await Promise.all([
      prisma.job.count({ where: { tags: { some: { id: tagId } } } }),
      prisma.question.count({ where: { tags: { some: { id: tagId } } } }),
      prisma.skill.count({ where: { tagId } }),
    ]);

    if (jobs > 0 || questions > 0 || skills > 0) {
      const links = [
        jobs > 0 ? `${jobs} job(s)` : "",
        questions > 0 ? `${questions} question(s)` : "",
        skills > 0 ? `${skills} skill(s)` : "",
      ]
        .filter(Boolean)
        .join(" and ");

      throw new Error(
        `Skill tag cannot be deleted because it is linked to ${links}.`,
      );
    }

    const res = await prisma.tag.delete({
      where: { id: tagId, createdBy: user.id },
    });

    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete tag.";
    return handleError(error, msg);
  }
};
