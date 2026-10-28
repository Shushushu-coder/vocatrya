import type { Prisma, PrismaClient, Reminder } from "@prisma/client";
import {
  isUniqueConstraintViolation,
  parseSettingsDocument,
} from "@/lib/userSettings/patch";
import {
  computeJobDueReminder,
  computeProcessStepReminder,
  notificationPrefsFromDocument,
  REMINDER_CLAIM_BATCH_SIZE,
  REMINDER_OVERDUE_WINDOW_MS,
  REMINDER_SOURCE_TYPE,
  REMINDER_STATUS,
  type JobDueReminderSource,
  type NotificationPrefs,
  type ProcessStepReminderSource,
  type ReminderPayload,
  type ReminderSourceType,
} from "./shared";

// REM-V1 db-bound half. Every function takes the caller's prisma handle (a
// PrismaClient or a TransactionClient) so write-path hooks run inside the
// same transaction as the source write.

export type ReminderDb = PrismaClient | Prisma.TransactionClient;

const STEP_SYNC_SELECT = {
  id: true,
  label: true,
  status: true,
  scheduledAt: true,
  completedAt: true,
  applicationAttempt: {
    select: {
      archivedAt: true,
      outcome: true,
      jobOpportunity: {
        select: {
          id: true,
          title: true,
          archivedAt: true,
          company: { select: { label: true } },
        },
      },
    },
  },
} as const;

const JOB_SYNC_SELECT = {
  id: true,
  dueDate: true,
  discoveryStatus: true,
  Status: { select: { value: true } },
  JobTitle: { select: { label: true } },
  Company: { select: { label: true } },
} as const;

export async function loadNotificationPrefs(
  db: ReminderDb,
  userId: string,
): Promise<NotificationPrefs> {
  const row = await db.userSettings.findUnique({
    where: { userId },
    select: { settings: true },
  });
  return notificationPrefsFromDocument(parseSettingsDocument(row?.settings));
}

type ReminderKey = {
  userId: string;
  sourceType: ReminderSourceType;
  targetId: string;
};

/**
 * Write-through state machine for one (user, source, target) record:
 * - no row + desired     → create PENDING
 * - PENDING + desired    → retarget to the current schedule
 * - PENDING + no desired → CANCELLED
 * - EXPIRED + desired    → revive to PENDING (a reschedule is a new
 *   scheduling, not a rewrite of the stale record)
 * - FIRED / CANCELLED    → untouched: terminal history is never rewritten
 * - EXPIRED + no desired → stays EXPIRED
 */
