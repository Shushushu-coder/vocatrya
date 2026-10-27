import Papa from "papaparse";
import { format } from "date-fns";
import {
  getLocalizedJobSource,
  getLocalizedJobStatus,
  getLocalizedJobType,
  getLocalizedWorkplaceType,
} from "@/i18n/helpers";
import type { TranslateFn } from "@/i18n/types";
import { jobDeadlineCsvCell } from "./deadlineTime";

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
  salaryRange?: string | null;
  // Deadline triple: dueDate is the instant-carrier projection
  // (legacy Job.dueDate / opportunity.deadline), deadlineOn the calendar day.
  dueDate?: Date | string | null;
  deadlineOn?: string | null;
  deadlinePrecision?: string | null;
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
  // Appended last so every pre-existing column keeps its position.
  "salaryRange",
  "deadline",
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
  salaryRange: "jobs.salary",
  deadline: "jobs.deadline",
};

// Interim until the jobs.deadline dictionary entry lands (tracked
// separately): translate() echoes the raw key when missing, so fall back
// to a human-readable header per locale.
const HEADER_FALLBACK: Partial<Record<JobCsvFieldKey, Record<string, string>>> = {
  deadline: { en: "Deadline", "zh-CN": "截止日期" },
};

const extractLabel = (field: CsvLabel | undefined): string => {
  return field?.label || "N/A";
};

export function jobCsvHeaders(t: TranslateFn, locale?: string): string[] {
  return JOB_CSV_FIELD_KEYS.map((key) => {
    const text = t(HEADER_I18N[key]);
    if (text !== HEADER_I18N[key]) return text;
    return (
      HEADER_FALLBACK[key]?.[locale === "zh-CN" ? "zh-CN" : "en"] ?? text
    );
  });
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
    // User-entered raw text: never localized, never substituted — null stays
    // an empty cell so "N/A" can't be mistaken for a real salary value.
    salaryRange: job.salaryRange ?? "",
    // dateOnly exports verbatim ("YYYY-MM-DD", no tz drift); instants export
    // as ISO-8601 UTC; absent stays an empty cell like salaryRange.
    deadline: jobDeadlineCsvCell(job),
  };
}

export function unparseJobsCsv(
  rows: Record<string, string>[],
  t: TranslateFn,
  { header }: { header: boolean },
  locale?: string,
): string {
  const headers = jobCsvHeaders(t, locale);
  const data = rows.map((row) =>
    JOB_CSV_FIELD_KEYS.map((key) => row[key] ?? ""),
  );
  return Papa.unparse({ fields: headers, data }, { header });
}
