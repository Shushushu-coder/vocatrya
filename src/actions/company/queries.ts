"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import {
  AB_APPLIED_OPPORTUNITY_WHERE,
  listOpportunitiesAsJobs,
} from "@/lib/career/jobOpportunityAdapter";
import { requireUser } from "../shared";
import { getReferenceEntityList } from "../referenceList";
import { CONTACT_LIST_INCLUDE } from "../contact/shared";
import { hideUnanalyzedScore } from "../job/shared";

export const getCompanyList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  countBy?: string,
  search?: string,
  scope: "mine" | "watchlist" = "mine",
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // The job stats columns must follow the active read family; a blocked
    // runtime must not silently fall back to frozen legacy Job rows.
    const { family } = await resolveJobsReadFamily(prisma);
    if (family === "blocked") {
      return {
        success: false,
        message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      };
    }
    const ab = family === "ab";

    const watchlist = scope === "watchlist";

    return await getReferenceEntityList({
      model: prisma.company,
      userId: user.id,
      fkField: "companyId",
      // AB sorts by total opportunities, the same way legacy sorts by total
      // jobs — the relation-count orderBy is unfiltered either way.
      appliedRelation: ab ? "jobOpportunities" : "jobsApplied",
      extraSelect: {
        logoUrl: true,
        watched: true,
        watchedAt: true,
        atsProvider: true,
        atsToken: true,
        atsHost: true,
      },
      // A+B has no per-company "rejected" rollup yet; leaving the key out
      // lets the table render a neutral "—" instead of a fake 0.
      extraCounts: ab
        ? []
        : [{ key: "jobsRejected", where: { Status: { value: "rejected" } } }],
      relationCounts: [
        // Same relation as appliedRelation, so this entry replaces the
        // default {applied: true} select and renames it to jobsApplied.
        ...(ab
          ? [
              {
                key: "jobsApplied",
                relation: "jobOpportunities",
                where: AB_APPLIED_OPPORTUNITY_WHERE,
              },
            ]
          : []),
        { key: "contacts", relation: "contacts", where: { createdBy: user.id } },
      ],
      countDelegate: ab ? prisma.jobOpportunity : undefined,
      jobsTotalWhere: ab ? { archivedAt: null } : undefined,
      // A watched row sits at applied-count 0, so the default sort would bury
      // whatever was just watched; most-recent-first is what the scope is for.
      ...(watchlist
        ? {
            extraWhere: { watched: true },
            orderBy: [{ watchedAt: "desc" }, { label: "asc" }],
          }
        : {}),
      searchFields: ["label", "atsToken"],
      page,
      limit,
      countBy,
      search,
    });
  } catch (error) {
    const msg = "Failed to fetch company list. ";
    return handleError(error, msg);
  }
};

export const getAllCompanies = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const companies = await prisma.company.findMany({
      where: {
        createdBy: user.id,
      },
    });
    return companies;
  } catch (error) {
    const msg = "Failed to fetch all companies. ";
    return handleError(error, msg);
  }
};

export const getCompanyById = async (
  companyId: string,
): Promise<any | undefined> => {
  try {
    if (!companyId) {
      throw new Error("Please provide company id");
    }
    const user = await requireUser();

    const company = await prisma.company.findUnique({
      where: {
        id: companyId,
        createdBy: user.id,
      },
    });
    return company;
  } catch (error) {
    const msg = "Failed to fetch company by Id. ";
    console.error(msg);
    if (error instanceof Error) {
      return { success: false, message: error.message };
    }
  }
};

const COMPANY_JOB_SELECT = {
  id: true,
  createdAt: true,
  applied: true,
  appliedDate: true,
  matchScore: true,
  matchData: true,
  JobTitle: { select: { label: true } },
  Status: { select: { label: true, value: true } },
  Location: { select: { label: true } },
  JobSource: { select: { label: true } },
};

// null covers both a missing id and another user's company, so the page's 404
// never reveals which. Dismissed jobs are hidden like on the Jobs page, but
// counted, because deleteCompanyById's job guard still sees them.
export const getCompanyDetails = async (
  companyId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const company = await prisma.company.findFirst({
      where: { id: companyId, createdBy: user.id },
    });
    if (!company) return null;

    const { family } = await resolveJobsReadFamily(prisma);
    // A blocked family must not masquerade as an empty Jobs tab; an error
    // result keeps "no jobs" and "jobs unreadable" distinguishable.
    if (family === "blocked") {
      return {
        success: false,
        message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      };
    }
    const ab = family === "ab";

    const jobsPromise = ab
      ? listOpportunitiesAsJobs(prisma, user.id, {
          companyId: company.id,
        }).then((result) => result.data)
      : prisma.job
          .findMany({
            where: {
              companyId,
              userId: user.id,
              OR: [
                { discoveryStatus: null },
                { discoveryStatus: { not: "dismissed" } },
              ],
            },
            select: COMPANY_JOB_SELECT,
            orderBy: { createdAt: "desc" },
          })
          .then((rows) => rows.map(hideUnanalyzedScore));

    // Same applied basis as the company list: distinct non-archived
    // opportunities with at least one live attempt proving the ever-applied
    // fact (submitted or post-DRAFT stage).
    const appliedCountPromise = ab
      ? prisma.jobOpportunity.count({
          where: { companyId: company.id, userId: user.id, ...AB_APPLIED_OPPORTUNITY_WHERE },
        })
      : Promise.resolve(0);

    // A+B has no dismissed-discovery concept, and the legacy Job table is
    // frozen then — reporting its count would be a stale fake, so null.
    const dismissedCountPromise = ab
      ? Promise.resolve(null)
      : prisma.job.count({
          where: { companyId, userId: user.id, discoveryStatus: "dismissed" },
        });

    const [jobs, appliedCountAb, dismissedJobsCount, currentContacts, formerContacts] =
      await Promise.all([
        jobsPromise,
        appliedCountPromise,
        dismissedCountPromise,
        prisma.contact.findMany({
          where: { companyId, createdBy: user.id },
          include: CONTACT_LIST_INCLUDE,
          orderBy: [{ name: "asc" }],
        }),
        prisma.contact.findMany({
          where: { workedAtCompanyId: companyId, createdBy: user.id },
          include: CONTACT_LIST_INCLUDE,
          orderBy: [{ name: "asc" }],
        }),
      ]);

    return {
      ...company,
      jobs,
      appliedCount: ab
        ? appliedCountAb
        : jobs.filter((job) => job.applied).length,
      dismissedJobsCount,
      currentContacts,
      formerContacts,
    };
  } catch (error) {
    return handleError(error, "Failed to fetch company details. ");
  }
};
