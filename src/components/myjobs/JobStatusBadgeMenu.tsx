"use client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import { JobStatusBadge } from "./JobStatusBadge";
import { JobStatusMenuItems } from "./JobStatusMenuItems";
import { JobResponse, JobStatus } from "@/models/job.model";
import { useI18n, getLocalizedJobStatus } from "@/i18n";

type JobStatusBadgeMenuProps = {
  job: JobResponse;
  jobStatuses: JobStatus[];
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  className?: string;
};

export function JobStatusBadgeMenu({
  job,
  jobStatuses,
  onChangeJobStatus,
  className,
}: JobStatusBadgeMenuProps) {
  const { t } = useI18n();
  const currentStatus = getLocalizedJobStatus(job.Status, t);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("jobs.changeStatusCurrently", {
                status: currentStatus,
              })}
              className="cursor-pointer rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <JobStatusBadge job={job} className={className} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("jobs.clickToChangeStatus")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="p-0">
        <JobStatusMenuItems
          jobStatuses={jobStatuses}
          currentStatusId={job.Status?.id ?? ""}
          onSelectStatus={(status) => onChangeJobStatus(job.id, status)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
