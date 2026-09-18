"use client";

import Link from "next/link";
import { ExternalLink, FileText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CircularScore } from "@/components/CircularScore";
import { StatusBadge } from "@/components/StatusBadge";
import { DownloadFileButton } from "@/components/profile/DownloadFileButton";
import { getJobStatusBadgeColor } from "@/lib/badge-colors";
import { formatUrl } from "@/lib/utils";
import type { JobMatchData } from "@/models/ai.schemas";
import {
  JobResponse,
  JobStatus,
  getJobTypeLabel,
  getWorkplaceTypeLabel,
} from "@/models/job.model";
import {
  useI18n,
  getLocalizedJobStatus,
  getLocalizedJobType,
  getLocalizedWorkplaceType,
} from "@/i18n";

type JobSummaryCardProps = {
  job: JobResponse;
  currentStatus: JobStatus;
  matchData: JobMatchData | null;
  showCampusFields?: boolean;
};

export function JobSummaryCard({
  job,
  currentStatus,
  matchData,
  showCampusFields = false,
}: JobSummaryCardProps) {
  const { t, formatDate } = useI18n();
  const expired =
    job.dueDate &&
    new Date() > new Date(job.dueDate) &&
    currentStatus?.value === "draft";

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.jobStatus")}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {expired ? (
                <StatusBadge label={t("jobs.statuses.expired")} color="amber" />
              ) : (
                <StatusBadge
                  label={getLocalizedJobStatus(currentStatus, t)}
                  color={getJobStatusBadgeColor(currentStatus?.value ?? "")}
                />
              )}
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.jobType")}</p>
            <p className="mt-1 font-medium">
              {getLocalizedJobType(getJobTypeLabel(job.jobType), t)}
              {job.workplaceType &&
                ` · ${getLocalizedWorkplaceType(getWorkplaceTypeLabel(job.workplaceType), t)}`}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.salaryRange")}</p>
            <p className="mt-1 font-medium">{job.salaryRange || "-"}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.jobSource")}</p>
            <p className="mt-1 font-medium">{job.JobSource?.label ?? "-"}</p>
          </div>
          {showCampusFields && job.recruitmentCohort ? (
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.recruitmentCohort")}
              </p>
              <p className="mt-1 font-medium">{job.recruitmentCohort}</p>
            </div>
          ) : null}
          {showCampusFields && job.recruitmentBatch ? (
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.recruitmentBatch")}
              </p>
              <p className="mt-1 font-medium">{job.recruitmentBatch}</p>
            </div>
          ) : null}
          {showCampusFields && job.dueDate ? (
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.applicationDeadline")}
              </p>
              <p className="mt-1 font-medium">{formatDate(job.dueDate)}</p>
            </div>
          ) : null}
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.statuses.applied")}</p>
            <p className="mt-1 font-medium">
              {job.appliedDate
                ? formatDate(job.appliedDate)
                : t("jobs.notApplied")}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.aiMatch")}</p>
            {job.matchScore != null && matchData?.analyzed !== false ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <CircularScore score={job.matchScore} size="sm" />
                {matchData?.recommendation && (
                  <Badge variant="outline" className="capitalize">
                    {matchData.recommendation}
                  </Badge>
                )}
              </div>
            ) : (
              <p className="mt-1 font-medium">{t("jobs.notMatched")}</p>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.resume")}</p>
            <div className="mt-1 font-medium">
              {job.Resume?.File?.filePath ? (
                DownloadFileButton(
                  job.Resume.id!,
                  job.Resume.File.filePath,
                  job.Resume.title,
                  job.Resume.File.fileName,
                )
              ) : job.Resume?.id ? (
                <Link
                  href={`/dashboard/profile/resume/${job.Resume.id}`}
                  className="flex items-center gap-1 hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  {job.Resume.title}
                </Link>
              ) : (
                <p>-</p>
              )}
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("jobs.added")}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {job.createdAt ? formatDate(job.createdAt) : "-"}
              </span>
              {job.createdVia && (
                <Badge className="gap-1 bg-violet-500 dark:bg-violet-400">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("jobs.viaSource", { source: job.createdVia })}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {(job.jobUrl || (job.tags && job.tags.length > 0)) && (
          <div className="mt-6 pt-4 border-t flex flex-wrap items-center gap-4">
            {job.jobUrl && (
              <a
                href={formatUrl(job.jobUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {job.jobUrl}
              </a>
            )}
            {job.tags && job.tags.length > 0 && (
              <div className="ml-auto flex flex-wrap gap-1">
                {job.tags.map((tag) => (
                  <Badge key={tag.id} variant="secondary">
                    {tag.label}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
