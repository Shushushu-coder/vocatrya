import type { TranslateFn } from "./types";

export function getLocalizedJobStatus(
  status: { label?: string; value?: string } | string | null | undefined,
  t: TranslateFn
): string {
  if (!status) return "";
  const val = typeof status === "string" ? status.toLowerCase() : (status.value || status.label || "").toLowerCase();
  
  const statusKeyMap: Record<string, string> = {
    new: "jobs.statuses.new",
    draft: "jobs.statuses.draft",
    applied: "jobs.statuses.applied",
    interview: "jobs.statuses.interview",
    offer: "jobs.statuses.offer",
    "offer-accepted": "jobs.statuses.offer-accepted",
    "offer-declined": "jobs.statuses.offer-declined",
    rejected: "jobs.statuses.rejected",
    transferred: "jobs.statuses.transferred",
    expired: "jobs.statuses.expired",
    archived: "jobs.statuses.archived",
    dismissed: "automations.discoveryStatuses.dismissed",
    accepted: "automations.discoveryStatuses.accepted",
  };

  const key = statusKeyMap[val];
  if (key) {
    return t(key);
  }
  return typeof status === "string" ? status : (status.label || status.value || "");
}

export function getLocalizedContactRole(
  role: string | null | undefined,
  t: TranslateFn
): string {
  if (!role) return "";
  const normalized = role.toLowerCase().trim();
  const roleMap: Record<string, string> = {
    recruiter: "contacts.roles.recruiter",
    "hiring manager": "contacts.roles.hiring manager",
    interviewer: "contacts.roles.interviewer",
    referrer: "contacts.roles.referrer",
    reference: "contacts.roles.reference",
  };

  const key = roleMap[normalized];
  if (key) {
    return t(key);
  }
  return role;
}

export function getLocalizedTaskPriority(
  priority: string | null | undefined,
  t: TranslateFn
): string {
  if (!priority) return "";
  const p = priority.toLowerCase();
  const priorityMap: Record<string, string> = {
    low: "tasks.priorities.low",
    medium: "tasks.priorities.medium",
    high: "tasks.priorities.high",
    urgent: "tasks.priorities.urgent",
  };
  const key = priorityMap[p];
  return key ? t(key) : priority;
}

export function getLocalizedTaskStatus(
  status: string | null | undefined,
  t: TranslateFn
): string {
  if (!status) return "";
  const s = status.toLowerCase();
  const statusMap: Record<string, string> = {
    todo: "tasks.statuses.todo",
    "in-progress": "tasks.statuses.in-progress",
    completed: "tasks.statuses.completed",
    complete: "tasks.statuses.complete",
    "needs-attention": "tasks.statuses.needs-attention",
    cancelled: "tasks.statuses.cancelled",
  };
  const key = statusMap[s];
  return key ? t(key) : status;
}

export function getLocalizedWorkplaceType(
  type: string | null | undefined,
  t: TranslateFn
): string {
  if (!type) return "";
  const val = type.toLowerCase().trim();
  const map: Record<string, string> = {
    remote: "jobs.workplaceTypes.remote",
    hybrid: "jobs.workplaceTypes.hybrid",
    "on-site": "jobs.workplaceTypes.on-site",
    onsite: "jobs.workplaceTypes.onsite",
  };
  const key = map[val];
  return key ? t(key) : type;
}

export function getLocalizedJobType(
  type: string | null | undefined,
  t: TranslateFn
): string {
  if (!type) return "";
  const val = type.toLowerCase().trim();
  const map: Record<string, string> = {
    "full-time": "jobs.jobTypes.full-time",
    "part-time": "jobs.jobTypes.part-time",
    contract: "jobs.jobTypes.contract",
    internship: "jobs.jobTypes.internship",
    temporary: "jobs.jobTypes.temporary",
    ft: "jobs.jobTypes.full-time",
    pt: "jobs.jobTypes.part-time",
    c: "jobs.jobTypes.contract",
  };
  const key = map[val];
  return key ? t(key) : type;
}
