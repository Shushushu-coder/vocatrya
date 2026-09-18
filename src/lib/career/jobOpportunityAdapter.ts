import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  COMPATIBILITY_PROCESS_STEPS,
  OPPORTUNITY_STATUS,
  PROCESS_STEP_STATUS,
} from "./identities";
import { ApplicationService } from "./applicationService";
import { OpportunityService } from "./opportunityService";

export type JobFormMutationInput = {
  id?: string;
  title: string;
  company: string;
  location?: string | null;
  type: string;
  workplaceType?: string | null;
  source?: string | null;
  status: string;
  dueDate?: Date | null;
  dateApplied?: Date | null;
  salaryRange?: string | null;
  jobDescription: string;
  jobUrl?: string | null;
  applied?: boolean;
  resume?: string | null;
};

type JobStatusRow = { id: string; label: string; value: string };

const PROCESS_STAGE_BY_UI: Record<string, string> = {
  applied: ATTEMPT_STAGE.SUBMITTED,
  interview: ATTEMPT_STAGE.INTERVIEW,
  offer: ATTEMPT_STAGE.OFFER,
  rejected: ATTEMPT_STAGE.CLOSED,
  "offer-accepted": ATTEMPT_STAGE.CLOSED,
  "offer-declined": ATTEMPT_STAGE.CLOSED,
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function requireOwnedTitle(
  db: PrismaClient,
  userId: string,
  jobTitleId: string,
) {
  const row = await db.jobTitle.findFirst({
    where: { id: jobTitleId, createdBy: userId },
    select: { id: true, label: true, value: true, createdBy: true },
  });
  if (!row) {
    throw new CareerRuntimeError("JOB_TITLE_NOT_FOUND", "Job title not found");
  }
  return row;
}

async function optionalOwned(
  db: PrismaClient,
  userId: string,
  id: string | null | undefined,
  kind: "location" | "jobSource",
) {
  if (!id) return null;
  const row =
    kind === "location"
      ? await db.location.findFirst({
          where: { id, createdBy: userId },
          select: { id: true, label: true, value: true, createdBy: true },
        })
      : await db.jobSource.findFirst({
          where: { id, createdBy: userId },
          select: { id: true, label: true, value: true, createdBy: true },
        });
  if (!row) {
    throw new CareerRuntimeError(
      kind === "location" ? "LOCATION_NOT_FOUND" : "JOB_SOURCE_NOT_FOUND",
      `${kind} not found`,
    );
  }
  return row;
}

async function statusById(db: PrismaClient, id: string): Promise<JobStatusRow> {
  const row = await db.jobStatus.findUnique({
    where: { id },
    select: { id: true, label: true, value: true },
  });
  if (!row) {
    throw new CareerRuntimeError("JOB_STATUS_NOT_FOUND", "Job status not found");
  }
  return row;
}

async function statusesByValue(db: PrismaClient): Promise<Map<string, JobStatusRow>> {
  const rows = await db.jobStatus.findMany({
    select: { id: true, label: true, value: true },
  });
  return new Map(rows.map((row) => [row.value, row]));
}

async function syncJdVersion(
  db: PrismaClient,
  opportunityId: string,
  rawContent: string,
  sourceUrl: string | null,
) {
  const hash = sha256Text(rawContent);
  const existing = await db.jobDescriptionVersion.findFirst({
    where: { jobOpportunityId: opportunityId, contentHash: hash },
    select: { id: true },
  });
  if (existing) {
    await db.jobOpportunity.update({
      where: { id: opportunityId },
      data: { currentJdVersionId: existing.id, sourceUrl },
    });
    return;
  }
  const max = await db.jobDescriptionVersion.aggregate({
    where: { jobOpportunityId: opportunityId },
    _max: { versionNumber: true },
  });
  const version = await db.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber: (max._max.versionNumber ?? 0) + 1,
      rawContent,
      rawContentFormat: "HTML",
      sourceUrl,
      capturedAt: new Date(),
      contentHash: hash,
      createdVia: "USER",
    },
  });
  await db.jobOpportunity.update({
    where: { id: opportunityId },
    data: { currentJdVersionId: version.id, sourceUrl },
  });
}

