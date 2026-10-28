import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OPPORTUNITY_STATUS,
} from "./identities";
import { ApplicationService } from "./applicationService";
import {
  normalizeOptionalText,
  OpportunityService,
} from "./opportunityService";
import { isAbHiddenJobFilter } from "./jobsReadCapabilities";
import {
  APPLIED_ATTEMPT_WHERE,
  appliedAttemptExistsSql,
  firstSubmittedAtSql,
  isAppliedAttempt,
} from "./applicationFact";
import {
  deriveUiStatus,
  pickLatestAttempt,
  planUiStatusWrite,
} from "./uiStatus";
import { jobDeadlinePrecision } from "@/lib/jobs/deadlineTime";

export { deriveUiStatus, pickLatestAttempt, planUiStatusWrite } from "./uiStatus";

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
  /** Deadline as "YYYY-MM-DD" (canonical write contract). When defined it
   *  supersedes dueDate; undefined on update leaves the stored triple
   *  untouched — required so an unedited DatePicker can't rewrite a stored
   *  unknown instant with the wall-clock date it happened to show. */
  deadlineOn?: string | null;
  dateApplied?: Date | null;
  salaryRange?: string | null;
  recruitmentCohort?: string | null;
  recruitmentBatch?: string | null;
  jobDescription: string;
  jobUrl?: string | null;
  applied?: boolean;
  resume?: string | null;
};

type JobStatusRow = { id: string; label: string; value: string };

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

