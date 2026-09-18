"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { StickyNote } from "lucide-react";
import { Badge } from "../ui/badge";
import { format } from "date-fns";
import { useState } from "react";
import { JobResponse, JobStatus } from "@/models/job.model";
import Link from "next/link";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { CircularScore } from "@/components/CircularScore";
import { JobStatusBadgeMenu } from "./JobStatusBadgeMenu";
import { TooltipProvider } from "../ui/tooltip";
import { JobActionsMenu } from "./JobActionsMenu";
import { MatchJobButton } from "./MatchJobButton";
import { CompanyLogo } from "./CompanyLogo";

type MyJobsTableProps = {
  jobs: JobResponse[];
  jobStatuses: JobStatus[];
  deleteJob: (id: string) => void;
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  deleteIsArchive?: boolean;
};

import { useI18n } from "@/i18n";

function MyJobsTable({
  jobs,
  jobStatuses,
  deleteJob,
  editJob,
  onChangeJobStatus,
  onAddNote,
  deleteIsArchive = false,
}: MyJobsTableProps) {
  const { t, formatDate } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const [jobIdToDelete, setJobIdToDelete] = useState("");

  const onDeleteJob = (jobId: string) => {
    setAlertOpen(true);
    setJobIdToDelete(jobId);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden w-[100px] sm:table-cell">
              <span className="sr-only">{t("jobs.company")}</span>
            </TableHead>
            <TableHead className="hidden md:table-cell">{t("jobs.dateApplied")}</TableHead>
            <TableHead>{t("jobs.jobTitle")}</TableHead>
            <TableHead>{t("jobs.company")}</TableHead>
            <TableHead className="hidden md:table-cell">{t("jobs.location")}</TableHead>
            <TableHead>{t("jobs.jobStatus")}</TableHead>
            <TableHead className="hidden md:table-cell text-center">{t("jobs.matchTab")}</TableHead>
            <TableHead className="hidden md:table-cell">{t("jobs.jobSource")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job: JobResponse) => {
            return (
              <TableRow key={job.id}>
                <TableCell className="hidden sm:table-cell">
                  <CompanyLogo
                    logoUrl={job.Company?.logoUrl}
                    className="h-8 w-8 min-w-8"
                  />
                </TableCell>
                <TableCell className="hidden md:table-cell w-[120px] whitespace-nowrap">
                  {job.appliedDate ? formatDate(job.appliedDate) : t("common.notAvailable")}
                </TableCell>
                <TableCell
                  className="font-medium cursor-pointer max-w-[120px] md:max-w-[220px]"
                >
                  <div className="flex items-center gap-1.5">
                    <Link href={`/dashboard/myjobs/${job?.id}`} className="block truncate">
                      {job.JobTitle?.label}
                    </Link>
                    {(job._count?.Notes ?? 0) > 0 && (
                      <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5 shrink-0">
                        <StickyNote className="h-3 w-3 mr-0.5" />
                        {job._count!.Notes}
                      </Badge>
                    )}
                  </div>
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
                    className="w-[110px] whitespace-nowrap justify-center"
                  />
                </TableCell>
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
                <TableCell className="hidden md:table-cell">
                  {job.JobSource?.label}
                </TableCell>
                <TableCell>
                  <JobActionsMenu
                    job={job}
                    jobStatuses={jobStatuses}
                    editJob={editJob}
                    onChangeJobStatus={onChangeJobStatus}
                    onAddNote={onAddNote}
                    onDeleteJob={onDeleteJob}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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
