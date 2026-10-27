"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getJobsList } from "@/actions/job.actions";
import { GENERIC_ERROR_MESSAGE, toastError } from "@/lib/toast";
import { JobResponse, JobsViewMode } from "@/models/job.model";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { runtimeTimeZone } from "@/lib/datetime";

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
  // null = the last read succeeded. A string is the action message so a
  // failed read is not presented as an empty job list.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Account zone from the list envelope — deadline (deadlineOn/precision)
  // display and overdue checks are anchored to it, not the runtime zone.
  const [timeZone, setTimeZone] = useState<string>(() => runtimeTimeZone());
  const failedPageRef = useRef(1);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // URL-derived filter state
  const filterKey = searchParams.get("filter") ?? "none";
  const searchParam = searchParams.get("search") ?? "";
  const [searchTerm, setSearchTerm] = useState(searchParam);

  // Monotonic generation identifying the current list query. It bumps in a
  // layout effect when the committed URL-derived inputs change — a response already in
  // flight for the previous conditions is stale before the refetch even
  // starts — and again on every page-1 load (filter/search reload, manual
  // reload, job-write refresh). A render React abandons never reaches
  // the layout effect, so it cannot invalidate requests that still belong
  // to the committed query. Page loads beyond the first share the
  // generation of the reset they followed, so a stale response can never
  // append onto a new list, clear a newer error, or corrupt failedPageRef.
  const queryKey = JSON.stringify([
    filterKey,
    searchParam,
    companyFilter,
    appliedFilter,
    titleFilter,
    locationFilter,
    sourceFilter,
  ]);
  const generationKeyRef = useRef(queryKey);
  const generationRef = useRef(0);
  useLayoutEffect(() => {
    if (generationKeyRef.current === queryKey) return;
    generationKeyRef.current = queryKey;
    generationRef.current += 1;
  }, [queryKey]);
  // Highest contiguous page applied within the current generation.
  const appliedPageRef = useRef(0);

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
  // the debounce window would otherwise be clobbered. Synced post-commit
  // so a render React discards cannot leak uncommitted params.
  const latestParams = useRef(searchParams);
  useLayoutEffect(() => {
    latestParams.current = searchParams;
  });

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
      const isReset = page === 1;
      if (isReset) {
        generationRef.current += 1;
        appliedPageRef.current = 0;
      }
      const generation = generationRef.current;
      if (isReset) setInitialLoading(true);
      else setLoadingMore(true);
      const result = await getJobsList(
        page,
        jobsPerPage,
        filterKey !== "none" ? filterKey : undefined,
        searchParam || undefined,
        companyFilter || undefined,
        appliedFilter || undefined,
        titleFilter || undefined,
        locationFilter || undefined,
        sourceFilter || undefined,
      ).catch((error: unknown) => ({
        success: false,
        data: undefined,
        total: 0,
        message: error instanceof Error ? error.message : undefined,
      }));
      // A response from an older generation must not touch the new query's
      // jobs, loading flags, error state, or failedPageRef — a late
      // success would otherwise clear a newer error, and a late failure
      // would fail a list that already loaded.
      if (generationRef.current !== generation) return;
      const { success, data, total, message, timeZone: zone } = result ?? {};
      if (success && data) {
        if (zone) setTimeZone(zone);
        // In-generation ordering: only the next contiguous page may apply.
        // Duplicate or out-of-order page responses drop their rows; the
        // sentinel re-requests any gap from the applied page state.
        if (page === appliedPageRef.current + 1) {
          appliedPageRef.current = page;
          setJobs((prev) => {
            if (page === 1) return data;
            const seen = new Set(prev.map((job) => job.id));
            return [...prev, ...data.filter((job: JobResponse) => !seen.has(job.id))];
          });
          setTotalJobs(total);
          setPage(page);
          setLoadError(null);
        }
      } else {
        failedPageRef.current = page;
        setLoadError(message ?? GENERIC_ERROR_MESSAGE);
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

  const retryLoad = useCallback(async () => {
    await loadJobs(failedPageRef.current);
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
          loadError === null &&
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
    loadError,
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
    loadError,
    timeZone,
    loadJobs,
    reloadJobs,
    retryLoad,
    onFilterChange,
    sentinelRef,
  };
}
