import { DEFAULT_LOCALE, isValidLocale, type Locale } from "@/i18n/config";
import {
  isTerminalAttemptOutcome,
  PROCESS_STEP_STATUS,
} from "@/lib/career/identities";

// REM-V1 reminder contract — pure, side-effect-free half. Everything here is
// deterministic so the units stay testable without a database; the db-bound
// half lives in reminderService.ts.

export const REMINDER_STATUS = {
  PENDING: "PENDING",
  FIRED: "FIRED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
} as const;
export type ReminderStatus =
  (typeof REMINDER_STATUS)[keyof typeof REMINDER_STATUS];

export const REMINDER_SOURCE_TYPE = {
  PROCESS_STEP: "PROCESS_STEP",
  JOB_DUE: "JOB_DUE",
} as const;
export type ReminderSourceType =
  (typeof REMINDER_SOURCE_TYPE)[keyof typeof REMINDER_SOURCE_TYPE];

// Restart catch-up boundary, measured from the anchor (the event itself), not
// fireAt: a PENDING reminder whose event is inside this window is still worth
// delivering; anything older flips to EXPIRED instead of firing days late.
export const REMINDER_OVERDUE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMINDER_CLAIM_BATCH_SIZE = 50;

export const NOTIFICATION_LEAD_MINUTES_OPTIONS = [
  0, 15, 30, 60, 120, 1440,
] as const;
export const DEFAULT_NOTIFICATION_LEAD_MINUTES: number = 30;

export function isNotificationLeadMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (NOTIFICATION_LEAD_MINUTES_OPTIONS as readonly number[]).includes(value)
  );
}

export function normalizeNotificationLeadMinutes(value: unknown): number {
  return isNotificationLeadMinutes(value)
    ? value
    : DEFAULT_NOTIFICATION_LEAD_MINUTES;
}

export type NotificationPrefs = {
  enabled: boolean;
  leadMinutes: number;
  locale: Locale;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `settings.notifications.*` read contract. A missing/corrupt block falls
 * back to defaults rather than throwing — same spirit as
 * parseSettingsDocument. `enabled` defaults to true: the feature is on
 * unless the user explicitly muted it.
 */
export function notificationPrefsFromDocument(
  doc: Record<string, unknown>,
): NotificationPrefs {
  const settings = isPlainRecord(doc.settings) ? doc.settings : {};
  const notifications = isPlainRecord(settings.notifications)
    ? settings.notifications
    : {};
  const general = isPlainRecord(settings.general) ? settings.general : {};
  return {
    enabled:
      typeof notifications.enabled === "boolean"
        ? notifications.enabled
        : true,
    leadMinutes: normalizeNotificationLeadMinutes(notifications.leadMinutes),
    locale: isValidLocale(general.locale) ? general.locale : DEFAULT_LOCALE,
  };
}

/** Fields the sync needs from a process step and its parents. */
export type ProcessStepReminderSource = {
  id: string;
  label: string;
  status: string;
  scheduledAt: Date | null;
  completedAt: Date | null;
  applicationAttempt: {
    archivedAt: Date | null;
    outcome: string;
    jobOpportunity: {
      id: string;
      title: string;
      archivedAt: Date | null;
      company: { label: string };
    };
  };
};

/** Fields the sync needs from a legacy Job row. */
export type JobDueReminderSource = {
  id: string;
  dueDate: Date | null;
  discoveryStatus: string | null;
  Status: { value: string };
  JobTitle: { label: string };
  Company: { label: string };
};

export type ReminderPayload = {
  /** The instant the source carries (scheduledAt / dueDate). */
  anchorAt: Date;
  /** anchorAt - leadMinutes; the claim index reads this column. */
  fireAt: Date;
  title: string;
  body: string;
  deepLink: string;
};

export const processStepDeepLink = (jobOpportunityId: string): string =>
  `/dashboard/myjobs/${jobOpportunityId}`;

export const jobDueDeepLink = (jobId: string): string =>
  `/dashboard/myjobs/${jobId}`;

// Mirrors LEGACY_TERMINAL_STATUS_VALUES in career/jobsReadDispatch — a
// concluded legacy position should never produce a deadline reminder. Kept
// local so this module does not depend on the read-model module.
const JOB_DUE_TERMINAL_STATUS_VALUES = new Set([
  "rejected",
  "expired",
  "archived",
  "offer-accepted",
  "offer-declined",
]);

/**
 * The desired reminder state for one process step, or null when the step
 * must not carry a live reminder (closed step, dead attempt/opportunity, or
 * no scheduled anchor). Pure so the cleaning rules stay unit-testable.
 */
export function computeProcessStepReminder(
  step: ProcessStepReminderSource,
  prefs: NotificationPrefs,
): ReminderPayload | null {
  if (!step.scheduledAt) return null;
  const open =
    step.completedAt === null &&
    step.status !== PROCESS_STEP_STATUS.COMPLETED &&
    step.status !== PROCESS_STEP_STATUS.CANCELLED &&
    step.applicationAttempt.archivedAt === null &&
    !isTerminalAttemptOutcome(step.applicationAttempt.outcome) &&
    step.applicationAttempt.jobOpportunity.archivedAt === null;
  if (!open) return null;
  const opportunity = step.applicationAttempt.jobOpportunity;
  return {
    anchorAt: step.scheduledAt,
    fireAt: new Date(step.scheduledAt.getTime() - prefs.leadMinutes * 60_000),
    title: step.label,
    body: `${opportunity.company.label} · ${opportunity.title}`,
    deepLink: processStepDeepLink(opportunity.id),
  };
}

/** Same contract for a legacy Job.dueDate anchor. */
export function computeJobDueReminder(
  job: JobDueReminderSource,
  prefs: NotificationPrefs,
): ReminderPayload | null {
  if (!job.dueDate) return null;
  if (JOB_DUE_TERMINAL_STATUS_VALUES.has(job.Status.value)) return null;
  if (job.discoveryStatus === "dismissed") return null;
  return {
    anchorAt: job.dueDate,
    fireAt: new Date(job.dueDate.getTime() - prefs.leadMinutes * 60_000),
    title: prefs.locale === "en" ? "Application deadline" : "申请截止提醒",
    body: `${job.JobTitle.label} · ${job.Company.label}`,
    deepLink: jobDueDeepLink(job.id),
  };
}

/** What the renderer needs to raise one notification. */
export type ReminderDelivery = {
  id: string;
  title: string;
  body: string;
  deepLink: string;
};
