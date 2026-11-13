"use client";
import { useState, type ReactNode } from "react";
import { JobResponse, JobStatus } from "@/models/job.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { JobCard } from "./JobCard";
import { useI18n } from "@/i18n";
import { rectSortingStrategy } from "@dnd-kit/sortable";
import {
  JobDragHandle,
  JobOrderDndProvider,
  JobSortableSection,
  partitionJobsByPin,
  useJobSortable,
} from "./jobs-container/JobOrderDnd";

type MyJobsGridProps = {
  jobs: JobResponse[];
  jobStatuses: JobStatus[];
  deleteJob: (id: string) => void;
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  deleteIsArchive?: boolean;
  timeZone?: string;
  showDragHandles?: boolean;
  dragDisabled?: boolean;
  onMoveJob?: (jobId: string, afterJobId: string | null) => void;
  onTogglePin?: (jobId: string, pinned: boolean) => void;
};

// Card drag handle sits at the card's upper-left; listeners live only on the
// handle so title links and menus never start a drag.
function SortableJobCard({
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
    <div
      ref={setNodeRef}
      style={style}
      className={`relative ${isDragging ? "z-10 opacity-70" : ""}`}
    >
      {showHandle && (
        <JobDragHandle
          handleProps={handleProps}
          disabled={dragDisabled}
          className="absolute left-1 top-1 z-10 bg-card/80 backdrop-blur-sm"
        />
      )}
      {children}
    </div>
  );
}

function MyJobsGrid({
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
}: MyJobsGridProps) {
  const { t } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const [jobIdToDelete, setJobIdToDelete] = useState("");
  const { pinnedJobs, normalJobs } = partitionJobsByPin(jobs);

  const onDeleteJob = (jobId: string) => {
    setAlertOpen(true);
    setJobIdToDelete(jobId);
  };

  const renderCard = (job: JobResponse) => (
    <SortableJobCard
      key={job.id}
      id={job.id}
      showHandle={showDragHandles}
      dragDisabled={dragDisabled}
    >
      <JobCard
        job={job}
        jobStatuses={jobStatuses}
        editJob={editJob}
        onChangeJobStatus={onChangeJobStatus}
        onAddNote={onAddNote}
        onDeleteJob={onDeleteJob}
        onTogglePin={onTogglePin}
        timeZone={timeZone}
      />
    </SortableJobCard>
  );

  return (
    <>
      <JobOrderDndProvider jobs={jobs} onMoveJob={onMoveJob ?? (() => {})}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          <JobSortableSection
            ids={pinnedJobs.map((job) => job.id)}
            strategy={rectSortingStrategy}
          >
            {pinnedJobs.map(renderCard)}
          </JobSortableSection>
          <JobSortableSection
            ids={normalJobs.map((job) => job.id)}
            strategy={rectSortingStrategy}
          >
            {normalJobs.map(renderCard)}
          </JobSortableSection>
        </div>
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
    </>
  );
}

export default MyJobsGrid;