export async function syncApplicationFromUiStatus(
  db: PrismaClient,
  userId: string,
  opportunityId: string,
  uiStatus: string,
  options: {
    applied?: boolean;
    appliedDate?: Date | null;
    sourceUrl?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const applications = new ApplicationService(db, userId, options.env);
  const value = uiStatus.toLowerCase();
  const opportunities = new OpportunityService(db, userId, options.env);

  if (value === "expired") {
    await opportunities.updateSafe(opportunityId, {
      status: OPPORTUNITY_STATUS.EXPIRED,
      closedAt: new Date(),
    });
    return;
  }
  if (value === "archived") {
    await opportunities.updateSafe(opportunityId, { archivedAt: new Date() });
    return;
  }

  const needsAttempt =
    options.applied === true ||
    value === "applied" ||
    value === "interview" ||
    value === "offer" ||
    value === "offer-accepted" ||
    value === "offer-declined" ||
    value === "rejected";

  if (!needsAttempt) {
    return;
  }

  const attempt = await applications.ensureAttempt({
    jobOpportunityId: opportunityId,
    channelLabel: "USER",
    sourceUrl: options.sourceUrl ?? null,
  });

  if (value === "applied" || options.applied === true) {
    await applications.markSubmitted({
      attemptId: attempt.id,
      submittedAt: options.appliedDate ?? undefined,
    });
  }

  const stage = PROCESS_STAGE_BY_UI[value];
  if (stage && stage !== ATTEMPT_STAGE.SUBMITTED) {
    await applications.updateStage(attempt.id, stage);
  }

  if (value === "interview") {
    await applications.ensureCompatibilityProcessStep({
      attemptId: attempt.id,
      category: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.category,
      label: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label,
      sortOrder: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.sortOrder,
      status: PROCESS_STEP_STATUS.IN_PROGRESS,
    });
  } else if (value === "offer" || value === "offer-accepted") {
    await applications.ensureCompatibilityProcessStep({
      attemptId: attempt.id,
      category: COMPATIBILITY_PROCESS_STEPS.OFFER.category,
      label: COMPATIBILITY_PROCESS_STEPS.OFFER.label,
      sortOrder: COMPATIBILITY_PROCESS_STEPS.OFFER.sortOrder,
      status:
        value === "offer-accepted"
          ? PROCESS_STEP_STATUS.COMPLETED
          : PROCESS_STEP_STATUS.IN_PROGRESS,
    });
  }

  if (value === "offer") {
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.OFFER);
  } else if (value === "offer-accepted") {
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.HIRED);
  } else if (value === "offer-declined") {
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.WITHDRAWN);
  } else if (value === "rejected") {
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.REJECTED);
  }
}

function assertNoLegacyResumeBinding(resume: string | null | undefined): void {
  // Job.resumeId has no reliable mapping to ApplicationAttempt.submittedResumeVersionId:
  // legacy resume rows and ResumeVariantVersion rows are disjoint histories, and
  // Job.resumeId was mutable after submit. Never void/ignore/null-map silently.
  if (resume !== undefined && resume !== null && resume !== "") {
    throw new CareerRuntimeError(
      "LEGACY_RESUME_UNSUPPORTED",
      "Legacy Resume cannot be mapped to a ResumeVariantVersion. Re-select an explicit ResumeVariantVersion or submit without resume provenance.",
    );
  }
}

export async function createOpportunityFromJobForm(
  db: PrismaClient,
  userId: string,
  input: JobFormMutationInput,
  env?: NodeJS.ProcessEnv,
) {
  const title = await requireOwnedTitle(db, userId, input.title);
  const location = await optionalOwned(db, userId, input.location, "location");
  const source = await optionalOwned(db, userId, input.source, "jobSource");
  const status = await statusById(db, input.status);
  assertNoLegacyResumeBinding(input.resume);
  return db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    const opportunities = new OpportunityService(client, userId, env);
    const created = await opportunities.create({
      companyId: input.company,
      title: title.label,
      locationText: location?.label ?? null,
      employmentType: input.type,
      workplaceType: input.workplaceType ?? null,
      sourceUrl: input.jobUrl ?? null,
      sourceLabel: source?.label ?? null,
      deadline: input.dueDate ?? null,
      salaryText: input.salaryRange ?? null,
      status: OPPORTUNITY_STATUS.UNKNOWN,
      createdVia: "USER",
    });

    await syncJdVersion(
      client,
      created.id,
      input.jobDescription,
      input.jobUrl ?? null,
    );

    // applied/dateApplied/status are application semantics, not opportunity fields.
    // Map them explicitly via the same compatibility path as update; sync is a
    // no-op when the UI state does not imply an application.
    await syncApplicationFromUiStatus(client, userId, created.id, status.value, {
      applied: input.applied,
      appliedDate: input.dateApplied ?? null,
      sourceUrl: input.jobUrl ?? null,
      env,
    });

    return created;
  });
}

