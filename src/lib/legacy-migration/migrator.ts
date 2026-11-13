/**
 * Vocatrya A+B Phase 3 — idempotent legacy backfill engine.
 *
 * Writes only happen when mode=migrate and the target is a disposable copy
 * that passed Phase 2 preflight. Per-legacy-root transactions keep partial
 * graphs from being recorded as successful mappings.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  classifyJobLifecycleCombo,
  detectDuplicateCandidates,
  gatherDuplicateSourceRows,
  gatherInventory,
  openReadOnlySqlite,
  snapshotFile,
  type AttemptOutcome,
  type AttemptStage,
} from "./phase2Auditor";
import {
  LEGACY,
  isCandidateProfileTarget,
  PHASE3_CREATED_VIA,
  PHASE3_MIGRATION_VERSION,
  TARGET,
  UNSPECIFIED_CHANNEL_LABEL,
} from "./identities";
import {
  contactHeaderSnapshot,
  resolveContactProfile,
  type LegacyContactRow,
} from "./contact";
import { runWritablePreflight } from "./preflight";
import { assertWritableTargetAllowed } from "./safety";
import {
  EMPTY_COUNT_BUCKET,
  type CountBucket,
  type MigratorHooks,
  type MigrationMode,
  type Phase3Report,
  type RootError,
  type RunMigrateOptions,
} from "./types";
import { checkLegacyRootCoverage } from "@/lib/career/integrity";
import {
  AB_MIGRATION_STATUS,
} from "@/lib/career/identities";
import { writeInstanceMigrationState } from "@/lib/career/migrationState";

type Tx = Prisma.TransactionClient;

const TX_OPTS = { timeout: 60_000, maxWait: 20_000 } as const;

const RESUME_LAYOUT_CONFIG = JSON.stringify({
  historicalCrossSectionOrder: "ORDER_UNRECOVERABLE",
  sortOrderSemantics: "unspecified_not_historical_layout",
  skillItemOrder: "preserved_from_Skill.order_when_valid",
});

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashId(value: string): string {
  return sha256Text(value).slice(0, 12);
}

function fileUrl(dbPath: string): string {
  const abs = path.resolve(dbPath).replace(/\\/g, "/");
  return abs.startsWith("file:") ? abs : `file:${abs}`;
}

function bump(bucket: CountBucket, key: keyof CountBucket, n = 1): void {
  bucket[key] += n;
}

async function findMapping(
  tx: Tx,
  input: {
    userId: string;
    legacyEntityType: string;
    legacyEntityId: string;
    targetEntityType: string;
  },
) {
  const rows = await tx.legacyMigrationMap.findMany({
    where: {
      userId: input.userId,
      legacyEntityType: input.legacyEntityType,
      legacyEntityId: input.legacyEntityId,
      targetEntityType: input.targetEntityType,
      migrationVersion: PHASE3_MIGRATION_VERSION,
    },
  });
  if (rows.length > 1) {
    throw new Error(
      `DUPLICATE_MAPPING ${input.legacyEntityType}:${input.legacyEntityId} -> ${input.targetEntityType}`,
    );
  }
  return rows[0] ?? null;
}

async function findContactProfileMapping(
  client: Tx | PrismaClient,
  userId: string,
) {
  const rows = await client.legacyMigrationMap.findMany({
    where: {
      userId,
      legacyEntityType: LEGACY.USER_CONTACT_INFO,
      legacyEntityId: userId,
      migrationVersion: PHASE3_MIGRATION_VERSION,
    },
  });
  const matches = rows.filter((row) =>
    isCandidateProfileTarget(row.targetEntityType),
  );
  if (matches.length > 1) {
    throw new Error(
      `DUPLICATE_MAPPING ${LEGACY.USER_CONTACT_INFO}:${userId} -> CandidateProfile`,
    );
  }
  return matches[0] ?? null;
}

async function writeMapping(
  tx: Tx,
  input: {
    userId: string;
    legacyEntityType: string;
    legacyEntityId: string;
    targetEntityType: string;
    targetEntityId: string;
    mappingReason: string;
  },
): Promise<void> {
  await tx.legacyMigrationMap.create({
    data: {
      userId: input.userId,
      legacyEntityType: input.legacyEntityType,
      legacyEntityId: input.legacyEntityId,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      migrationVersion: PHASE3_MIGRATION_VERSION,
      mappingReason: input.mappingReason,
    },
  });
}

function processCategory(stage: AttemptStage): string | null {
  if (!stage) return null;
  if (stage === "REJECTED") return "CLOSED";
  return stage;
}

function emptyDescription(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

function nonemptyText(value: string | null | undefined): value is string {
  return !emptyDescription(value);
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildEmptyReport(
  options: RunMigrateOptions,
  extras: Partial<Phase3Report> = {},
): Phase3Report {
  const integrity = fs.existsSync(options.dbPath)
    ? snapshotFile(options.dbPath)
    : { path: options.dbPath, exists: false, size: null, lastWriteTimeUtc: null, sha256: null };
  return {
    migrationVersion: PHASE3_MIGRATION_VERSION,
    sourceIdentity: {
      path: path.resolve(options.dbPath),
      sha256: integrity.sha256,
      size: integrity.size,
    },
    mode: options.mode,
    runId: null,
    preflight: { ok: false, blockers: [], phase2Status: null },
    writableGate: null,
    legacyCounts: {},
    created: EMPTY_COUNT_BUCKET(),
    skippedAlreadyMigrated: EMPTY_COUNT_BUCKET(),
    skippedUnsafe: EMPTY_COUNT_BUCKET(),
    failed: EMPTY_COUNT_BUCKET(),
    unknownStatuses: [],
    contactConflicts: [],
    duplicateCandidates: { automaticMerges: 0, groupCount: 0, memberCount: 0 },
    orderingLimitations: [
      "Resume cross-section visual order is ORDER_UNRECOVERABLE and was not reconstructed.",
    ],
    writeCount: 0,
    bookkeepingWriteCount: 0,
    unexpectedUpdates: 0,
    duplicated: 0,
    errors: [],
    phaseResult: "BLOCKED",
    REAL_USER_DATA_MUTATED: "NO",
    PRODUCTION_BACKFILL_EXECUTED: "NO",
    ...extras,
  };
}

function sumBucket(bucket: CountBucket): number {
  return Object.values(bucket).reduce((a, b) => a + b, 0);
}

export async function runLegacyMigration(
  options: RunMigrateOptions,
): Promise<Phase3Report> {
  const mode: MigrationMode = options.mode;
  if (mode !== "migrate") {
    const preflight = runWritablePreflight({
      repoRoot: options.repoRoot,
      dbPath: options.dbPath,
    });
    const inventory = preflight.report.legacy_inventory;
    const dups = preflight.report.career_material_duplicate_candidates;
    return buildEmptyReport(options, {
      preflight: {
        ok: preflight.ok,
        blockers: preflight.blockers,
        phase2Status: preflight.report.acceptance.PHASE2_AUDIT_STATUS,
      },
      legacyCounts: inventory,
      duplicateCandidates: {
        automaticMerges: 0,
        groupCount: dups.groupCount,
        memberCount: dups.memberCount,
      },
      unknownStatuses: preflight.report.phase3_blockers,
      writeCount: 0,
      bookkeepingWriteCount: 0,
      phaseResult: preflight.ok ? "PASS" : "BLOCKED",
    });
  }

  if (!fs.existsSync(options.dbPath)) {
    return buildEmptyReport(options, {
      preflight: {
        ok: false,
        blockers: [`database file missing: ${options.dbPath}`],
        phase2Status: null,
      },
      phaseResult: "BLOCKED",
    });
  }

  const gate = assertWritableTargetAllowed({
    dbPath: options.dbPath,
    repoRoot: options.repoRoot,
    confirmWritable: Boolean(options.confirmWritable),
    allowDisposableCopy: Boolean(options.allowDisposableCopy),
    forceRequested: Boolean(options.forceRequested),
    env: options.env,
  });
  if (!gate.allowed) {
    return buildEmptyReport(options, {
      writableGate: gate,
      preflight: { ok: false, blockers: [gate.reason], phase2Status: null },
      phaseResult: "BLOCKED",
    });
  }

  const preflight = runWritablePreflight({
    repoRoot: options.repoRoot,
    dbPath: options.dbPath,
  });
  if (!preflight.ok) {
    return buildEmptyReport(options, {
      writableGate: gate,
      preflight: {
        ok: false,
        blockers: preflight.blockers,
        phase2Status: preflight.report.acceptance.PHASE2_AUDIT_STATUS,
      },
      legacyCounts: preflight.report.legacy_inventory,
      unknownStatuses: preflight.report.phase3_blockers,
      phaseResult: "BLOCKED",
    });
  }

  const before = snapshotFile(options.dbPath);
  const prisma = new PrismaClient({
    datasources: { db: { url: fileUrl(options.dbPath) } },
  });

  const created = EMPTY_COUNT_BUCKET();
  const skippedAlreadyMigrated = EMPTY_COUNT_BUCKET();
  const skippedUnsafe = EMPTY_COUNT_BUCKET();
  const failed = EMPTY_COUNT_BUCKET();
  const errors: RootError[] = [];
  const unknownStatuses: string[] = [];
  const contactConflicts: Phase3Report["contactConflicts"] = [];
  const writeCount = { value: 0 };
  let bookkeepingWriteCount = 0;
  let runId: string | null = null;

  const accBase = {
    created,
    skippedAlreadyMigrated,
    skippedUnsafe,
    failed,
    errors,
    writeCount,
    countWrite: (bucket: CountBucket, key: keyof CountBucket) => {
      bump(bucket, key);
      if (key === "mappings") return;
      writeCount.value += 1;
    },
  };

  try {
    const run = await prisma.dataMigrationRun.create({
      data: {
        version: PHASE3_MIGRATION_VERSION,
        mode: "migrate",
        status: "RUNNING",
        counts: JSON.stringify({
          sourceSha256: before.sha256,
          sourceSize: before.size,
          sourcePath: path.resolve(options.dbPath),
        }),
      },
    });
    runId = run.id;
    bookkeepingWriteCount += 1;
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
      completedAt: null,
      verifiedAt: null,
      errorCode: null,
    });
    bookkeepingWriteCount += 1;

    const ro = openReadOnlySqlite(options.dbPath);
    let inventory: Record<string, number> = {};
    let duplicateCandidates = {
      automaticMerges: 0 as const,
      groupCount: 0,
      memberCount: 0,
    };
    try {
      inventory = gatherInventory(ro);
      const dups = detectDuplicateCandidates(gatherDuplicateSourceRows(ro));
      duplicateCandidates = {
        automaticMerges: 0,
        groupCount: dups.groups.length,
        memberCount: dups.groups.reduce((a, g) => a + g.size, 0),
      };
    } finally {
      ro.close();
    }

    await migrateCareerMaterials(prisma, options.hooks, accBase);
    await migrateResumes(prisma, options.hooks, accBase);
    await migrateJobs(prisma, options.hooks, {
      ...accBase,
      unknownStatuses,
    });
    await migrateContactProfiles(prisma, {
      ...accBase,
      contactConflicts,
    });

    const failedTotal = sumBucket(failed);
    const coverage =
      failedTotal === 0 ? await checkLegacyRootCoverage(prisma) : null;
    const integrityOk = coverage?.ok === true;
    const completed = failedTotal === 0 && integrityOk;
    const status = completed ? "COMPLETED" : "FAILED";
    const errorCode = failedTotal > 0
      ? "ROOT_FAILURE"
      : integrityOk
        ? null
        : coverage?.code ?? "INTEGRITY_FAILED";
    const now = new Date();
    const reportCounts = {
      migrationVersion: PHASE3_MIGRATION_VERSION,
      sourceSha256: before.sha256,
      mode: "migrate",
      created,
      skippedAlreadyMigrated,
      skippedUnsafe,
      failed,
      writeCount: writeCount.value,
      unknownStatuses,
      contactConflictCount: contactConflicts.length,
      duplicateCandidates,
      ordering: "ORDER_UNRECOVERABLE",
      errorCount: errors.length,
      integrityCode: errorCode,
    };
    await prisma.dataMigrationRun.update({
      where: { id: run.id },
      data: {
        status,
        completedAt: now,
        errorCode,
        counts: JSON.stringify(reportCounts),
      },
    });
    bookkeepingWriteCount += 1;
    await writeInstanceMigrationState(prisma, {
      status: completed
        ? AB_MIGRATION_STATUS.COMPLETED
        : AB_MIGRATION_STATUS.FAILED,
      completedAt: completed ? now : now,
      verifiedAt: completed ? now : null,
      errorCode,
    });
    bookkeepingWriteCount += 1;

    return {
      migrationVersion: PHASE3_MIGRATION_VERSION,
      sourceIdentity: {
        path: path.resolve(options.dbPath),
        sha256: before.sha256,
        size: before.size,
      },
      mode: "migrate",
      runId,
      preflight: {
        ok: true,
        blockers: [],
        phase2Status: preflight.report.acceptance.PHASE2_AUDIT_STATUS,
      },
      writableGate: gate,
      legacyCounts: inventory,
      created,
      skippedAlreadyMigrated,
      skippedUnsafe,
      failed,
      unknownStatuses,
      contactConflicts,
      duplicateCandidates,
      orderingLimitations: [
        "Resume cross-section visual order is ORDER_UNRECOVERABLE and was not reconstructed.",
      ],
      writeCount: writeCount.value,
      bookkeepingWriteCount,
      unexpectedUpdates: 0,
      duplicated: 0,
      errors,
      phaseResult: completed ? "PASS" : "FAILED",
      REAL_USER_DATA_MUTATED: "NO",
      PRODUCTION_BACKFILL_EXECUTED: "NO",
    };
  } catch (err) {
    if (runId) {
      try {
        await prisma.dataMigrationRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errorCode: "ENGINE_FAILURE",
            counts: JSON.stringify({ message: String(err).slice(0, 500) }),
          },
        });
        bookkeepingWriteCount += 1;
        try {
          await writeInstanceMigrationState(prisma, {
            status: AB_MIGRATION_STATUS.FAILED,
            completedAt: new Date(),
            verifiedAt: null,
            errorCode: "ENGINE_FAILURE",
          });
          bookkeepingWriteCount += 1;
        } catch {
          // keep original error
        }
      } catch {
        // keep original error
      }
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

type Acc = {
  created: CountBucket;
  skippedAlreadyMigrated: CountBucket;
  skippedUnsafe: CountBucket;
  failed: CountBucket;
  errors: RootError[];
  unknownStatuses?: string[];
  contactConflicts?: Phase3Report["contactConflicts"];
  writeCount: { value: number };
  countWrite: (bucket: CountBucket, key: keyof CountBucket) => void;
};

function cloneBucket(bucket: CountBucket): CountBucket {
  return { ...bucket };
}

function restoreBucket(target: CountBucket, source: CountBucket): void {
  (Object.keys(source) as Array<keyof CountBucket>).forEach((key) => {
    target[key] = source[key];
  });
}

function snapshotAcc(acc: Acc): {
  created: CountBucket;
  skippedAlreadyMigrated: CountBucket;
  skippedUnsafe: CountBucket;
  writeCount: number;
  errorCount: number;
  unknownCount: number;
} {
  return {
    created: cloneBucket(acc.created),
    skippedAlreadyMigrated: cloneBucket(acc.skippedAlreadyMigrated),
    skippedUnsafe: cloneBucket(acc.skippedUnsafe),
    writeCount: acc.writeCount.value,
    errorCount: acc.errors.length,
    unknownCount: acc.unknownStatuses?.length ?? 0,
  };
}

function restoreAcc(
  acc: Acc,
  snap: ReturnType<typeof snapshotAcc>,
): void {
  restoreBucket(acc.created, snap.created);
  restoreBucket(acc.skippedAlreadyMigrated, snap.skippedAlreadyMigrated);
  restoreBucket(acc.skippedUnsafe, snap.skippedUnsafe);
  acc.writeCount.value = snap.writeCount;
  acc.errors.length = snap.errorCount;
  if (acc.unknownStatuses) acc.unknownStatuses.length = snap.unknownCount;
}

async function migrateJobs(
  prisma: PrismaClient,
  hooks: MigratorHooks | undefined,
  acc: Acc,
): Promise<void> {
  const jobs = await prisma.job.findMany({
    include: {
      Status: true,
      JobTitle: true,
      JobSource: true,
      Location: true,
      Notes: true,
    },
  });

  for (const job of jobs) {
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        await migrateJobRoot(tx, job, hooks, acc);
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "opportunities");
      acc.errors.push({
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        code: "JOB_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }
}

type JobRow = Prisma.JobGetPayload<{
  include: {
    Status: true;
    JobTitle: true;
    JobSource: true;
    Location: true;
    Notes: true;
  };
}>;

async function migrateJobRoot(
  tx: Tx,
  job: JobRow,
  hooks: MigratorHooks | undefined,
  acc: Acc,
): Promise<void> {
  const statusValue = (job.Status?.value || "").toLowerCase();
  const lifecycle = classifyJobLifecycleCombo({
    statusValue,
    applied: job.applied,
    appliedDatePresent: job.appliedDate != null,
  });

  if (!lifecycle.createOpportunity) {
    const existingUnknown = await findMapping(tx, {
      userId: job.userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      targetEntityType: TARGET.UNMAPPED_UNKNOWN_STATUS,
    });
    if (!existingUnknown) {
      await writeMapping(tx, {
        userId: job.userId,
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        targetEntityType: TARGET.UNMAPPED_UNKNOWN_STATUS,
        targetEntityId: job.id,
        mappingReason: `UNMAPPED_UNKNOWN_STATUS value=${statusValue || "(null)"}`,
      });
      acc.countWrite(acc.created, "mappings");
    } else {
      acc.countWrite(acc.skippedAlreadyMigrated, "mappings");
    }
    bump(acc.skippedUnsafe, "opportunities");
    acc.unknownStatuses?.push(statusValue || "(null)");
    acc.errors.push({
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      code: "UNMAPPED_UNKNOWN_STATUS",
      message: `Skipped Job; unknown status ${statusValue || "(null)"}`,
    });
    return;
  }

  const existingOpp = await findMapping(tx, {
    userId: job.userId,
    legacyEntityType: LEGACY.JOB,
    legacyEntityId: job.id,
    targetEntityType: TARGET.JOB_OPPORTUNITY,
  });

  let opportunityId: string;
  if (existingOpp) {
    opportunityId = existingOpp.targetEntityId;
    bump(acc.skippedAlreadyMigrated, "opportunities");
  } else {
    const opportunity = await tx.jobOpportunity.create({
      data: {
        userId: job.userId,
        companyId: job.companyId,
        campaignId: null,
        title: job.JobTitle.label,
        locationText: job.Location?.label ?? null,
        employmentType: job.jobType,
        workplaceType: job.workplaceType,
        sourceSystem: null,
        sourceLabel: job.JobSource?.label ?? null,
        sourceUrl: job.jobUrl,
        deadline: job.dueDate,
        salaryText: job.salaryRange,
        status: lifecycle.opportunityStatus,
        sourceAutomationId: job.automationId,
        discoveredAt: job.discoveredAt,
        archivedAt: null,
        // UI-RC-JOB-ORDER: carry the legacy ordering/pin facts so a user's
        // saved list order survives the Legacy→A+B switch.
        sortOrder: job.sortOrder,
        pinnedAt: job.pinnedAt,
        createdVia: job.createdVia ?? PHASE3_CREATED_VIA,
        createdAt: job.createdAt,
      },
    });
    opportunityId = opportunity.id;
    await writeMapping(tx, {
      userId: job.userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      targetEntityType: TARGET.JOB_OPPORTUNITY,
      targetEntityId: opportunity.id,
      mappingReason: [
        `legacyStatus=${statusValue}`,
        "Job.resumeId=DO_NOT_MAP",
        "JobSource mapped as opportunity provenance only",
        lifecycle.exceptionRule ?? "SAFE",
      ].join("; "),
    });
    acc.countWrite(acc.created, "opportunities");
    acc.countWrite(acc.created, "mappings");
  }

  if (!emptyDescription(job.description)) {
    const existingJd = await findMapping(tx, {
      userId: job.userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      targetEntityType: TARGET.JOB_DESCRIPTION_VERSION,
    });
    if (existingJd) {
      bump(acc.skippedAlreadyMigrated, "jdVersions");
    } else {
      const hash = sha256Text(job.description);
      const version = await tx.jobDescriptionVersion.create({
        data: {
          jobOpportunityId: opportunityId,
          versionNumber: 1,
          rawContent: job.description,
          rawContentFormat: "HTML",
          sourceUrl: job.jobUrl,
          capturedAt: job.createdAt,
          contentHash: hash,
          createdVia: job.createdVia ?? PHASE3_CREATED_VIA,
        },
      });
      await tx.jobOpportunity.update({
        where: { id: opportunityId },
        data: { currentJdVersionId: version.id },
      });
      await writeMapping(tx, {
        userId: job.userId,
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        targetEntityType: TARGET.JOB_DESCRIPTION_VERSION,
        targetEntityId: version.id,
        mappingReason: "raw historical JD; no AI parse",
      });
      acc.countWrite(acc.created, "jdVersions");
      acc.countWrite(acc.created, "mappings");
    }
  }

  for (const note of job.Notes) {
    const existingNote = await findMapping(tx, {
      userId: note.userId,
      legacyEntityType: LEGACY.NOTE,
      legacyEntityId: note.id,
      targetEntityType: TARGET.JOB_OPPORTUNITY_NOTE,
    });
    if (existingNote) {
      bump(acc.skippedAlreadyMigrated, "opportunityNotes");
      continue;
    }
    const created = await tx.jobOpportunityNote.create({
      data: {
        userId: note.userId,
        jobOpportunityId: opportunityId,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      },
    });
    await writeMapping(tx, {
      userId: note.userId,
      legacyEntityType: LEGACY.NOTE,
      legacyEntityId: note.id,
      targetEntityType: TARGET.JOB_OPPORTUNITY_NOTE,
      targetEntityId: created.id,
      mappingReason: "Job-scoped note copied onto JobOpportunityNote",
    });
    acc.countWrite(acc.created, "opportunityNotes");
    acc.countWrite(acc.created, "mappings");
  }

  if (lifecycle.createApplicationAttempt) {
    const existingAttempt = await findMapping(tx, {
      userId: job.userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      targetEntityType: TARGET.APPLICATION_ATTEMPT,
    });
    let attemptId: string;
    if (existingAttempt) {
      attemptId = existingAttempt.targetEntityId;
      bump(acc.skippedAlreadyMigrated, "attempts");
    } else {
      const submittedAt =
        job.appliedDate != null ? parseDate(job.appliedDate) : null;
      const attempt = await tx.applicationAttempt.create({
        data: {
          userId: job.userId,
          jobOpportunityId: opportunityId,
          channelCategory: null,
          channelLabel: UNSPECIFIED_CHANNEL_LABEL,
          sourceUrl: null,
          submittedAt,
          currentStageCategory: lifecycle.stageCategory ?? "SUBMITTED",
          outcome: (lifecycle.outcome ?? "ACTIVE") as AttemptOutcome as string,
          submittedResumeVersionId: null,
          submittedResumeArtifactId: null,
          // Historical submission JD is unknown; migration-time JD is not proof.
          submittedAgainstJdVersionId: null,
          createdVia: job.createdVia ?? PHASE3_CREATED_VIA,
        },
      });
      attemptId = attempt.id;
      await writeMapping(tx, {
        userId: job.userId,
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        targetEntityType: TARGET.APPLICATION_ATTEMPT,
        targetEntityId: attempt.id,
        mappingReason: [
          `stage=${lifecycle.stageCategory}`,
          `outcome=${lifecycle.outcome}`,
          "channel=UNSPECIFIED (JobSource is not application channel)",
          "submittedResumeVersionId not mapped from Job.resumeId",
          submittedAt ? "submittedAt from appliedDate" : "submittedAt=null",
        ].join("; "),
      });
      acc.countWrite(acc.created, "attempts");
      acc.countWrite(acc.created, "mappings");
    }

    const category = processCategory(lifecycle.stageCategory);
    if (category) {
      const existingStep = await findMapping(tx, {
        userId: job.userId,
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        targetEntityType: TARGET.APPLICATION_PROCESS_STEP,
      });
      if (existingStep) {
        bump(acc.skippedAlreadyMigrated, "processSteps");
      } else {
        const step = await tx.applicationProcessStep.create({
          data: {
            applicationAttemptId: attemptId,
            category,
            label: statusValue,
            status: "EVIDENCED",
            sortOrder: 0,
            scheduledAt: null,
            completedAt: null,
            result: lifecycle.outcome,
            source: PHASE3_CREATED_VIA,
            notes: "Single evidenced current stage; preceding steps not synthesized",
          },
        });
        await writeMapping(tx, {
          userId: job.userId,
          legacyEntityType: LEGACY.JOB,
          legacyEntityId: job.id,
          targetEntityType: TARGET.APPLICATION_PROCESS_STEP,
          targetEntityId: step.id,
          mappingReason:
            "One evidenced current-stage step only; no fabricated process history",
        });
        acc.countWrite(acc.created, "processSteps");
        acc.countWrite(acc.created, "mappings");
      }
    }
  }

  hooks?.beforeFinishRoot?.("Job", job.id);
}

async function migrateCareerMaterials(
  prisma: PrismaClient,
  hooks: MigratorHooks | undefined,
  acc: Acc,
): Promise<void> {
  const work = await prisma.workExperience.findMany({
    include: {
      Company: true,
      jobTitle: true,
      location: true,
      ResumeSection: { include: { Resume: { include: { profile: true } } } },
    },
  });
  for (const row of work) {
    const userId = row.ResumeSection?.Resume?.profile?.userId;
    if (!userId) {
      bump(acc.skippedUnsafe, "careerMaterials");
      continue;
    }
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.WORK_EXPERIENCE,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
        });
        if (existing) {
          bump(acc.skippedAlreadyMigrated, "careerMaterials");
          return;
        }
        const item = await tx.careerMaterialItem.create({
          data: {
            userId,
            type: "EMPLOYMENT",
            title: row.jobTitle.label,
            startDate: row.startDate,
            endDate: row.endDate,
            isCurrent: row.endDate == null,
            origin: PHASE3_CREATED_VIA,
            employmentDetail: {
              create: {
                companyId: row.companyId,
                organizationName: row.Company.label,
                roleTitle: row.jobTitle.label,
                locationText: row.location.label,
              },
            },
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.WORK_EXPERIENCE,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
          targetEntityId: item.id,
          mappingReason:
            "WorkExperience → EMPLOYMENT; duplicates reported only, not merged",
        });
        acc.countWrite(acc.created, "careerMaterials");
        acc.countWrite(acc.created, "mappings");
        if (!emptyDescription(row.description)) {
          await createEvidence(
            tx,
            acc,
            userId,
            LEGACY.WORK_EXPERIENCE,
            row.id,
            item.id,
            row.description,
          );
        }
        hooks?.beforeFinishRoot?.("WorkExperience", row.id);
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "careerMaterials");
      acc.errors.push({
        legacyEntityType: LEGACY.WORK_EXPERIENCE,
        legacyEntityId: row.id,
        code: "CAREER_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }

  const educations = await prisma.education.findMany({
    include: {
      location: true,
      ResumeSection: { include: { Resume: { include: { profile: true } } } },
    },
  });
  for (const row of educations) {
    const userId = row.ResumeSection?.Resume?.profile?.userId;
    if (!userId) {
      bump(acc.skippedUnsafe, "careerMaterials");
      continue;
    }
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.EDUCATION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
        });
        if (existing) {
          bump(acc.skippedAlreadyMigrated, "careerMaterials");
          return;
        }
        const item = await tx.careerMaterialItem.create({
          data: {
            userId,
            type: "EDUCATION",
            title: row.degree || row.institution,
            startDate: row.startDate,
            endDate: row.endDate,
            isCurrent: row.endDate == null,
            origin: PHASE3_CREATED_VIA,
            educationDetail: {
              create: {
                institution: row.institution,
                degree: row.degree,
                fieldOfStudy: row.fieldOfStudy,
                locationText: row.location.label,
              },
            },
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.EDUCATION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
          targetEntityId: item.id,
          mappingReason: "Education → EDUCATION",
        });
        acc.countWrite(acc.created, "careerMaterials");
        acc.countWrite(acc.created, "mappings");
        if (nonemptyText(row.description)) {
          await createEvidence(
            tx,
            acc,
            userId,
            LEGACY.EDUCATION,
            row.id,
            item.id,
            row.description,
          );
        }
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "careerMaterials");
      acc.errors.push({
        legacyEntityType: LEGACY.EDUCATION,
        legacyEntityId: row.id,
        code: "CAREER_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }

  const certs = await prisma.licenseOrCertification.findMany({
    include: {
      ResumeSection: { include: { Resume: { include: { profile: true } } } },
    },
  });
  for (const row of certs) {
    const userId = row.ResumeSection?.Resume?.profile?.userId;
    if (!userId) {
      bump(acc.skippedUnsafe, "careerMaterials");
      continue;
    }
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.LICENSE_OR_CERTIFICATION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
        });
        if (existing) {
          bump(acc.skippedAlreadyMigrated, "careerMaterials");
          return;
        }
        const item = await tx.careerMaterialItem.create({
          data: {
            userId,
            type: "CERTIFICATION",
            title: row.title,
            startDate: row.issueDate,
            endDate: row.expirationDate,
            origin: PHASE3_CREATED_VIA,
            certificationDetail: {
              create: {
                organization: row.organization,
                credentialUrl: row.credentialUrl,
                issueDate: row.issueDate,
                expirationDate: row.expirationDate,
              },
            },
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.LICENSE_OR_CERTIFICATION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
          targetEntityId: item.id,
          mappingReason:
            "LICENSE/CERTIFICATION section items → CERTIFICATION; no Award invention",
        });
        acc.countWrite(acc.created, "careerMaterials");
        acc.countWrite(acc.created, "mappings");
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "careerMaterials");
      acc.errors.push({
        legacyEntityType: LEGACY.LICENSE_OR_CERTIFICATION,
        legacyEntityId: row.id,
        code: "CAREER_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }

  const skills = await prisma.skill.findMany({
    include: {
      Tag: true,
      ResumeSection: { include: { Resume: { include: { profile: true } } } },
    },
  });
  for (const row of skills) {
    const userId = row.ResumeSection?.Resume?.profile?.userId;
    if (!userId || !row.Tag) {
      bump(acc.skippedUnsafe, "careerMaterials");
      continue;
    }
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.SKILL,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
        });
        if (existing) {
          bump(acc.skippedAlreadyMigrated, "careerMaterials");
          return;
        }
        const item = await tx.careerMaterialItem.create({
          data: {
            userId,
            type: "SKILL",
            title: row.Tag.label,
            origin: PHASE3_CREATED_VIA,
            skillDetail: {
              create: {
                skillName: row.Tag.label,
                // Keep the real tag reference only when the Tag still belongs
                // to this user; a cross-user or missing row falls back to the
                // text snapshot rather than fabricating a link (BD-LINKS).
                tagId: row.Tag.createdBy === userId ? row.Tag.id : null,
                structuredData: JSON.stringify({
                  skillOrder: row.order,
                  category: row.category,
                }),
              },
            },
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.SKILL,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
          targetEntityId: item.id,
          mappingReason: "Skill.order preserved in detail payload, not as identity",
        });
        acc.countWrite(acc.created, "careerMaterials");
        acc.countWrite(acc.created, "mappings");
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "careerMaterials");
      acc.errors.push({
        legacyEntityType: LEGACY.SKILL,
        legacyEntityId: row.id,
        code: "CAREER_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }

  const others = await prisma.otherSection.findMany({
    include: {
      ResumeSection: { include: { Resume: { include: { profile: true } } } },
    },
  });
  for (const row of others) {
    const userId = row.ResumeSection?.Resume?.profile?.userId;
    const sectionType = (row.ResumeSection?.sectionType || "").toLowerCase();
    if (!userId) {
      bump(acc.skippedUnsafe, "careerMaterials");
      continue;
    }
    const materialType = sectionType === "project" ? "PROJECT" : "CUSTOM";
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.OTHER_SECTION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
        });
        if (existing) {
          bump(acc.skippedAlreadyMigrated, "careerMaterials");
          return;
        }
        const item = await tx.careerMaterialItem.create({
          data: {
            userId,
            type: materialType,
            title: row.title,
            origin: PHASE3_CREATED_VIA,
            ...(materialType === "PROJECT"
              ? {
                  projectDetail: {
                    create: { roleTitle: null, structuredData: "{}" },
                  },
                }
              : {
                  customDetail: {
                    create: {
                      structuredData: JSON.stringify({
                        sectionType,
                      }),
                    },
                  },
                }),
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.OTHER_SECTION,
          legacyEntityId: row.id,
          targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
          targetEntityId: item.id,
          mappingReason: `${sectionType || "other"} → ${materialType}`,
        });
        acc.countWrite(acc.created, "careerMaterials");
        acc.countWrite(acc.created, "mappings");
        if (!emptyDescription(row.content)) {
          await createEvidence(
            tx,
            acc,
            userId,
            LEGACY.OTHER_SECTION,
            row.id,
            item.id,
            row.content,
          );
        }
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "careerMaterials");
      acc.errors.push({
        legacyEntityType: LEGACY.OTHER_SECTION,
        legacyEntityId: row.id,
        code: "CAREER_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }
}

async function createEvidence(
  tx: Tx,
  acc: Acc,
  userId: string,
  legacyType: string,
  legacyId: string,
  materialItemId: string,
  content: string,
): Promise<void> {
  const existing = await findMapping(tx, {
    userId,
    legacyEntityType: legacyType,
    legacyEntityId: legacyId,
    targetEntityType: TARGET.CAREER_EVIDENCE,
  });
  if (existing) {
    bump(acc.skippedAlreadyMigrated, "careerEvidence");
    return;
  }
  const evidence = await tx.careerEvidence.create({
    data: {
      materialItemId,
      kind: "DESCRIPTION",
      content,
      origin: PHASE3_CREATED_VIA,
    },
  });
  await writeMapping(tx, {
    userId,
    legacyEntityType: legacyType,
    legacyEntityId: legacyId,
    targetEntityType: TARGET.CAREER_EVIDENCE,
    targetEntityId: evidence.id,
    mappingReason: "Copied legacy description/content; no AI metrics",
  });
  acc.countWrite(acc.created, "careerEvidence");
  acc.countWrite(acc.created, "mappings");
}

async function migrateResumes(
  prisma: PrismaClient,
  hooks: MigratorHooks | undefined,
  acc: Acc,
): Promise<void> {
  const resumes = await prisma.resume.findMany({
    include: {
      profile: true,
      ContactInfo: true,
      ResumeSections: {
        include: {
          summary: true,
          workExperiences: true,
          educations: true,
          licenseOrCertifications: true,
          others: true,
          skills: true,
        },
      },
    },
  });

  for (const resume of resumes) {
    const userId = resume.profile.userId;
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const existingVariant = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.RESUME,
          legacyEntityId: resume.id,
          targetEntityType: TARGET.RESUME_VARIANT,
        });
        let variantId: string;
        if (existingVariant) {
          variantId = existingVariant.targetEntityId;
          bump(acc.skippedAlreadyMigrated, "resumeVariants");
        } else {
          const variant = await tx.resumeVariant.create({
            data: {
              userId,
              name: resume.title,
              createdAt: resume.createdAt,
            },
          });
          variantId = variant.id;
          await writeMapping(tx, {
            userId,
            legacyEntityType: LEGACY.RESUME,
            legacyEntityId: resume.id,
            targetEntityType: TARGET.RESUME_VARIANT,
            targetEntityId: variant.id,
            mappingReason: "1:1 Resume → ResumeVariant",
          });
          acc.countWrite(acc.created, "resumeVariants");
          acc.countWrite(acc.created, "mappings");
        }

        const existingVersion = await findMapping(tx, {
          userId,
          legacyEntityType: LEGACY.RESUME,
          legacyEntityId: resume.id,
          targetEntityType: TARGET.RESUME_VARIANT_VERSION,
        });
        if (existingVersion) {
          bump(acc.skippedAlreadyMigrated, "resumeVersions");
          hooks?.beforeFinishRoot?.("Resume", resume.id);
          return;
        }

        const header = resume.ContactInfo
          ? contactHeaderSnapshot({
              resumeId: resume.id,
              firstName: resume.ContactInfo.firstName,
              lastName: resume.ContactInfo.lastName,
              headline: resume.ContactInfo.headline,
              email: resume.ContactInfo.email,
              phone: resume.ContactInfo.phone,
              address: resume.ContactInfo.address,
              url1: resume.ContactInfo.url1,
              url1Label: resume.ContactInfo.url1Label,
              url2: resume.ContactInfo.url2,
              url2Label: resume.ContactInfo.url2Label,
            })
          : null;

        const version = await tx.resumeVariantVersion.create({
          data: {
            resumeVariantId: variantId,
            versionNumber: 1,
            status: "FROZEN",
            headerSnapshot: header,
            layoutConfig: RESUME_LAYOUT_CONFIG,
            createdVia: PHASE3_CREATED_VIA,
            frozenAt: null,
          },
        });
        await tx.resumeVariant.update({
          where: { id: variantId },
          data: { currentVersionId: version.id },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.RESUME,
          legacyEntityId: resume.id,
          targetEntityType: TARGET.RESUME_VARIANT_VERSION,
          targetEntityId: version.id,
          mappingReason:
            "Immutable migrated snapshot; ORDER_UNRECOVERABLE (sortOrder unspecified, not historical layout)",
        });
        acc.countWrite(acc.created, "resumeVersions");
        acc.countWrite(acc.created, "mappings");

        for (const section of resume.ResumeSections) {
          const createdSection = await tx.resumeVariantSection.create({
            data: {
              resumeVariantVersionId: version.id,
              title: section.sectionTitle,
              systemKind: section.sectionType,
              sortOrder: 0,
            },
          });

          if (section.summary && !emptyDescription(section.summary.content)) {
            const item = await tx.resumeVariantSectionItem.create({
              data: {
                resumeVariantSectionId: createdSection.id,
                itemKind: "SUMMARY",
                sortOrder: 0,
              },
            });
            await tx.resumeExpression.create({
              data: {
                resumeVariantSectionItemId: item.id,
                kind: "BODY",
                content: section.summary.content,
                sortOrder: 0,
              },
            });
          }

          const linkMaterial = async (
            legacyType: string,
            legacyId: string,
            itemKind: string,
            sortOrder: number,
            expression?: string | null,
          ) => {
            const mapped = await findMapping(tx, {
              userId,
              legacyEntityType: legacyType,
              legacyEntityId: legacyId,
              targetEntityType: TARGET.CAREER_MATERIAL_ITEM,
            });
            if (!mapped) {
              throw new Error(
                `CAREER_MATERIAL_NOT_READY ${legacyType}:${legacyId}`,
              );
            }
            // Capture the title observable now, without claiming original historical state.
            const material = await tx.careerMaterialItem.findUniqueOrThrow({ where: { id: mapped.targetEntityId } });
            const item = await tx.resumeVariantSectionItem.create({
              data: {
                resumeVariantSectionId: createdSection.id,
                careerMaterialItemId: mapped.targetEntityId,
                materialTitleSnapshot: material.title,
                itemKind,
                sortOrder,
              },
            });
            if (expression && !emptyDescription(expression)) {
              const expr = await tx.resumeExpression.create({
                data: {
                  resumeVariantSectionItemId: item.id,
                  kind: "BODY",
                  content: expression,
                  sortOrder: 0,
                },
              });
              const evidenceMap = await findMapping(tx, {
                userId,
                legacyEntityType: legacyType,
                legacyEntityId: legacyId,
                targetEntityType: TARGET.CAREER_EVIDENCE,
              });
              if (evidenceMap) {
                const evidence = await tx.careerEvidence.findUnique({
                  where: { id: evidenceMap.targetEntityId },
                });
                if (evidence) {
                  await tx.resumeExpressionEvidence.create({
                    data: {
                      resumeExpressionId: expr.id,
                      careerEvidenceId: evidence.id,
                      evidenceContentSnapshot: evidence.content,
                      evidenceHashSnapshot: sha256Text(evidence.content),
                      evidenceUpdatedAtSnapshot: evidence.updatedAt,
                    },
                  });
                }
              }
            }
          };

          for (const we of section.workExperiences) {
            await linkMaterial(
              LEGACY.WORK_EXPERIENCE,
              we.id,
              "EMPLOYMENT",
              0,
              we.description,
            );
          }
          for (const ed of section.educations) {
            await linkMaterial(
              LEGACY.EDUCATION,
              ed.id,
              "EDUCATION",
              0,
              ed.description,
            );
          }
          for (const cert of section.licenseOrCertifications) {
            await linkMaterial(
              LEGACY.LICENSE_OR_CERTIFICATION,
              cert.id,
              "CERTIFICATION",
              0,
            );
          }
          for (const other of section.others) {
            const kind =
              section.sectionType.toLowerCase() === "project"
                ? "PROJECT"
                : "CUSTOM";
            await linkMaterial(
              LEGACY.OTHER_SECTION,
              other.id,
              kind,
              0,
              other.content,
            );
          }
          for (const skill of section.skills) {
            const order =
              Number.isFinite(skill.order) && skill.order >= 0 ? skill.order : 0;
            await linkMaterial(LEGACY.SKILL, skill.id, "SKILL", order);
          }
        }

        hooks?.beforeFinishRoot?.("Resume", resume.id);
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "resumeVariants");
      acc.errors.push({
        legacyEntityType: LEGACY.RESUME,
        legacyEntityId: resume.id,
        code: "RESUME_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }
}

async function migrateContactProfiles(
  prisma: PrismaClient,
  acc: Acc,
): Promise<void> {
  const rows = await prisma.contactInfo.findMany({
    include: { resume: { include: { profile: true } } },
  });
  const byUser = new Map<string, LegacyContactRow[]>();
  for (const row of rows) {
    const userId = row.resume.profile.userId;
    const list = byUser.get(userId) ?? [];
    list.push({
      resumeId: row.resumeId,
      firstName: row.firstName,
      lastName: row.lastName,
      headline: row.headline,
      email: row.email,
      phone: row.phone,
      address: row.address,
      url1: row.url1,
      url1Label: row.url1Label,
      url2: row.url2,
      url2Label: row.url2Label,
    });
    byUser.set(userId, list);
  }

  for (const [userId, contacts] of byUser) {
    const resolution = resolveContactProfile(contacts);
    if (resolution.conflicts.length) {
      acc.contactConflicts?.push({
        userIdHash: hashId(userId),
        fields: resolution.conflicts.map((c) => c.field),
      });
    }
    const existing = await findContactProfileMapping(prisma, userId);
    if (existing) {
      bump(acc.skippedAlreadyMigrated, "contactProfiles");
      continue;
    }
    if (!resolution.createProfile) {
      bump(acc.skippedUnsafe, "contactProfiles");
      continue;
    }
    const snap = snapshotAcc(acc);
    try {
      await prisma.$transaction(async (tx) => {
        const already = await tx.candidateProfile.findUnique({
          where: { userId },
        });
        if (already) {
          const mapped = await findContactProfileMapping(tx, userId);
          if (!mapped) {
            await writeMapping(tx, {
              userId,
              legacyEntityType: LEGACY.USER_CONTACT_INFO,
              legacyEntityId: userId,
              targetEntityType: TARGET.CANDIDATE_PROFILE,
              targetEntityId: already.id,
              mappingReason: "Existing CandidateProfile linked without duplicating",
            });
            acc.countWrite(acc.created, "mappings");
          }
          bump(acc.skippedAlreadyMigrated, "contactProfiles");
          return;
        }
        const profile = await tx.candidateProfile.create({
          data: {
            userId,
            ...resolution.profile,
          },
        });
        await writeMapping(tx, {
          userId,
          legacyEntityType: LEGACY.USER_CONTACT_INFO,
          legacyEntityId: userId,
          targetEntityType: TARGET.CANDIDATE_PROFILE,
          targetEntityId: profile.id,
          mappingReason: "all comparable email/phone/address values agreed",
        });
        acc.countWrite(acc.created, "contactProfiles");
        acc.countWrite(acc.created, "mappings");
      }, TX_OPTS);
    } catch (err) {
      restoreAcc(acc, snap);
      bump(acc.failed, "contactProfiles");
      acc.errors.push({
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
        legacyEntityId: userId,
        code: "CONTACT_ROOT_FAILURE",
        message: String(err).slice(0, 400),
      });
    }
  }
}

export function renderPhase3Markdown(report: Phase3Report): string {
  return [
    "# Vocatrya A+B Phase 3 — Legacy Backfill Report",
    "",
    `- migrationVersion: \`${report.migrationVersion}\``,
    `- mode: \`${report.mode}\``,
    `- runId: \`${report.runId ?? "(none)"}\``,
    `- source: \`${report.sourceIdentity.path}\``,
    `- source sha256: \`${report.sourceIdentity.sha256 ?? "n/a"}\``,
    `- preflight: ${report.preflight.ok ? "PASS" : "BLOCKED"}`,
    `- phaseResult: ${report.phaseResult}`,
    `- writeCount: ${report.writeCount}`,
    `- bookkeepingWriteCount: ${report.bookkeepingWriteCount}`,
    `- duplicated: ${report.duplicated}`,
    `- unexpectedUpdates: ${report.unexpectedUpdates}`,
    `- REAL_USER_DATA_MUTATED: ${report.REAL_USER_DATA_MUTATED}`,
    `- PRODUCTION_BACKFILL_EXECUTED: ${report.PRODUCTION_BACKFILL_EXECUTED}`,
    "",
    "## created",
    "",
    "```json",
    JSON.stringify(report.created, null, 2),
    "```",
    "",
    "## skippedAlreadyMigrated",
    "",
    "```json",
    JSON.stringify(report.skippedAlreadyMigrated, null, 2),
    "```",
    "",
    "## skippedUnsafe / failed",
    "",
    "```json",
    JSON.stringify(
      { skippedUnsafe: report.skippedUnsafe, failed: report.failed },
      null,
      2,
    ),
    "```",
    "",
    `contactConflicts: ${report.contactConflicts.length}`,
    `duplicateCandidates.groups: ${report.duplicateCandidates.groupCount}`,
    `automaticMerges: ${report.duplicateCandidates.automaticMerges}`,
    "",
    ...report.orderingLimitations.map((line) => `- ${line}`),
    "",
    "Report omits raw resume/job/contact content.",
    "",
  ].join("\n");
}
