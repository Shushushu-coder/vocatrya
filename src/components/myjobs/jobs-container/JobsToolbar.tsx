"use client";
import { File, ListFilter, RefreshCw, X } from "lucide-react";
import { CardHeader, CardTitle } from "../../ui/card";
import { Button } from "../../ui/button";
import { SearchInput } from "../../SearchInput";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { RecordsCount } from "../../RecordsCount";
import { JobsViewToggle } from "../JobsViewToggle";
import { AddJob } from "../AddJob";
import {
  Company,
  JobLocation,
  JobResponse,
  JobSource,
  JobStatus,
  JobsViewMode,
  JobTitle,
  Tag,
} from "@/models/job.model";
import { useI18n } from "@/i18n";
import type { AbRolloutScope } from "@/lib/career/capabilities";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";

function FilterChip({
  label,
  onClear,
  testId,
}: {
  label: string;
  onClear: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={label}
      data-testid={testId}
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-sm font-medium text-primary transition-colors motion-reduce:transition-none hover:bg-primary/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="max-w-[12rem] truncate">{label}</span>
      <X className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

// Presentational: the Jobs card header — title/count, active filter chips,
// view toggle, search, filter select, export and Add Job.
export function JobsToolbar({
  jobsCount,
  totalJobs,
  initialLoading,
  viewMode,
  onChangeViewMode,
  companyLabel,
  onClearCompanyFilter,
  titleLabel,
  onClearTitleFilter,
  locationLabel,
  onClearLocationFilter,
  sourceLabel,
  onClearSourceFilter,
  appliedLabel,
  onClearAppliedFilter,
  onReload,
  searchTerm,
  onSearchTermChange,
  filterKey,
  onFilterChange,
  onDownload,
  statuses,
  companies,
  titles,
  locations,
  sources,
  tags,
  editJob,
  resetEditJob,
  addJobInitialOpen,
  hideAddJob = false,
  careerRuntimeMode,
  abRolloutScope,
}: {
  jobsCount: number;
  totalJobs: number;
  initialLoading: boolean;
  viewMode: JobsViewMode;
  onChangeViewMode: (mode: JobsViewMode) => void;
  companyLabel?: string | null;
  onClearCompanyFilter: () => void;
  titleLabel?: string | null;
  onClearTitleFilter: () => void;
  locationLabel?: string | null;
  onClearLocationFilter: () => void;
  sourceLabel?: string | null;
  onClearSourceFilter: () => void;
  appliedLabel?: string | null;
  onClearAppliedFilter: () => void;
  onReload: () => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  filterKey: string;
  onFilterChange: (filterBy: string) => void;
  onDownload: () => void;
  statuses: JobStatus[];
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
  tags: Tag[];
  editJob: JobResponse | null;
  resetEditJob: () => void;
  addJobInitialOpen: boolean;
  hideAddJob?: boolean;
  careerRuntimeMode?: string;
  abRolloutScope?: AbRolloutScope;
}) {
  const { t } = useI18n();
  const hideDiscoveryFilters = isAbJobReadMode(
    careerRuntimeMode,
    abRolloutScope,
  );

  return (
    <CardHeader className="w-full min-w-0 flex-row flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <CardTitle className="text-foreground">{t("jobs.title")}</CardTitle>
        {!initialLoading && totalJobs > 0 && (
          <RecordsCount count={jobsCount} total={totalJobs} label={t("common.jobsLabel")} />
        )}
      </div>
      <div className="flex max-w-full min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        <JobsViewToggle value={viewMode} onChange={onChangeViewMode} />
        {companyLabel && (
          <FilterChip label={companyLabel} onClear={onClearCompanyFilter} />
        )}
        {titleLabel && (
          <FilterChip label={titleLabel} onClear={onClearTitleFilter} />
        )}
        {locationLabel && (
          <FilterChip label={locationLabel} onClear={onClearLocationFilter} />
        )}
        {sourceLabel && (
          <FilterChip label={sourceLabel} onClear={onClearSourceFilter} />
        )}
        {appliedLabel && (
          <FilterChip
            label={appliedLabel}
            onClear={onClearAppliedFilter}
            testId="applied-filter-badge"
          />
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-8 p-0"
          disabled={initialLoading}
          title={t("jobs.reloadJobs")}
          onClick={onReload}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 motion-reduce:animate-none ${initialLoading ? "animate-spin" : ""}`}
          />
          <span className="sr-only">{t("jobs.reloadJobs")}</span>
        </Button>
        <SearchInput
          value={searchTerm}
          onChange={onSearchTermChange}
          placeholder={t("jobs.searchPlaceholder")}
        />
        <Select value={filterKey} onValueChange={onFilterChange}>
          <SelectTrigger
            className="h-8 w-[min(100%,14rem)] max-w-full overflow-hidden [&_span]:truncate"
            data-testid="job-filter-select"
          >
            <ListFilter className="h-3.5 w-3.5" />
            <SelectValue placeholder={t("common.filter")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("jobs.filterByStatus")}</SelectLabel>
              <SelectSeparator />
              <SelectItem value="none">
                {hideDiscoveryFilters
                  ? t("jobs.allJobs")
                  : t("jobs.allExceptDismissed")}
              </SelectItem>
              <SelectItem value="new">{t("jobs.statuses.new")}</SelectItem>
              <SelectItem value="applied">{t("jobs.statuses.applied")}</SelectItem>
              <SelectItem value="interview">{t("jobs.statuses.interview")}</SelectItem>
              <SelectItem value="draft">{t("jobs.statuses.draft")}</SelectItem>
              <SelectItem value="rejected">{t("jobs.statuses.rejected")}</SelectItem>
              <SelectItem value="PT">{t("jobs.jobTypes.part-time")}</SelectItem>
              {!hideDiscoveryFilters && (
                <SelectItem value="accepted">{t("automations.acceptJob")}</SelectItem>
              )}
              {!hideDiscoveryFilters && (
                <SelectItem value="dismissed">{t("automations.dismissJob")}</SelectItem>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1"
          disabled={initialLoading}
          onClick={onDownload}
        >
          <File className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
            {t("common.export")}
          </span>
        </Button>
        {!hideAddJob && (
          <AddJob
            jobStatuses={statuses}
            companies={companies}
            jobTitles={titles}
            locations={locations}
            jobSources={sources}
            tags={tags}
            editJob={editJob}
            resetEditJob={resetEditJob}
            initialOpen={addJobInitialOpen}
            careerRuntimeMode={careerRuntimeMode}
            abRolloutScope={abRolloutScope}
            onSaved={onReload}
          />
        )}
      </div>
    </CardHeader>
  );
}
