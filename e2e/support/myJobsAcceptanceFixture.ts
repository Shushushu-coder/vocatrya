import type { PrismaClient } from "@prisma/client";
import { sha256Utf8 } from "@/lib/career/hash";
import { OPPORTUNITY_STATUS } from "@/lib/career/identities";
import {
  resolveJobsReadFamily,
  type JobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import { planUiStatusWrite } from "@/lib/career/uiStatus";
import zh from "@/i18n/messages/zh-CN.json";

export const ACCEPTANCE_JOB_COUNT = 28;
export const ACCEPTANCE_DESCRIPTION = "中文用户描述保留原样";
export const ACCEPTANCE_SALARY = "200-250元/天";
export const ACCEPTANCE_LOCATION_LABEL = "上海 Remote 自定义";
export const ACCEPTANCE_JOB_TYPE = "INTERNSHIP";
export const ACCEPTANCE_WORKPLACE = "REMOTE";
export const ACCEPTANCE_APPLIED_DATE = new Date("2026-09-01T00:00:00.000Z");

export type AcceptanceCatalog = {
  userId: string;
  marker: string;
  company: { id: string; label: string };
  title: { id: string; label: string };
  location: { id: string; label: string };
  source: { id: string; label: string };
};

export type SeededAcceptanceJobs = {
  family: Exclude<JobsReadFamily, "blocked">;
  catalog: AcceptanceCatalog;
  singletonFilterLabel: string;
  resetFilterLabel: string;
};

type SeedInput = {
  userId: string;
  marker: string;
  env?: NodeJS.ProcessEnv;
};

function filterLabels(family: Exclude<JobsReadFamily, "blocked">) {
  // Same branch as the toolbar: A+B read mode hides discovery filters and
  // projects an unapplied row with no attempt as draft, not legacy "new".
  if (family === "ab") {
    return {
      singletonFilterLabel: zh.jobs.statuses.draft,
      resetFilterLabel: zh.jobs.allJobs,
    };
  }
  return {
    singletonFilterLabel: zh.jobs.statuses.new,
    resetFilterLabel: zh.jobs.allExceptDismissed,
  };
}

function rowVariation(index: number) {
  const unapplied = index === 0;
  return {
    applied: !unapplied,
    appliedDate: unapplied ? null : ACCEPTANCE_APPLIED_DATE,
    legacyStatus: unapplied ? "new" : "interview",
    abStatus: unapplied ? "draft" : "interview",
  };
}

// Final ApplicationAttempt row that syncApplicationFromUiStatus would persist.
// Write services are gated off in AB_READY_DISABLED, so the fixture writes this
// post-state directly and lets deriveUiStatus / list projection read it back.
function attemptForVisibleStatus(
  uiStatus: string,
  applied: boolean,
  appliedDate: Date | null,
) {
  const plan = planUiStatusWrite(uiStatus);
  if (plan.kind !== "attempt") {
    if (applied) {
      throw new Error(`Status ${uiStatus} cannot project an applied attempt.`);
    }
    return null;
  }
  const markSubmitted = plan.markSubmitted || applied;
  return {
    channelLabel: "USER",
    currentStageCategory: plan.currentStageCategory,
    outcome: plan.outcome,
    submittedAt: markSubmitted ? appliedDate ?? new Date() : null,
    createdVia: "USER",
  };
}

async function createCatalog(
  db: PrismaClient,
  userId: string,
  marker: string,
): Promise<AcceptanceCatalog> {
  const company = await db.company.create({
    data: { label: `${marker}公司`, value: `${marker}company`, createdBy: userId },
  });
  const title = await db.jobTitle.create({
    data: { label: `${marker}中文职位`, value: `${marker}title`, createdBy: userId },
  });
  const location = await db.location.create({
    data: { label: ACCEPTANCE_LOCATION_LABEL, value: marker, createdBy: userId },
  });
  // JobOpportunity stores sourceLabel. The list projection resolves that text
  // through an owned JobSource row with the same label; there is no source FK.
  const source = await db.jobSource.create({
    data: { label: `${marker}学校就业群`, value: marker, createdBy: userId },
  });
  return {
    userId,
    marker,
    company: { id: company.id, label: company.label },
    title: { id: title.id, label: title.label },
    location: { id: location.id, label: location.label },
    source: { id: source.id, label: source.label },
  };
}

async function seedLegacyJobs(db: PrismaClient, catalog: AcceptanceCatalog) {
  const [newStatus, interviewStatus] = await Promise.all([
    db.jobStatus.findUniqueOrThrow({ where: { value: "new" } }),
    db.jobStatus.findUniqueOrThrow({ where: { value: "interview" } }),
  ]);
  for (let index = 0; index < ACCEPTANCE_JOB_COUNT; index += 1) {
    const row = rowVariation(index);
    await db.job.create({
      data: {
        userId: catalog.userId,
        companyId: catalog.company.id,
        jobTitleId: catalog.title.id,
        locationId: catalog.location.id,
        jobSourceId: catalog.source.id,
        statusId: row.legacyStatus === "new" ? newStatus.id : interviewStatus.id,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)),
        jobType: ACCEPTANCE_JOB_TYPE,
        workplaceType: ACCEPTANCE_WORKPLACE,
        applied: row.applied,
        appliedDate: row.appliedDate,
        description: ACCEPTANCE_DESCRIPTION,
        salaryRange: ACCEPTANCE_SALARY,
      },
    });
  }
}

