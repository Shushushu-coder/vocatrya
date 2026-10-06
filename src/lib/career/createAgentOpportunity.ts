import type { Prisma } from "@prisma/client";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { normalizeJobUrl } from "@/lib/scraper/utils";
import { JobResolutionError } from "@/lib/jobs/resolve";
import {
  resolveCompany,
  resolveJobSource,
  resolveJobTitle,
  resolveJobType,
  resolveLocation,
  resolveWorkplaceType,
  type ResolvedEntity,
} from "@/lib/jobs/resolve";
import { OPPORTUNITY_STATUS } from "./identities";
import { syncJdVersion } from "./jobOpportunityAdapter";
import { normalizeOptionalText, OpportunityService } from "./opportunityService";

const EXECUTION_KEY_PREFIX = "agent-chat:";

export type CreateAgentOpportunityInput = {
  company: string;
  jobTitle: string;
  jobDescription?: string | null;
  location?: string | null;
  source?: string | null;
  jobType?: string | null;
  workplaceType?: string | null;
  dueDate?: Date | null;
  jobUrl?: string | null;
  salaryRange?: string | null;
  /**
   * Stable id of this approved tool call. A replay of the same id returns
   * the opportunity already written for it and does not insert another.
   */
  toolCallId?: string | null;
};

export type CreateAgentOpportunityResult = {
  created: boolean;
  jobOpportunityId: string;
  company: string;
  title: string;
  resolutions: ResolvedEntity[];
  hasDescription: boolean;
  replayed: boolean;
};

function requiredName(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new JobResolutionError(`${field} is required`);
  }
  return trimmed;
}

function descriptionSource(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "N/A") return null;
  return value;
}

function executionKey(toolCallId?: string | null): string | null {
  const id = toolCallId?.trim();
  if (!id) return null;
  return `${EXECUTION_KEY_PREFIX}${id}`;
}

/**
 * Canonical Agent create. Company / title / location / source go through the
 * same name resolvers My Jobs uses. The opportunity, its raw JD version, and
 * the execution key commit in one transaction. Application attempts, legacy
 * jobs, and legacy notes are never written here.
 */
export async function createAgentOpportunity(
  input: CreateAgentOpportunityInput,
  userId: string,
): Promise<CreateAgentOpportunityResult> {
  return prisma.$transaction(tx => createAgentOpportunityInTransaction(tx, input, userId));
}

export async function createAgentOpportunityInTransaction(
  db: Prisma.TransactionClient,
  input: CreateAgentOpportunityInput,
  userId: string,
): Promise<CreateAgentOpportunityResult> {
  const companyName = requiredName(input.company, "company");
  const titleName = requiredName(input.jobTitle, "jobTitle");
  const employmentType = input.jobType ? resolveJobType(input.jobType) : null;
  const workplaceType = resolveWorkplaceType(input.workplaceType ?? undefined);
  const rawDescription = descriptionSource(input.jobDescription);
  const sourceUrl = input.jobUrl ? normalizeJobUrl(input.jobUrl) : null;
  const key = executionKey(input.toolCallId);
  const locationName = input.location?.trim() ? input.location.trim() : null;
  const sourceName = input.source?.trim() ? input.source.trim() : null;


  if (key) {
    const existing = await db.jobOpportunity.findFirst({
      where: { userId, externalSourceKey: key },
      select: {
        id: true,
        title: true,
        company: { select: { label: true } },
        currentJdVersionId: true,
      },
    });
    if (existing) {
      return {
        created: true,
        jobOpportunityId: existing.id,
        company: existing.company.label,
        title: existing.title,
        resolutions: [],
        hasDescription: existing.currentJdVersionId !== null,
        replayed: true,
      };
    }
  }

  const resolvedCompany = await resolveCompany(companyName, userId, db);
  const resolvedTitle = await resolveJobTitle(titleName, userId, db);
  const resolvedLocation = locationName
    ? await resolveLocation(locationName, userId, db)
    : null;
  const resolvedSource = sourceName
    ? await resolveJobSource(sourceName, userId, db)
    : null;

  const created = await new OpportunityService(db, userId).create({
    companyId: resolvedCompany.id,
    title: resolvedTitle.label,
    locationText: resolvedLocation?.label ?? null,
    employmentType,
    workplaceType,
    sourceUrl,
    sourceLabel: resolvedSource?.label ?? null,
    deadline: input.dueDate ?? null,
    salaryText: normalizeOptionalText(input.salaryRange) ?? null,
    status: OPPORTUNITY_STATUS.UNKNOWN,
    createdVia: APP_CONSTANTS.AGENT_CHAT_CREATED_VIA,
    externalSourceKey: key,
  });

  if (rawDescription) {
    await syncJdVersion(db, created.id, rawDescription, sourceUrl, "PLAIN_TEXT");
  }

  return {
    created: true,
    jobOpportunityId: created.id,
    company: resolvedCompany.label,
    title: resolvedTitle.label,
    resolutions: [
      resolvedCompany,
      resolvedTitle,
      ...(resolvedLocation ? [resolvedLocation] : []),
      ...(resolvedSource ? [resolvedSource] : []),
    ],
    hasDescription: rawDescription !== null,
    replayed: false,
  };
}
