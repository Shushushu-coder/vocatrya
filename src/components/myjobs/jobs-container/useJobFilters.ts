"use client";
import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Company, JobLocation, JobSource, JobTitle } from "@/models/job.model";

const FILTER_PARAMS = [
  "company",
  "title",
  "location",
  "source",
  "applied",
  "filter",
  "search",
] as const;

// The URL is the single source of truth for the job list filters. Values are
// derived from useSearchParams on every render, so refresh/back/forward can
// never desync the UI, and each clear handler only deletes its own param.
export function useJobFilters({
  companies,
  titles,
  locations,
  sources,
}: {
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryParams = useSearchParams();

  const companyFilter = queryParams.get("company");
  const titleFilter = queryParams.get("title");
  const locationFilter = queryParams.get("location");
  const sourceFilter = queryParams.get("source");
  const appliedFilter = queryParams.get("applied") === "true";

  const companyLabel = companyFilter
    ? companies.find((c) => c.value === companyFilter)?.label
    : null;

  const titleLabel = titleFilter
    ? titles.find((t) => t.value === titleFilter)?.label
    : null;

  const locationLabel = locationFilter
    ? locations.find((l) => l.value === locationFilter)?.label
    : null;

  const sourceLabel = sourceFilter
    ? sources.find((s) => s.value === sourceFilter)?.label
    : null;

  // Chip clears must merge into the latest URL state — a debounced search
  // write landing between render and click must not be dropped.
  const latestParams = useRef(queryParams);
  latestParams.current = queryParams;

  const pushParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(latestParams.current.toString());
    mutate(params);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const clearCompanyFilter = () =>
    pushParams((params) => params.delete("company"));

  const clearTitleFilter = () => pushParams((params) => params.delete("title"));

  const clearLocationFilter = () =>
    pushParams((params) => params.delete("location"));

  const clearSourceFilter = () => pushParams((params) => params.delete("source"));

  const clearAppliedFilter = () =>
    pushParams((params) => params.delete("applied"));

  const clearAllFilters = () =>
    pushParams((params) => {
      for (const key of FILTER_PARAMS) params.delete(key);
    });

  return {
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
  };
}
