"use client";
import { useState } from "react";
import { JobResponse, JobStatus } from "@/models/job.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { JobCard } from "./JobCard";
import { useI18n } from "@/i18n";

type MyJobsGridProps = {
  jobs: JobResponse[];
  jobStatuses: JobStatus[];
  deleteJob: (id: string) => void;
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  deleteIsArchive?: boolean;
  timeZone?: string;
};

function MyJobsGrid({
  jobs,
  jobStatuses,
  deleteJob,
  editJob,
  onChangeJobStatus,
  onAddNote,
  deleteIsArchive = false,
  timeZone,
}: MyJobsGridProps) {
  const { t } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const [jobIdToDelete, setJobIdToDelete] = useState("");

  const onDeleteJob = (jobId: string) => {
    setAlertOpen(true);
    setJobIdToDelete(jobId);
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {jobs.map((job: JobResponse) => (
          <JobCard
            key={job.id}
            job={job}
            jobStatuses={jobStatuses}
            editJob={editJob}
            onChangeJobStatus={onChangeJobStatus}
            onAddNote={onAddNote}
            onDeleteJob={onDeleteJob}
            timeZone={timeZone}
          />
        ))}
      </div>
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