async function applyReminderDesired(
  db: ReminderDb,
  key: ReminderKey,
  desired: ReminderPayload | null,
): Promise<void> {
  const existing = await db.reminder.findUnique({
    where: { userId_sourceType_targetId: key },
  });
  if (!existing) {
    if (!desired) return;
    try {
      await db.reminder.create({
        data: { ...key, ...desired },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // Lost the create race: reconcile against the winner's row instead of
      // failing the source write.
      await applyReminderDesired(db, key, desired);
    }
    return;
  }
  if (
    existing.status === REMINDER_STATUS.FIRED ||
    existing.status === REMINDER_STATUS.CANCELLED
  ) {
    return;
  }
  if (!desired) {
    if (existing.status === REMINDER_STATUS.PENDING) {
      await db.reminder.updateMany({
        where: { id: existing.id, status: REMINDER_STATUS.PENDING },
        data: { status: REMINDER_STATUS.CANCELLED },
      });
    }
    return;
  }
  await db.reminder.updateMany({
    where: {
      id: existing.id,
      status: {
        in: [REMINDER_STATUS.PENDING, REMINDER_STATUS.EXPIRED],
      },
    },
    data: { ...desired, status: REMINDER_STATUS.PENDING },
  });
}

/** Cancel a live reminder for one target — used when the target is deleted. */
export async function cancelPendingReminder(
  db: ReminderDb,
  userId: string,
  sourceType: ReminderSourceType,
  targetId: string,
): Promise<void> {
  await db.reminder.updateMany({
    where: {
      userId,
      sourceType,
      targetId,
      status: REMINDER_STATUS.PENDING,
    },
    data: { status: REMINDER_STATUS.CANCELLED },
  });
}

async function loadStepForSync(
  db: ReminderDb,
  userId: string,
  stepId: string,
): Promise<ProcessStepReminderSource | null> {
  return db.applicationProcessStep.findFirst({
    where: { id: stepId, applicationAttempt: { userId } },
    select: STEP_SYNC_SELECT,
  });
}

/**
 * Targeted sync for a single process step — called inside the source write's
 * transaction by ApplicationService hooks so a step write and its reminder
 * update commit or roll back together.
 */
export async function syncProcessStepReminder(
  db: ReminderDb,
  userId: string,
  stepId: string,
): Promise<void> {
  const [step, prefs] = await Promise.all([
    loadStepForSync(db, userId, stepId),
    loadNotificationPrefs(db, userId),
  ]);
  await applyReminderDesired(
    db,
    { userId, sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP, targetId: stepId },
    step ? computeProcessStepReminder(step, prefs) : null,
  );
}

/**
 * Full user-scoped reconcile: upserts a reminder for every open anchor and
 * cancels PENDING rows whose target no longer resolves (deleted source,
 * cleared schedule, archived parent). Covers write paths with no hook —
 * automation job writes, legacy migration step inserts, backup restores.
 * Returns the prefs used, so callers can gate delivery without a second read.
 */
export async function reconcileReminders(
  db: ReminderDb,
  userId: string,
): Promise<NotificationPrefs> {
  const prefs = await loadNotificationPrefs(db, userId);
  const [steps, jobs, reminders] = await Promise.all([
    db.applicationProcessStep.findMany({
      where: {
        applicationAttempt: { userId },
        scheduledAt: { not: null },
      },
      select: STEP_SYNC_SELECT,
    }),
    db.job.findMany({
      where: { userId, dueDate: { not: null } },
      select: JOB_SYNC_SELECT,
    }),
    db.reminder.findMany({
      where: { userId, status: REMINDER_STATUS.PENDING },
      select: { sourceType: true, targetId: true },
    }),
  ]);

  const liveTargets = new Set<string>();
  for (const step of steps) {
    liveTargets.add(`${REMINDER_SOURCE_TYPE.PROCESS_STEP}:${step.id}`);
    await applyReminderDesired(
      db,
      {
        userId,
        sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
        targetId: step.id,
      },
      computeProcessStepReminder(step, prefs),
    );
  }
  for (const job of jobs as JobDueReminderSource[]) {
    liveTargets.add(`${REMINDER_SOURCE_TYPE.JOB_DUE}:${job.id}`);
    await applyReminderDesired(
      db,
      { userId, sourceType: REMINDER_SOURCE_TYPE.JOB_DUE, targetId: job.id },
      computeJobDueReminder(job, prefs),
    );
  }
  for (const reminder of reminders) {
    const sourceType = reminder.sourceType as ReminderSourceType;
    if (liveTargets.has(`${sourceType}:${reminder.targetId}`)) continue;
    await cancelPendingReminder(db, userId, sourceType, reminder.targetId);
  }
  return prefs;
}

/**
 * Overdue policy: PENDING reminders whose anchor is older than
 * REMINDER_OVERDUE_WINDOW_MS flip to EXPIRED — they will never deliver.
 * Returns the number expired.
 */
export async function expireStaleReminders(
  db: ReminderDb,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const staleBefore = new Date(now.getTime() - REMINDER_OVERDUE_WINDOW_MS);
  const { count } = await db.reminder.updateMany({
    where: {
      userId,
      status: REMINDER_STATUS.PENDING,
      anchorAt: { lt: staleBefore },
    },
    data: { status: REMINDER_STATUS.EXPIRED },
  });
  return count;
}

/**
 * Atomically claim every due reminder for a user. Each row flips
 * PENDING→FIRED via a conditional updateMany, so two concurrent ticks (or a
 * second mounted renderer) can never deliver the same row twice — the loser
 * sees count 0 and skips it. Runs inside one transaction so the expire pass
 * and the due snapshot agree.
 */
export async function claimDueReminders(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<Reminder[]> {
  return db.$transaction(async (tx) => {
    await expireStaleReminders(tx, userId, now);
    const due = await tx.reminder.findMany({
      where: {
        userId,
        status: REMINDER_STATUS.PENDING,
        fireAt: { lte: now },
      },
      orderBy: { fireAt: "asc" },
      take: REMINDER_CLAIM_BATCH_SIZE,
    });
    const claimed: Reminder[] = [];
    for (const row of due) {
      const { count } = await tx.reminder.updateMany({
        where: { id: row.id, status: REMINDER_STATUS.PENDING },
        data: { status: REMINDER_STATUS.FIRED, firedAt: now },
      });
      if (count === 1) claimed.push(row);
    }
    return claimed;
  });
}