export async function updateOpportunityFromJobForm(
  db: PrismaClient,
  userId: string,
  input: JobFormMutationInput,
  env?: NodeJS.ProcessEnv,
) {
  if (!input.id) {
    throw new CareerRuntimeError("OPPORTUNITY_NOT_FOUND", "Opportunity id is required");
  }
  const title = await requireOwnedTitle(db, userId, input.title);
  const location = await optionalOwned(db, userId, input.location, "location");
  const source = await optionalOwned(db, userId, input.source, "jobSource");
  const status = await statusById(db, input.status);
  return db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    const opportunities = new OpportunityService(client, userId, env);
    const updated = await opportunities.updateSafe(input.id!, {
      companyId: input.company,
      title: title.label,
      locationText: location?.label ?? null,
      employmentType: input.type,
      workplaceType: input.workplaceType ?? null,
      sourceUrl: input.jobUrl ?? null,
      sourceLabel: source?.label ?? null,
      deadline: input.dueDate ?? null,
      salaryText: input.salaryRange ?? null,
    });

    await syncJdVersion(
      client,
      updated.id,
      input.jobDescription,
      input.jobUrl ?? null,
    );
    assertNoLegacyResumeBinding(input.resume);

    await syncApplicationFromUiStatus(client, userId, updated.id, status.value, {
      applied: input.applied,
      appliedDate: input.dateApplied ?? null,
      sourceUrl: input.jobUrl ?? null,
      env,
    });

    return updated;
  });
}

export async function archiveOpportunity(
  db: PrismaClient,
  userId: string,
  opportunityId: string,
  env?: NodeJS.ProcessEnv,
) {
  const opportunities = new OpportunityService(db, userId, env);
  return opportunities.updateSafe(opportunityId, { archivedAt: new Date() });
}

function deriveUiStatus(input: {
  archivedAt: Date | null;
  opportunityStatus: string;
  attempt: {
    currentStageCategory: string;
    outcome: string;
    submittedAt: Date | null;
  } | null;
}): string {
  if (input.archivedAt) return "archived";
  if (input.opportunityStatus === OPPORTUNITY_STATUS.EXPIRED) return "expired";
  const attempt = input.attempt;
  if (!attempt) return "draft";
  if (attempt.outcome === ATTEMPT_OUTCOME.HIRED) return "offer-accepted";
  if (attempt.outcome === ATTEMPT_OUTCOME.WITHDRAWN) return "offer-declined";
  if (attempt.outcome === ATTEMPT_OUTCOME.REJECTED) return "rejected";
  if (attempt.outcome === ATTEMPT_OUTCOME.OFFER) return "offer";
  const stage = attempt.currentStageCategory;
  if (stage === ATTEMPT_STAGE.INTERVIEW || stage === ATTEMPT_STAGE.SCREENING || stage === ATTEMPT_STAGE.ASSESSMENT) {
    return "interview";
  }
  if (stage === ATTEMPT_STAGE.OFFER) return "offer";
  if (stage === ATTEMPT_STAGE.SUBMITTED || attempt.submittedAt) return "applied";
  return "draft";
}

type OpportunityWithRelations = {
  id: string;
  userId: string;
  title: string;
  locationText: string | null;
  employmentType: string | null;
  workplaceType: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  deadline: Date | null;
  salaryText: string | null;
  status: string;
  notes: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  company: {
    id: string;
    label: string;
    value: string;
    createdBy: string;
    logoUrl?: string | null;
  };
  currentJdVersion: { rawContent: string } | null;
  applicationAttempts: Array<{
    currentStageCategory: string;
    outcome: string;
    submittedAt: Date | null;
    createdAt: Date;
  }>;
  _count?: { opportunityNotes: number };
};

type JobViewLookups = {
  statuses: Map<string, JobStatusRow>;
  titles: Map<string, {
    id: string;
    label: string;
    value: string;
    createdBy: string;
  }>;
  locations: Map<string, {
    id: string;
    label: string;
    value: string;
    createdBy: string;
  }>;
  sources: Map<string, {
    id: string;
    label: string;
    value: string;
    createdBy: string;
  }>;
};

