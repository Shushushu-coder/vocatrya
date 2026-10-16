"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCompanyList } from "@/actions/company.actions";
import { APP_CONSTANTS } from "@/lib/constants";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import type { Company } from "@/models/job.model";

export function useCompaniesList(
  scope: "mine" | "watchlist",
  searchTerm: string,
  active: boolean,
) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [initialLoading, setInitialLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a blocked read family or failed fetch never renders as a
  // normal empty list.
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (nextPage: number, search?: string) => {
      const requestId = ++requestIdRef.current;
      if (nextPage === 1) setInitialLoading(true);
      else setLoadingMore(true);
      try {
        const res = await getCompanyList(
          nextPage,
          APP_CONSTANTS.RECORDS_PER_PAGE,
          "applied",
          search,
          scope,
        );
        if (requestId !== requestIdRef.current) return;
        if (!res || res.success === false || !Array.isArray(res.data)) {
          setError(res?.message ?? "");
          return;
        }
        setCompanies((prev) =>
          nextPage === 1 ? res.data : [...prev, ...res.data],
        );
        setTotal(res.total);
        setPage(nextPage);
        setError(null);
      } catch {
        if (requestId === requestIdRef.current) setError("");
      } finally {
        // A stale request must not clear the newer request's loading flags.
        if (requestId === requestIdRef.current) {
          setInitialLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [scope],
  );

  const reload = useCallback(
    async () => load(1, searchTerm || undefined),
    [load, searchTerm],
  );

  // One effect for scope changes and debounced search: both reset to page 1
  // and replace the list, so a separate mount effect would double-fetch.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(
      () => load(1, searchTerm || undefined),
      searchTerm ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [active, scope, searchTerm, load]);

  // No silent auto-retries through the sentinel while an error is showing —
  // recovery goes through the explicit Retry action.
  const hasMore = error === null && companies.length < total;
  const sentinelRef = useInfiniteScroll(
    hasMore && active,
    initialLoading || loadingMore,
    useCallback(
      () => load(page + 1, searchTerm || undefined),
      [load, page, searchTerm],
    ),
  );

  return {
    companies,
    total,
    initialLoading,
    loadingMore,
    error,
    hasMore,
    sentinelRef,
    reload,
  };
}
