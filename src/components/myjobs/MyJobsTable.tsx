"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Pin, StickyNote } from "lucide-react";
import { Badge } from "../ui/badge";
import { useState, type ReactNode } from "react";
import { JobResponse, JobStatus } from "@/models/job.model";
import Link from "next/link";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { CircularScore } from "@/components/CircularScore";
import { JobStatusBadgeMenu } from "./JobStatusBadgeMenu";
import { TooltipProvider } from "../ui/tooltip";
import { JobActionsMenu } from "./JobActionsMenu";
import { MatchJobButton } from "./MatchJobButton";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import {
  JobDragHandle,
  JobOrderDndProvider,
  JobSortableSection,
  partitionJobsByPin,
  useJobSortable,
} from "./jobs-container/JobOrderDnd";

type MyJobsTableProps = {
  jobs: JobResponse[];
  jobStatuses: JobStatus[];
  deleteJob: (id: string) => void;
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  deleteIsArchive?: boolean;
  timeZone?: string;
  // UI-RC-JOB-ORDER: custom sort shows the six-dot handle; any other sort
  // hides it. dragDisabled suspends dragging under an active search/filter.
  showDragHandles?: boolean;
  dragDisabled?: boolean;
  onMoveJob?: (jobId: string, afterJobId: string | null) => void;
  onTogglePin?: (jobId: string, pinned: boolean) => void;
};

import { getLocalizedJobSource, useI18n } from "@/i18n";

function SortableJobRow({
  id,
  showHandle,
  dragDisabled,
  children,
}: {
  id: string;
  showHandle: boolean;
  dragDisabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, style, handleProps, isDragging } = useJobSortable(
    id,
    !showHandle || dragDisabled,
  );
  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      data-dragging={isDragging || undefined}
      className={isDragging ? "relative z-10 bg-muted/80" : undefined}
    >
      {showHandle && (
        <TableCell className="w-[40px] px-1">
          <JobDragHandle handleProps={handleProps} disabled={dragDisabled} />
        </TableCell>
      )}
      {children}
    </TableRow>
  );
}

