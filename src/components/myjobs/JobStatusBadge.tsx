"use client";
import { Badge } from "../ui/badge";
import { StatusBadge } from "../StatusBadge";
import { getJobStatusBadgeColor } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";
import { JobResponse } from "@/models/job.model";
import { isDeadlineOverdue, runtimeTimeZone } from "@/lib/datetime";
import { jobDeadlineBusinessValue } from "@/lib/jobs/deadlineTime";

import { useI18n, getLocalizedJobStatus } from "@/i18n";

type JobStatusBadgeProps = {
  job: JobResponse;
  className?: string;
  /** Account zone — DateOnly deadlines turn overdue at end of *its* day. */
  timeZone?: string;
};

// Dismissed and past-due drafts override the stored status. Shared by the
// table and card views so the two can't disagree about the same job.
export function JobStatusBadge({ job, className, timeZone }: JobStatusBadgeProps) {
  const { t } = useI18n();

  if (job.discoveryStatus === "dismissed") {
    return (
      <Badge
        variant="outline"
        className={cn("text-muted-foreground", className)}
      >
        {t("automations.discoveryStatuses.dismissed")}
      </Badge>
    );
  }

  if (
    job.Status?.value === "draft" &&
    isDeadlineOverdue(
      jobDeadlineBusinessValue(job),
      new Date(),
      timeZone ?? runtimeTimeZone(),
    )
  ) {
    return (
      <StatusBadge
        label={t("jobs.statuses.expired")}
        color="amber"
        className={className}
      />
    );
  }

  const localizedLabel = getLocalizedJobStatus(job.Status, t);

  return (
    <StatusBadge
      label={localizedLabel}
      color={getJobStatusBadgeColor(job.Status?.value ?? "")}
      className={className}
    />
  );
}