async function loadJobViewLookups(
  db: PrismaClient,
  userId: string,
  opportunities: OpportunityWithRelations[],
): Promise<JobViewLookups> {
  const titleLabels = [...new Set(opportunities.map((row) => row.title))];
  const locationLabels = [
    ...new Set(
      opportunities.flatMap((row) =>
        row.locationText ? [row.locationText] : [],
      ),
    ),
  ];
  const sourceLabels = [
    ...new Set(
      opportunities.flatMap((row) =>
        row.sourceLabel ? [row.sourceLabel] : [],
      ),
    ),
  ];
  const [statuses, titles, locations, sources] = await Promise.all([
    statusesByValue(db),
    db.jobTitle.findMany({
      where: { createdBy: userId, label: { in: titleLabels } },
      select: { id: true, label: true, value: true, createdBy: true },
    }),
    db.location.findMany({
      where: { createdBy: userId, label: { in: locationLabels } },
      select: { id: true, label: true, value: true, createdBy: true },
    }),
    db.jobSource.findMany({
      where: { createdBy: userId, label: { in: sourceLabels } },
      select: { id: true, label: true, value: true, createdBy: true },
    }),
  ]);
  return {
    statuses,
    titles: new Map(titles.map((row) => [row.label, row])),
    locations: new Map(locations.map((row) => [row.label, row])),
    sources: new Map(sources.map((row) => [row.label, row])),
  };
}

export function mapOpportunityToJobView(
  userId: string,
  opportunity: OpportunityWithRelations,
  lookups: JobViewLookups,
) {
  const latestAttempt = [...opportunity.applicationAttempts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0] ?? null;
  const uiStatus = deriveUiStatus({
    archivedAt: opportunity.archivedAt,
    opportunityStatus: opportunity.status,
    attempt: latestAttempt,
  });
  const status =
    lookups.statuses.get(uiStatus) ??
    lookups.statuses.get("draft") ?? {
      id: uiStatus,
      label: uiStatus,
      value: uiStatus,
    };

  const jobTitle =
    lookups.titles.get(opportunity.title) ?? {
      id: opportunity.id,
      label: opportunity.title,
      value: opportunity.title,
      createdBy: userId,
    };

  const location = opportunity.locationText
    ? lookups.locations.get(opportunity.locationText) ?? null
    : null;

  const jobSource = opportunity.sourceLabel
    ? lookups.sources.get(opportunity.sourceLabel) ?? null
    : null;

  const applied = Boolean(latestAttempt?.submittedAt);
  // Compatibility projection: legacy Job fields without a reliable A+B mapping
  // are returned as explicit null/empty plus abCompat.unsupported markers.
  // Never fabricate a legacy Resume id from a ResumeVariantVersion id, and never
  // present null as "user never selected a resume" without the unsupported flag:
  // FRESH_READY has no legacy history, while COMPLETED history simply has no
  // provenance mapping by design.
  return {
    id: opportunity.id,
    userId: opportunity.userId,
    JobTitle: jobTitle,
    Company: opportunity.company,
    Status: status,
    Location: location,
    JobSource: jobSource,
    jobType: opportunity.employmentType ?? "full-time",
    workplaceType: opportunity.workplaceType,
    createdAt: opportunity.createdAt,
    appliedDate: latestAttempt?.submittedAt ?? null,
    dueDate: opportunity.deadline ?? opportunity.createdAt,
    salaryRange: opportunity.salaryText,
    description:
      opportunity.currentJdVersion?.rawContent ?? opportunity.notes ?? "",
    jobUrl: opportunity.sourceUrl,
    applied,
    resumeId: null,
    Resume: null,
    coverLetterId: null,
    CoverLetter: null,
    matchScore: null,
    matchData: null,
    tags: [],
    contactLinks: [],
    createdVia: "USER",
    discoveryStatus: null,
    _count: { Notes: opportunity._count?.opportunityNotes ?? 0 },
    abCompat: {
      // Legacy UI status is a projection of attempt state, not authoritative truth.
      uiStatus,
      hasApplicationAttempt: latestAttempt !== null,
      resumeUnsupported: true,
      coverLetterUnsupported: true,
      matchUnsupported: true,
      tagsUnsupported: true,
    },
  };
}

export const OPPORTUNITY_LIST_INCLUDE = {
  company: true,
  currentJdVersion: { select: { rawContent: true } },
  applicationAttempts: {
    where: { archivedAt: null },
    select: {
      currentStageCategory: true,
      outcome: true,
      submittedAt: true,
      createdAt: true,
    },
  },
  _count: { select: { opportunityNotes: true } },
} as const;