function MyJobsTable({
  jobs,
  jobStatuses,
  deleteJob,
  editJob,
  onChangeJobStatus,
  onAddNote,
  deleteIsArchive = false,
  timeZone,
  showDragHandles = false,
  dragDisabled = false,
  onMoveJob,
  onTogglePin,
}: MyJobsTableProps) {
  const { t, formatDate } = useI18n();
  const { t: tOrder } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  const [alertOpen, setAlertOpen] = useState(false);
  const [jobIdToDelete, setJobIdToDelete] = useState("");
  const { pinnedJobs, normalJobs } = partitionJobsByPin(jobs);

  const onDeleteJob = (jobId: string) => {
    setAlertOpen(true);
    setJobIdToDelete(jobId);
  };

  const renderRow = (job: JobResponse) => {
    const index = jobs.findIndex((item) => item.id === job.id);
    const sourceLabel = getLocalizedJobSource(job.JobSource, t);
    const pinned = job.pinnedAt != null;
    return (
      <SortableJobRow
        key={job.id}
        id={job.id}
        showHandle={showDragHandles}
        dragDisabled={dragDisabled}
      >
        <TableCell
          className="text-center tabular-nums text-muted-foreground"
          data-testid="job-row-number"
        >
          {index + 1}
        </TableCell>
        <TableCell className="hidden md:table-cell w-[120px] whitespace-nowrap">
          {job.appliedDate ? formatDate(job.appliedDate) : t("common.notAvailable")}
        </TableCell>
        <TableCell
          className="font-medium cursor-pointer max-w-[120px] md:max-w-[220px]"
        >
          <div className="flex items-center gap-1.5">
            {pinned && (
              <Pin
                className="h-3.5 w-3.5 shrink-0 fill-current text-primary"
                aria-label={tOrder("jobs.pinned")}
                data-testid="job-pinned-icon"
              />
            )}
            <Link
              href={`/dashboard/myjobs/${job?.id}`}
              className="block truncate rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {job.JobTitle?.label}
            </Link>
            {(job._count?.Notes ?? 0) > 0 && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5 shrink-0">
                <StickyNote className="h-3 w-3 mr-0.5" />
                {job._count!.Notes}
              </Badge>
            )}
          </div>
          <p className="break-words text-xs font-normal text-muted-foreground">
            {job.salaryRange || "-"}
          </p>
        </TableCell>
        <TableCell className="font-medium max-w-[100px] md:max-w-[160px]">
          <span className="block truncate">{job.Company?.label}</span>
        </TableCell>
        <TableCell className="hidden md:table-cell whitespace-nowrap max-w-[120px]">
          <span className="block truncate">{job.Location?.label}</span>
        </TableCell>
        <TableCell>
          <JobStatusBadgeMenu
            job={job}
            jobStatuses={jobStatuses}
            onChangeJobStatus={onChangeJobStatus}
            className="max-w-[10rem] justify-center overflow-hidden"
            timeZone={timeZone}
          />
        </TableCell>
        {!freshNativeFull && (
          <TableCell className="hidden md:table-cell text-center">
            {job.matchScore != null ? (
              <CircularScore
                score={job.matchScore}
                size="sm"
                animate={false}
                className="mx-auto"
              />
            ) : (
              <MatchJobButton jobId={job.id} />
            )}
          </TableCell>
        )}
        <TableCell className="hidden max-w-[10rem] md:table-cell">
          <span className="block truncate" title={sourceLabel}>
            {sourceLabel || "-"}
          </span>
        </TableCell>
        <TableCell>
          <JobActionsMenu
            job={job}
            jobStatuses={jobStatuses}
            editJob={editJob}
            onChangeJobStatus={onChangeJobStatus}
            onAddNote={onAddNote}
            onDeleteJob={onDeleteJob}
            onTogglePin={onTogglePin}
          />
        </TableCell>
      </SortableJobRow>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <JobOrderDndProvider jobs={jobs} onMoveJob={onMoveJob ?? (() => {})}>
        <Table>
          <TableHeader>
            <TableRow>
              {showDragHandles && (
                <TableHead className="w-[40px] px-1">
                  <span className="sr-only">{tOrder("jobs.dragToReorder")}</span>
                </TableHead>
              )}
              <TableHead className="w-[56px] text-center whitespace-nowrap">
                {t("jobs.rowNumber")}
              </TableHead>
              <TableHead className="hidden md:table-cell">{t("jobs.dateApplied")}</TableHead>
              <TableHead>{t("jobs.jobTitle")}</TableHead>
              <TableHead>{t("jobs.company")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("jobs.location")}</TableHead>
              <TableHead>{t("jobs.jobStatus")}</TableHead>
              {!freshNativeFull && (
                <TableHead className="hidden md:table-cell text-center">{t("jobs.matchTab")}</TableHead>
              )}
              <TableHead className="hidden md:table-cell">{t("jobs.jobSource")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <JobSortableSection ids={pinnedJobs.map((job) => job.id)}>
              {pinnedJobs.map(renderRow)}
            </JobSortableSection>
            <JobSortableSection ids={normalJobs.map((job) => job.id)}>
              {normalJobs.map(renderRow)}
            </JobSortableSection>
          </TableBody>
        </Table>
      </JobOrderDndProvider>
      <DeleteAlertDialog
        pageTitle="job"
        alertTitle={
          deleteIsArchive ? t("jobs.archiveConfirm") : t("jobs.deleteConfirm")
        }
        alertDescription={
          deleteIsArchive ? t("jobs.archiveConfirmDescription") : undefined
        }
        actionLabel={deleteIsArchive ? t("jobs.archiveAction") : undefined}
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={() => deleteJob(jobIdToDelete)}
      />
    </TooltipProvider>
  );
}

export default MyJobsTable;