export async function syncJdVersion(
  db: Prisma.TransactionClient,
  opportunityId: string,
  rawContent: string,
  sourceUrl: string | null,
  rawContentFormat: "HTML" | "PLAIN_TEXT" = "HTML",
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
      rawContentFormat,
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
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!tx) {
    return db.$transaction((transaction) => syncApplicationFromUiStatus(db, userId, opportunityId, uiStatus, options, transaction));
  }
  const applications = new ApplicationService(db, userId, options.env);
  const opportunities = new OpportunityService(tx, userId, options.env);
  const plan = planUiStatusWrite(uiStatus);

  if (plan.kind === "expire-opportunity") {
    await opportunities.updateSafe(opportunityId, {
      status: OPPORTUNITY_STATUS.EXPIRED,
      closedAt: new Date(),
    });
    return;
  }
  if (plan.kind === "archive-opportunity") {
    await opportunities.updateSafe(opportunityId, { archivedAt: new Date() });
    return;
  }

  const needsAttempt = plan.kind === "attempt" || options.applied === true;
  if (!needsAttempt) {
    return;
  }

  const attempt = await applications.ensureAttempt({
    jobOpportunityId: opportunityId,
    channelLabel: "USER",
    sourceUrl: options.sourceUrl ?? null,
  }, tx);

  const shouldMarkSubmitted =
    (plan.kind === "attempt" && plan.markSubmitted) || options.applied === true;
  const initialSubmission = shouldMarkSubmitted && attempt.currentStageCategory === ATTEMPT_STAGE.DRAFT && attempt.outcome === ATTEMPT_OUTCOME.ACTIVE && attempt.submittedAt === null && attempt.archivedAt === null;
  if (initialSubmission) {
    await applications.submitApplicationInTransaction(tx, {
      attemptId: attempt.id,
      submittedAt: options.appliedDate ?? undefined,
    });
  }

  if (plan.kind === "attempt") {
    const alreadyAtStage =
      shouldMarkSubmitted &&
      plan.currentStageCategory === ATTEMPT_STAGE.SUBMITTED;
    if (!alreadyAtStage) {
      await applications.updateStage(attempt.id, plan.currentStageCategory, tx);
    }
    await applications.recordOutcome(attempt.id, plan.outcome, tx);
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
    const client = tx;
    const opportunities = new OpportunityService(client, userId, env);
    const created = await opportunities.create({
      companyId: input.company,
      title: title.label,
      locationText: location?.label ?? null,
      employmentType: input.type,
      workplaceType: input.workplaceType ?? null,
      sourceUrl: input.jobUrl ?? null,
      sourceLabel: source?.label ?? null,
      deadlineOn: input.deadlineOn,
      deadline: input.dueDate ?? null,
      recruitmentCohort: normalizeOptionalText(input.recruitmentCohort) ?? null,
      recruitmentBatch: normalizeOptionalText(input.recruitmentBatch) ?? null,
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
    // Map them onto ApplicationAttempt stage/outcome; this is a no-op when the
    // UI state does not imply an application.
    await syncApplicationFromUiStatus(db, userId, created.id, status.value, {
      applied: input.applied,
      appliedDate: input.dateApplied ?? null,
      sourceUrl: input.jobUrl ?? null,
      env,
    }, tx);

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
    const client = tx;
    const opportunities = new OpportunityService(client, userId, env);
    const updated = await opportunities.updateSafe(input.id!, {
      companyId: input.company,
      title: title.label,
      locationText: location?.label ?? null,
      employmentType: input.type,
      workplaceType: input.workplaceType ?? null,
      sourceUrl: input.jobUrl ?? null,
      sourceLabel: source?.label ?? null,
      deadlineOn: input.deadlineOn,
      // The instant carrier only flows when no dateOnly contract was sent —
      // updateSafe treats deadlineOn-defined as the whole deadline write.
      deadline: input.dueDate,
      recruitmentCohort:
        input.recruitmentCohort === undefined
          ? undefined
          : (normalizeOptionalText(input.recruitmentCohort) ?? null),
      recruitmentBatch:
        input.recruitmentBatch === undefined
          ? undefined
          : (normalizeOptionalText(input.recruitmentBatch) ?? null),
      salaryText: input.salaryRange ?? null,
    });

    await syncJdVersion(
      client,
      updated.id,
      input.jobDescription,
      input.jobUrl ?? null,
    );
    assertNoLegacyResumeBinding(input.resume);

    await syncApplicationFromUiStatus(db, userId, updated.id, status.value, {
      applied: input.applied,
      appliedDate: input.dateApplied ?? null,
      sourceUrl: input.jobUrl ?? null,
      env,
    }, tx);

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
  deadlineOn: string | null;
  deadlinePrecision: string | null;
  recruitmentCohort: string | null;
  recruitmentBatch: string | null;
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
  currentJdVersion: { rawContent: string; rawContentFormat?: string } | null;
  applicationAttempts: Array<{
    id: string;
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
  const latestAttempt = pickLatestAttempt(opportunity.applicationAttempts);
  const uiStatus = deriveUiStatus({
    archivedAt: opportunity.archivedAt,
    opportunityStatus: opportunity.status,
    attempt: latestAttempt,
  });
  const status =
    uiStatus === "transferred"
      ? { id: "transferred", label: "Transferred", value: "transferred" }
      : lookups.statuses.get(uiStatus) ??
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

  // The applied fact is decoupled from the latest attempt's stage: it holds
  // when ANY live attempt has a real submission timestamp OR a post-DRAFT
  // stage (isAppliedAttempt — the shared ever-applied contract). appliedDate
  // is a separate dimension: always the first real submission
  // (MIN(submittedAt)), staying null for stage-only applied history. A newer
  // draft attempt therefore cannot erase earlier application history, and no
  // date is ever inferred from createdAt or a stage alone. The list include
  // already filters archivedAt, so every attempt here is live.
  let firstSubmittedAt: Date | null = null;
  let applied = false;
  for (const attempt of opportunity.applicationAttempts) {
    if (isAppliedAttempt(attempt)) {
      applied = true;
    }
    if (
      attempt.submittedAt &&
      (firstSubmittedAt === null || attempt.submittedAt < firstSubmittedAt)
    ) {
      firstSubmittedAt = attempt.submittedAt;
    }
  }
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
    jobType: opportunity.employmentType ?? "",
    workplaceType: opportunity.workplaceType,
    createdAt: opportunity.createdAt,
    appliedDate: firstSubmittedAt,
    // dueDate stays the instant-carrier compat projection: null on a pure
    // dateOnly row — consumers read the real deadline through the triple.
    dueDate: opportunity.deadline ?? null,
    deadlineOn: opportunity.deadlineOn ?? null,
    deadlinePrecision: jobDeadlinePrecision({
      deadlineOn: opportunity.deadlineOn,
      dueDate: opportunity.deadline,
      deadlinePrecision: opportunity.deadlinePrecision,
    }),
    recruitmentCohort: opportunity.recruitmentCohort ?? null,
    recruitmentBatch: opportunity.recruitmentBatch ?? null,
    salaryRange: opportunity.salaryText,
    description: opportunity.currentJdVersion?.rawContent ?? opportunity.notes ?? "",
    descriptionFormat: opportunity.currentJdVersion?.rawContentFormat,
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

// A+B "applied" = the position has at least one live attempt that either
// carried a real submission (submittedAt set) or already moved past DRAFT —
// the shared ever-applied fact (APPLIED_ATTEMPT_WHERE), stage-aware so
// migrated attempts whose submission timestamp was never recorded still
// count. `some` counts the opportunity once no matter how many attempts
// went out, and a later draft attempt never erases an earlier submission.
export const AB_APPLIED_OPPORTUNITY_WHERE = {
  archivedAt: null,
  applicationAttempts: {
    some: APPLIED_ATTEMPT_WHERE,
  },
};

export const OPPORTUNITY_LIST_INCLUDE = {
  company: true,
  currentJdVersion: { select: { rawContent: true, rawContentFormat: true } },
  applicationAttempts: {
    where: { archivedAt: null },
    select: {
      id: true,
      currentStageCategory: true,
      outcome: true,
      submittedAt: true,
      createdAt: true,
    },
  },
  _count: { select: { opportunityNotes: true } },
} as const;

// Stage-derived filters only. "applied" is deliberately absent: it is the
// ever-applied fact (any live attempt submitted or past DRAFT), not a stage
// of the latest attempt.
const DERIVED_UI_STATUS_FILTERS = new Set([
  "draft",
  "interview",
  "offer",
  "rejected",
  "offer-accepted",
  "offer-declined",
  "transferred",
]);

type OpportunityListOptions = {
  skip?: number;
  take?: number;
  includeArchived?: boolean;
  search?: string;
  appliedOnly?: boolean;
  filter?: string;
  orderBy?: "createdAtDesc" | "firstSubmittedAtDesc";
  companyId?: string;
  companyValue?: string;
  titleValue?: string;
  locationValue?: string;
  sourceValue?: string;
};

function derivedUiStatusSql() {
  return Prisma.sql`
    CASE
      WHEN o.archivedAt IS NOT NULL THEN 'archived'
      WHEN o.status = ${OPPORTUNITY_STATUS.EXPIRED} THEN 'expired'
      WHEN latest.id IS NULL THEN 'draft'
      WHEN latest.outcome = ${ATTEMPT_OUTCOME.HIRED} THEN 'offer-accepted'
      WHEN latest.outcome = ${ATTEMPT_OUTCOME.WITHDRAWN} THEN 'offer-declined'
      WHEN latest.outcome = ${ATTEMPT_OUTCOME.REJECTED} THEN 'rejected'
      WHEN latest.outcome = ${ATTEMPT_OUTCOME.TRANSFERRED} THEN 'transferred'
      WHEN latest.outcome = ${ATTEMPT_OUTCOME.OFFER} THEN 'offer'
      WHEN latest.currentStageCategory IN (
        ${ATTEMPT_STAGE.INTERVIEW},
        ${ATTEMPT_STAGE.SCREENING},
        ${ATTEMPT_STAGE.ASSESSMENT}
      ) THEN 'interview'
      WHEN latest.currentStageCategory = ${ATTEMPT_STAGE.OFFER} THEN 'offer'
      WHEN latest.currentStageCategory = ${ATTEMPT_STAGE.SUBMITTED}
        OR latest.submittedAt IS NOT NULL THEN 'applied'
      ELSE 'draft'
    END
  `;
}

function latestAttemptJoinSql() {
  return Prisma.sql`
    LEFT JOIN "ApplicationAttempt" latest ON latest.id = (
      SELECT a.id FROM "ApplicationAttempt" a
      WHERE a.jobOpportunityId = o.id AND a.archivedAt IS NULL
      ORDER BY COALESCE(a.submittedAt, a.createdAt) DESC,
        a.createdAt DESC,
        a.id DESC
      LIMIT 1
    )
  `;
}

// One shared "ever applied" fact: at least one live (non-archived) attempt
// that was really submitted OR already sits at a post-DRAFT stage. Same
// contract as APPLIED_ATTEMPT_WHERE in src/lib/career/applicationFact.ts,
// which also backs AB_APPLIED_OPPORTUNITY_WHERE above.

function opportunityListWhereSql(
  userId: string,
  options: OpportunityListOptions,
  labels: {
    title: string | null;
    location: string | null;
    source: string | null;
  },
) {
  const parts: Prisma.Sql[] = [Prisma.sql`o.userId = ${userId}`];
  if (!options.includeArchived && options.filter !== "archived") {
    parts.push(Prisma.sql`o.archivedAt IS NULL`);
  }
  if (options.filter === "archived") {
    parts.push(Prisma.sql`o.archivedAt IS NOT NULL`);
  }
  if (options.filter === "expired") {
    parts.push(Prisma.sql`o.status = ${OPPORTUNITY_STATUS.EXPIRED}`);
  }
  if (options.companyId) {
    parts.push(Prisma.sql`o.companyId = ${options.companyId}`);
  }
  if (options.companyValue) {
    parts.push(Prisma.sql`c.value = ${options.companyValue}`);
  }
  if (options.titleValue) {
    parts.push(Prisma.sql`o.title = ${labels.title ?? "\0"}`);
  }
  if (options.locationValue) {
    parts.push(Prisma.sql`o.locationText = ${labels.location ?? "\0"}`);
  }
  if (options.sourceValue) {
    parts.push(Prisma.sql`o.sourceLabel = ${labels.source ?? "\0"}`);
  }
  // appliedOnly and filter="applied" are the same fact filter: the position
  // counts as applied when any live attempt was submitted or reached a
  // post-DRAFT stage. A later draft attempt must not hide earlier history,
  // and a position with several attempts still counts once.
  if (options.appliedOnly || options.filter === "applied") {
    parts.push(appliedAttemptExistsSql());
  }
  if (options.filter && DERIVED_UI_STATUS_FILTERS.has(options.filter)) {
    parts.push(Prisma.sql`(${derivedUiStatusSql()}) = ${options.filter}`);
  } else if (
    options.filter &&
    options.filter !== "applied" &&
    options.filter !== "archived" &&
    options.filter !== "expired" &&
    !isAbHiddenJobFilter(options.filter)
  ) {
    parts.push(Prisma.sql`o.employmentType = ${options.filter}`);
  }
  if (options.search) {
    const q = `%${options.search}%`;
    parts.push(Prisma.sql`(
      o.title LIKE ${q}
      OR IFNULL(o.notes, '') LIKE ${q}
      OR IFNULL(o.locationText, '') LIKE ${q}
      OR IFNULL(o.sourceLabel, '') LIKE ${q}
      OR IFNULL(o.recruitmentCohort, '') LIKE ${q}
      OR IFNULL(o.recruitmentBatch, '') LIKE ${q}
      OR c.label LIKE ${q}
      OR IFNULL(jdv.rawContent, '') LIKE ${q}
    )`);
  }
  return Prisma.join(parts, " AND ");
}

async function resolveListLabels(
  db: PrismaClient,
  userId: string,
  options: OpportunityListOptions,
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
  return {
    title: title?.label ?? null,
    location: location?.label ?? null,
    source: source?.label ?? null,
  };
}

export async function listOpportunitiesAsJobs(
  db: PrismaClient,
  userId: string,
  options: OpportunityListOptions = {},
) {
  if (options.filter && isAbHiddenJobFilter(options.filter)) {
    return { data: [], total: 0 };
  }
  const labels = await resolveListLabels(db, userId, options);
  const whereSql = opportunityListWhereSql(userId, options, labels);
  const skip = options.skip ?? 0;
  const take = options.take;
  const fromSql = Prisma.sql`
    FROM "JobOpportunity" o
    INNER JOIN "Company" c ON c.id = o.companyId
    LEFT JOIN "JobDescriptionVersion" jdv ON jdv.id = o.currentJdVersionId
    ${latestAttemptJoinSql()}
    WHERE ${whereSql}
  `;
  const countRows = await db.$queryRaw<Array<{ n: number | bigint }>>(
    Prisma.sql`SELECT COUNT(*) as n ${fromSql}`,
  );
  const total = Number(countRows[0]?.n ?? 0);
  // "firstSubmittedAtDesc" ranks by MIN(submittedAt) of live attempts — the
  // same first-application date legacy reads order applied jobs by. Stage-only
  // applied rows (no real submittedAt) sort NULL-last and keep a null date.
  const orderSql =
    options.orderBy === "firstSubmittedAtDesc"
      ? Prisma.sql`ORDER BY ${firstSubmittedAtSql()} DESC, o.createdAt DESC`
      : Prisma.sql`ORDER BY o.createdAt DESC`;
  const idSql =
    take === undefined
      ? Prisma.sql`
          SELECT o.id
          ${fromSql}
          ${orderSql}
        `
      : Prisma.sql`
          SELECT o.id
          ${fromSql}
          ${orderSql}
          LIMIT ${take} OFFSET ${skip}
        `;
  const idRows = await db.$queryRaw<Array<{ id: string }>>(idSql);
  const ids = idRows.map((row) => row.id);
  if (ids.length === 0) {
    return { data: [], total };
  }
  const rows = await db.jobOpportunity.findMany({
    where: { id: { in: ids }, userId },
    include: OPPORTUNITY_LIST_INCLUDE,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const lookups = await loadJobViewLookups(db, userId, ordered);
  return {
    data: ordered.map((row) => mapOpportunityToJobView(userId, row, lookups)),
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
