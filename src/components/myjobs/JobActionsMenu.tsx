"use client";
import { ListCollapse, MoreVertical, Pencil, Pin, PinOff, StickyNote, Tags, Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { JobResponse, JobStatus } from "@/models/job.model";
import { JobStatusMenuItems } from "./JobStatusMenuItems";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

type JobActionsMenuProps = {
  job: JobResponse;
  jobStatuses: JobStatus[];
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
  onTogglePin?: (jobId: string, pinned: boolean) => void;
};

export function JobActionsMenu({
  job,
  jobStatuses,
  editJob,
  onChangeJobStatus,
  onAddNote,
  onDeleteJob,
  onTogglePin,
}: JobActionsMenuProps) {
  const router = useRouter();
  const { t } = useI18n();
  const { t: tOrder } = useI18n();
  const { jobMutationsEnabled } = useCareerSurfaces();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-haspopup="true"
          size="icon"
          variant="ghost"
          data-testid="job-actions-menu-btn"
        >
          <MoreVertical className="h-4 w-4" />
          <span className="sr-only">{t("jobs.toggleMenu")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => router.push(`/dashboard/myjobs/${job?.id}`)}
          >
            <ListCollapse className="mr-2 h-4 w-4" />
            {t("jobs.viewDetails")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => editJob(job.id)}
            disabled={!jobMutationsEnabled}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t("jobs.editJob")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => onAddNote(job.id)}
            disabled={!jobMutationsEnabled}
          >
            <StickyNote className="mr-2 h-4 w-4" />
            {t("jobs.addANote")}
          </DropdownMenuItem>
          {onTogglePin && (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => onTogglePin(job.id, job.pinnedAt == null)}
              disabled={!jobMutationsEnabled}
              data-testid="job-pin-menu-item"
            >
              {job.pinnedAt != null ? (
                <>
                  <PinOff className="mr-2 h-4 w-4" />
                  {tOrder("jobs.unpinJob")}
                </>
              ) : (
                <>
                  <Pin className="mr-2 h-4 w-4" />
                  {tOrder("jobs.pinJob")}
                </>
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!jobMutationsEnabled}>
              <Tags className="mr-2 h-4 w-4" />
              {t("jobs.changeStatus")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="p-0">
                <JobStatusMenuItems
                  jobStatuses={jobStatuses}
                  currentStatusId={job.Status.id}
                  onSelectStatus={(status) => onChangeJobStatus(job.id, status)}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-600 cursor-pointer"
            onClick={() => onDeleteJob(job.id)}
            disabled={!jobMutationsEnabled}
          >
            <Trash className="mr-2 h-4 w-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
