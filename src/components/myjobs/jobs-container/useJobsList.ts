"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getJobsList } from "@/actions/job.actions";
import { toastError } from "@/lib/toast";
import { JobResponse, JobsViewMode } from "@/models/job.model";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";
import { useAgentChat } from "@/components/agent/AgentChatProvider";

// Owns the job list itself: pagination, search, view mode, infinite scroll,
// and the reload triggered when the agent chat writes job data.
//
// `filter` (status/type/discovery) and `search` live in the URL so refresh and
// browser back/forward restore the exact view; the list reloads whenever the
// URL-derived filters change. `searchTerm` is the immediate input state — it
// is debounced into the URL via router.replace so typing does not spam the
// history stack.
export function useJobsList({
  companyFilter,
  appliedFilter,
  titleFilter,
  locationFilter,
  sourceFilter,
}: {
  companyFilter: string | null;
  appliedFilter: boolean;
  titleFilter: string | null;
  locationFilter: string | null;
  sourceFilter: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { jobWrites } = useAgentChat();
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [viewMode, setViewMode] = useState<JobsViewMode>("table");
  const [page, setPage] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // URL-derived filter state
  const filterKey = searchParams.get("filter") ?? "none";
  const searchParam = searchParams.get("search") ?? "";
  const [searchTerm, setSearchTerm] = useState(searchParam);

  // Keep the input in sync with the URL (back/forward, chip clears, reload).
  useEffect(() => {
    setSearchTerm(searchParam);
  }, [searchParam]);

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

  // Debounced URL writes must merge with the latest params, not the snapshot
  // from the render that scheduled them — a chip/filter change landing inside
  // the debounce window would otherwise be clobbered.
  const latestParams = useRef(searchParams);
  latestParams.current = searchParams;

  const setSearch = (value: string) => {
    setSearchTerm(value);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      const params = new URLSearchParams(latestParams.current.toString());
      if (value) params.set("search", value);
      else params.delete("search");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    }, 300);
  };

  const onFilterChange = (filterBy: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (filterBy === "none") params.delete("filter");
    else params.set("filter", filterBy);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  // Read after mount: localStorage is unavailable during SSR, so seeding the
  // initial state from it would cause a hydration mismatch.
  useEffect(() => {
    const saved = getFromLocalStorage(
      APP_CONSTANTS.JOBS_VIEW_MODE_STORAGE_KEY,
      null,
    );
    if (saved === "cards" || saved === "table") setViewMode(saved);
  }, []);

  const onChangeViewMode = (mode: JobsViewMode) => {
    setViewMode(mode);
    saveToLocalStorage(APP_CONSTANTS.JOBS_VIEW_MODE_STORAGE_KEY, mode);
  };

  const jobsPerPage = APP_CONSTANTS.RECORDS_PER_PAGE;

  const loadJobs = useCallback(
    async (page: number) => {
      if (page === 1) setInitialLoading(true);
      else setLoadingMore(true);
      const { success, data, total, message } = await getJobsList(
        page,
        jobsPerPage,
        filterKey !== "none" ? filterKey : undefined,
        searchParam || undefined,
        companyFilter || undefined,
        appliedFilter || undefined,
        titleFilter || undefined,
        locationFilter || undefined,
        sourceFilter || undefined,
      );
      if (success && data) {
        setJobs((prev) => (page === 1 ? data : [...prev, ...data]));
        setTotalJobs(total);
        setPage(page);
      } else {
        toastError(message);
      }
      setInitialLoading(false);
      setLoadingMore(false);
    },
    [
      jobsPerPage,
      filterKey,
      searchParam,
      companyFilter,
      appliedFilter,
      titleFilter,
      locationFilter,
      sourceFilter,
    ],
  );

  const reloadJobs = useCallback(async () => {
    await loadJobs(1);
  }, [loadJobs]);

  useEffect(() => {
    (async () => await loadJobs(1))();
  }, [loadJobs]);

  // The agent saves server-side, so only this counter tells us a row appeared
  // or a match score landed. Deps are the counter alone: reloadJobs changes
  // with every filter and keystroke, and the effects above already cover those.
  useEffect(() => {
    if (jobWrites === 0) return;
    void reloadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobWrites]);

  // Infinite scroll: auto-load next page when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          !initialLoading &&
          !loadingMore &&
          jobs.length < totalJobs
        ) {
          loadJobs(page + 1);
        }
      },
      { threshold: APP_CONSTANTS.INTERSECTION_OBSERVER_THRESHOLD },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    jobs.length,
    totalJobs,
    page,
    initialLoading,
    loadingMore,
    loadJobs,
  ]);

  return {
    jobs,
    viewMode,
    onChangeViewMode,
    page,
    totalJobs,
    filterKey,
    searchTerm,
    setSearchTerm: setSearch,
    initialLoading,
    loadingMore,
    loadJobs,
    reloadJobs,
    onFilterChange,
    sentinelRef,
  };
}
