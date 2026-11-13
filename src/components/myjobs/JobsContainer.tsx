"use client";
import { useState } from "react";
import { Card, CardContent, CardFooter } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Loader } from "lucide-react";
import {
  deleteJobById,
  getJobDetails,
  updateJobStatus,
} from "@/actions/job.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  Company,
  JobLocation,
  JobSource,
  JobStatus,
  JobTitle,
  Tag,
} from "@/models/job.model";
import Loading from "../Loading";
import { useRouter } from "next/navigation";
import MyJobsTable from "./MyJobsTable";
import MyJobsGrid from "./MyJobsGrid";
import { NoteDialog } from "./NoteDialog";
import { useJobFilters } from "./jobs-container/useJobFilters";
import { useJobsList } from "./jobs-container/useJobsList";
import { downloadJobsList } from "./jobs-container/downloadJobsCsv";
import { JobsToolbar } from "./jobs-container/JobsToolbar";
import { getLocalizedJobSource, useI18n } from "@/i18n";
import type { AbRolloutScope } from "@/lib/career/capabilities";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

type MyJobsProps = {
  statuses: JobStatus[];
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
  tags: Tag[];
  allowJobMutations?: boolean;
  careerRuntimeMode?: string;
  abRolloutScope?: AbRolloutScope;
};

