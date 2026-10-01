import Papa from "papaparse";
import { format } from "date-fns";
import {
  getLocalizedJobSource,
  getLocalizedJobStatus,
  getLocalizedJobType,
  getLocalizedWorkplaceType,
} from "@/i18n/helpers";
import type { TranslateFn } from "@/i18n/types";

type CsvLabel = { label?: string; value?: string } | null;
export type JobCsvInput = {
  createdAt?: Date | string | null;
  applied?: boolean;
  appliedDate?: Date | string | null;
  Company?: CsvLabel;
  JobTitle?: CsvLabel;
  jobType?: string | null;
  workplaceType?: string | null;
  Location?: CsvLabel;
  JobSource?: CsvLabel;
  Status?: CsvLabel;
};

// Excel on Windows needs a UTF-8 BOM to detect encoding for CJK text.
export const CSV_UTF8_BOM = "\uFEFF";

export const JOB_CSV_FIELD_KEYS = [
  "index",
  "createdAt",
  "applied",
  "appliedDate",
  "Company",
  "JobTitle",
  "jobType",
  "workplaceType",
  "Location",
  "JobSource",
  "Status",
] as const;

export type JobCsvFieldKey = (typeof JOB_CSV_FIELD_KEYS)[number];

const HEADER_I18N: Record<JobCsvFieldKey, string> = {
  index: "jobs.rowNumber",
  createdAt: "jobs.dateAdded",
  applied: "jobs.statuses.applied",
  appliedDate: "jobs.dateApplied",
  Company: "jobs.company",
  JobTitle: "jobs.jobTitle",
  jobType: "jobs.jobType",
  workplaceType: "jobs.workplaceType",
  Location: "jobs.jobLocation",
  JobSource: "jobs.jobSourceLabel",
  Status: "jobs.jobStatus",
};

const extractLabel = (field: CsvLabel | undefined): string => {
  return field?.label || "N/A";
};

export function jobCsvHeaders(t: TranslateFn): string[] {
  return JOB_CSV_FIELD_KEYS.map((key) => t(HEADER_I18N[key]));
}

export function transformJobForCsv(
  job: JobCsvInput,
  index: number,
  t: TranslateFn,
): Record<string, string> {
  return {
    index: String(index + 1),
    createdAt: job.createdAt ? format(new Date(job.createdAt), "yyyy-MM-dd") : "N/A",
    applied: job.applied ? t("common.yes") : t("common.no"),
    appliedDate: job.appliedDate
      ? format(new Date(job.appliedDate), "yyyy-MM-dd")
      : "N/A",
    Company: extractLabel(job.Company),
    JobTitle: extractLabel(job.JobTitle),
    jobType: getLocalizedJobType(job.jobType, t) || t("common.unknown"),
    workplaceType: getLocalizedWorkplaceType(job.workplaceType, t) || t("common.notAvailable"),
    Location: extractLabel(job.Location),
    JobSource: job.JobSource
      ? getLocalizedJobSource(job.JobSource, t)
      : "N/A",
    Status: job.Status
      ? getLocalizedJobStatus(job.Status, t)
      : "N/A",
  };
}

export function unparseJobsCsv(
  rows: Record<string, string>[],
  t: TranslateFn,
  { header }: { header: boolean },
): string {
  const headers = jobCsvHeaders(t);
  const data = rows.map((row) =>
    JOB_CSV_FIELD_KEYS.map((key) => row[key] ?? ""),
  );
  return Papa.unparse({ fields: headers, data }, { header });
}
