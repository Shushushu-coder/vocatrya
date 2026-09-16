"use client";
import { Badge } from "../ui/badge";
import { StatusBadge } from "../StatusBadge";
import { getJobStatusBadgeColor } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";
import { JobResponse } from "@/models/job.model";

import { useI18n, getLocalizedJobStatus } from "@/i18n";

type JobStatusBadgeProps = {
  job: JobResponse;
  className?: string;
};

// Dismissed and past-due drafts override the stored status. Shared by the
// table and card views so the two can't disagree about the same job.
export function JobStatusBadge({ job, className }: JobStatusBadgeProps) {
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

  if (job.dueDate && new Date() > job.dueDate && job.Status?.value === "draft") {
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