async function seedAbJobs(db: PrismaClient, catalog: AcceptanceCatalog) {
  const descriptionHash = sha256Utf8(ACCEPTANCE_DESCRIPTION);
  for (let index = 0; index < ACCEPTANCE_JOB_COUNT; index += 1) {
    const row = rowVariation(index);
    const opportunity = await db.jobOpportunity.create({
      data: {
        userId: catalog.userId,
        companyId: catalog.company.id,
        title: catalog.title.label,
        locationText: catalog.location.label,
        employmentType: ACCEPTANCE_JOB_TYPE,
        workplaceType: ACCEPTANCE_WORKPLACE,
        sourceLabel: catalog.source.label,
        salaryText: ACCEPTANCE_SALARY,
        status: OPPORTUNITY_STATUS.UNKNOWN,
        createdVia: "USER",
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)),
      },
    });
    const version = await db.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: opportunity.id,
        versionNumber: 1,
        rawContent: ACCEPTANCE_DESCRIPTION,
        rawContentFormat: "HTML",
        capturedAt: new Date(),
        contentHash: descriptionHash,
        createdVia: "USER",
      },
    });
    await db.jobOpportunity.update({
      where: { id: opportunity.id },
      data: { currentJdVersionId: version.id },
    });
    const attempt = attemptForVisibleStatus(row.abStatus, row.applied, row.appliedDate);
    if (!attempt) continue;
    await db.applicationAttempt.create({
      data: {
        userId: catalog.userId,
        jobOpportunityId: opportunity.id,
        ...attempt,
      },
    });
  }
}

export async function seedMyJobsAcceptanceFixture(
  db: PrismaClient,
  input: SeedInput,
): Promise<SeededAcceptanceJobs> {
  const env = input.env ?? process.env;
  const resolved = await resolveJobsReadFamily(db, env);
  if (resolved.family === "blocked") {
    throw new Error(
      `My Jobs acceptance fixture cannot seed while career runtime is blocked (${resolved.reason}).`,
    );
  }
  const catalog = await createCatalog(db, input.userId, input.marker);
  const seeded: SeededAcceptanceJobs = {
    family: resolved.family,
    catalog,
    ...filterLabels(resolved.family),
  };
  try {
    if (resolved.family === "legacy") await seedLegacyJobs(db, catalog);
    else await seedAbJobs(db, catalog);
    return seeded;
  } catch (error) {
    await cleanupMyJobsAcceptanceFixture(db, seeded);
    throw error;
  }
}

export async function cleanupMyJobsAcceptanceFixture(
  db: PrismaClient,
  seeded: SeededAcceptanceJobs,
) {
  const { userId, company, title, location, source } = seeded.catalog;
  const opportunities = await db.jobOpportunity.findMany({
    where: { userId, companyId: company.id },
    select: { id: true },
  });
  const opportunityIds = opportunities.map((row) => row.id);
  if (opportunityIds.length > 0) {
    await db.applicationAttempt.deleteMany({
      where: { jobOpportunityId: { in: opportunityIds } },
    });
    await db.jobOpportunity.updateMany({
      where: { id: { in: opportunityIds } },
      data: { currentJdVersionId: null },
    });
    await db.jobDescriptionVersion.deleteMany({
      where: { jobOpportunityId: { in: opportunityIds } },
    });
    await db.jobOpportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  }
  await db.job.deleteMany({ where: { userId, companyId: company.id } });
  await db.jobSource.delete({ where: { id: source.id } });
  await db.location.delete({ where: { id: location.id } });
  await db.jobTitle.delete({ where: { id: title.id } });
  await db.company.delete({ where: { id: company.id } });
}