export async function listOpportunitiesAsJobs(
  db: PrismaClient,
  userId: string,
  options: {
    skip?: number;
    take?: number;
    includeArchived?: boolean;
    search?: string;
    appliedOnly?: boolean;
    filter?: string;
    companyValue?: string;
    titleValue?: string;
    locationValue?: string;
    sourceValue?: string;
  } = {},
) {
  const [title, location, source] = await Promise.all([
    options.titleValue
      ? db.jobTitle.findFirst({
          where: { createdBy: userId, value: options.titleValue },
          select: { label: true },
        })
      : null,
    options.locationValue
      ? db.location.findFirst({
          where: { createdBy: userId, value: options.locationValue },
          select: { label: true },
        })
      : null,
    options.sourceValue
      ? db.jobSource.findFirst({
          where: { createdBy: userId, value: options.sourceValue },
          select: { label: true },
        })
      : null,
  ]);
  const where: Prisma.JobOpportunityWhereInput = {
    userId,
    ...(options.includeArchived || options.filter === "archived"
      ? {}
      : { archivedAt: null }),
    ...(options.companyValue
      ? { company: { value: options.companyValue } }
      : {}),
    ...(options.titleValue ? { title: title?.label ?? "\0" } : {}),
    ...(options.locationValue
      ? { locationText: location?.label ?? "\0" }
      : {}),
    ...(options.sourceValue ? { sourceLabel: source?.label ?? "\0" } : {}),
    ...(options.appliedOnly
      ? {
          applicationAttempts: {
            some: { archivedAt: null, submittedAt: { not: null } },
          },
        }
      : {}),
    ...opportunityStatusWhere(options.filter),
    ...(options.search
      ? {
          OR: [
            { title: { contains: options.search } },
            { notes: { contains: options.search } },
            { locationText: { contains: options.search } },
            { sourceLabel: { contains: options.search } },
            { company: { label: { contains: options.search } } },
            {
              currentJdVersion: {
                rawContent: { contains: options.search },
              },
            },
          ],
        }
      : {}),
  };
  const skip = options.skip ?? 0;
  const take = options.take;
  const [rows, total] = await Promise.all([
    db.jobOpportunity.findMany({
      where,
      include: OPPORTUNITY_LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip,
      ...(take === undefined ? {} : { take }),
    }),
    db.jobOpportunity.count({ where }),
  ]);
  const lookups = await loadJobViewLookups(db, userId, rows);
  return {
    data: rows.map((row) => mapOpportunityToJobView(userId, row, lookups)),
    total,
  };
}

export async function getOpportunityAsJob(
  db: PrismaClient,
  userId: string,
  id: string,
) {
  const row = await db.jobOpportunity.findFirst({
    where: { id, userId },
    include: OPPORTUNITY_LIST_INCLUDE,
  });
  if (!row) return null;
  const lookups = await loadJobViewLookups(db, userId, [row]);
  return mapOpportunityToJobView(userId, row, lookups);
}

function opportunityStatusWhere(
  filter?: string,
): Prisma.JobOpportunityWhereInput {
  if (!filter) return {};
  if (filter === "archived") return { archivedAt: { not: null } };
  if (filter === "expired") return { status: OPPORTUNITY_STATUS.EXPIRED };
  if (filter === "draft") {
    return {
      applicationAttempts: {
        none: { archivedAt: null },
      },
    };
  }
  if (filter === "applied") {
    return {
      applicationAttempts: {
        some: {
          archivedAt: null,
          submittedAt: { not: null },
          currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
          outcome: ATTEMPT_OUTCOME.ACTIVE,
        },
      },
    };
  }
  if (filter === "interview") {
    return {
      applicationAttempts: {
        some: {
          archivedAt: null,
          currentStageCategory: {
            in: [
              ATTEMPT_STAGE.SCREENING,
              ATTEMPT_STAGE.ASSESSMENT,
              ATTEMPT_STAGE.INTERVIEW,
            ],
          },
          outcome: ATTEMPT_OUTCOME.ACTIVE,
        },
      },
    };
  }
  const outcomeByFilter: Record<string, string> = {
    offer: ATTEMPT_OUTCOME.OFFER,
    rejected: ATTEMPT_OUTCOME.REJECTED,
    "offer-accepted": ATTEMPT_OUTCOME.HIRED,
    "offer-declined": ATTEMPT_OUTCOME.WITHDRAWN,
  };
  if (outcomeByFilter[filter]) {
    return {
      applicationAttempts: {
        some: {
          archivedAt: null,
          outcome: outcomeByFilter[filter],
        },
      },
    };
  }
  return { employmentType: filter };
}