function JobsContainer({
  statuses,
  companies,
  titles,
  locations,
  sources,
  tags,
  allowJobMutations = true,
  careerRuntimeMode,
  abRolloutScope,
}: MyJobsProps) {
  const router = useRouter();
  const { t } = useI18n();
  const { jobMutationsEnabled } = useCareerSurfaces();
  const deleteIsArchive = isAbJobReadMode(careerRuntimeMode, abRolloutScope);
  const [editJob, setEditJob] = useState(null);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteJobId, setNoteJobId] = useState("");

  const {
    queryParams,
    companyFilter,
    titleFilter,
    locationFilter,
    sourceFilter,
    appliedFilter,
    companyLabel,
    titleLabel,
    locationLabel,
    sourceLabel,
    clearCompanyFilter,
    clearTitleFilter,
    clearLocationFilter,
    clearSourceFilter,
    clearAppliedFilter,
    clearAllFilters,
  } = useJobFilters({ companies, titles, locations, sources });

  const {
    jobs,
    viewMode,
    onChangeViewMode,
    totalJobs,
    filterKey,
    sortBy,
    onSortChange,
    moveJob,
    toggleJobPinned,
    searchTerm,
    setSearchTerm,
    initialLoading,
    loadingMore,
    loadError,
    timeZone,
    loadJobs,
    reloadJobs,
    retryLoad,
    onFilterChange,
    sentinelRef,
  } = useJobsList({
    companyFilter,
    appliedFilter,
    titleFilter,
    locationFilter,
    sourceFilter,
  });

  const onDeleteJob = async (jobId: string) => {
    const { res, success, message } = await deleteJobById(jobId);
    if (success) {
      toastSuccess(
        deleteIsArchive ? t("jobs.archivedSuccess") : t("jobs.deletedSuccess"),
      );
    } else {
      toastError(message);
    }
    reloadJobs();
  };

  const onEditJob = async (jobId: string) => {
    const { job, success, message } = await getJobDetails(jobId);
    if (!success) {
      toastError(message);
      return;
    }
    setEditJob(job);
  };

  const onChangeJobStatus = async (jobId: string, jobStatus: JobStatus) => {
    const { success, message } = await updateJobStatus(jobId, jobStatus);
    if (success) {
      router.refresh();
      toastSuccess(t("jobs.updatedSuccess"));
    } else {
      toastError(message);
    }
    reloadJobs();
  };

  const resetEditJob = () => {
    setEditJob(null);
  };

  const onAddNote = (jobId: string) => {
    setNoteJobId(jobId);
    setNoteDialogOpen(true);
  };

  const hasActiveFilters = !!(
    companyFilter ||
    titleFilter ||
    locationFilter ||
    sourceFilter ||
    appliedFilter ||
    searchTerm ||
    filterKey !== "none"
  );

  // UI-RC-JOB-ORDER: only the saved custom order is draggable. An active
  // search/filter pauses dragging (pinning stays available) and any other
  // sort hides the handles entirely.
  const customSortActive = sortBy === "custom";
  const dragDisabled =
    !jobMutationsEnabled || (customSortActive && hasActiveFilters);

  return (
    <>
      <Card className="min-w-0" x-chunk="dashboard-06-chunk-0">
        <JobsToolbar
          jobsCount={jobs.length}
          totalJobs={totalJobs}
          initialLoading={initialLoading}
          viewMode={viewMode}
          onChangeViewMode={onChangeViewMode}
          companyLabel={companyLabel}
          onClearCompanyFilter={clearCompanyFilter}
          titleLabel={titleLabel}
          onClearTitleFilter={clearTitleFilter}
          locationLabel={locationLabel}
          onClearLocationFilter={clearLocationFilter}
          sourceLabel={
            sourceFilter
              ? getLocalizedJobSource(
                  sources.find((source) => source.value === sourceFilter) ??
                    sourceLabel,
                  t,
                ) || null
              : null
          }
          onClearSourceFilter={clearSourceFilter}
          appliedLabel={appliedFilter ? t("jobs.statuses.applied") : null}
          onClearAppliedFilter={clearAppliedFilter}
          onReload={() => loadJobs(1)}
          searchTerm={searchTerm}
          onSearchTermChange={setSearchTerm}
          filterKey={filterKey}
          onFilterChange={onFilterChange}
          sortBy={sortBy}
          onSortChange={onSortChange}
          dragPausedByFilters={customSortActive && hasActiveFilters}
          onDownload={() => downloadJobsList(t)}
          statuses={statuses}
          companies={companies}
          titles={titles}
          locations={locations}
          sources={sources}
          tags={tags}
          editJob={editJob}
          resetEditJob={resetEditJob}
          addJobInitialOpen={
            allowJobMutations && queryParams.get("add-job") === "true"
          }
          hideAddJob={!allowJobMutations}
          careerRuntimeMode={careerRuntimeMode}
          abRolloutScope={abRolloutScope}
          timeZone={timeZone}
        />
        <CardContent>
          {initialLoading && <Loading />}
          {!initialLoading && loadError !== null && (
            <Alert variant="destructive" className="mb-4" data-testid="jobs-load-error">
              <AlertTitle>{t("jobs.loadFailed")}</AlertTitle>
              <AlertDescription>
                {loadError ? <p>{loadError}</p> : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={initialLoading || loadingMore}
                  onClick={() => void retryLoad()}
                >
                  {t("common.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!initialLoading && loadError === null && jobs.length === 0 && (
            <div
              className="flex flex-col items-center gap-2 py-10 text-center"
              data-testid="jobs-empty-state"
            >
              {hasActiveFilters ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t("jobs.noJobsMatchFilters")}
                  </p>
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t("jobs.clearFilters")}
                  </button>
                </>
              ) : (
                <>
                  <p className="font-medium">{t("jobs.noJobsFound")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("jobs.noJobsDescription")}
                  </p>
                </>
              )}
            </div>
          )}
          {jobs.length > 0 &&
            (viewMode === "cards" ? (
              <MyJobsGrid
                jobs={jobs}
                jobStatuses={statuses}
                deleteJob={onDeleteJob}
                editJob={onEditJob}
                onChangeJobStatus={onChangeJobStatus}
                onAddNote={onAddNote}
                deleteIsArchive={deleteIsArchive}
                timeZone={timeZone}
                showDragHandles={customSortActive}
                dragDisabled={dragDisabled}
                onMoveJob={moveJob}
                onTogglePin={toggleJobPinned}
              />
            ) : (
              <MyJobsTable
                jobs={jobs}
                jobStatuses={statuses}
                deleteJob={onDeleteJob}
                editJob={onEditJob}
                onChangeJobStatus={onChangeJobStatus}
                onAddNote={onAddNote}
                deleteIsArchive={deleteIsArchive}
                timeZone={timeZone}
                showDragHandles={customSortActive}
                dragDisabled={dragDisabled}
                onMoveJob={moveJob}
                onTogglePin={toggleJobPinned}
              />
            ))}
          {loadError === null && jobs.length < totalJobs && (
            <div ref={sentinelRef} className="flex justify-center p-4">
              {loadingMore && (
                <Loader className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
              )}
            </div>
          )}
        </CardContent>
        <CardFooter></CardFooter>
      </Card>
      <NoteDialog
        open={noteDialogOpen}
        onOpenChange={setNoteDialogOpen}
        jobId={noteJobId}
        onSaved={() => reloadJobs()}
      />
    </>
  );
}

export default JobsContainer;
