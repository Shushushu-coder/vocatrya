"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import { APP_CONSTANTS } from "@/lib/constants";
import { JobTitle } from "@/models/job.model";
import JobTitlesTable from "./JobTitlesTable";
import { getJobTitleList } from "@/actions/jobtitle.actions";
import Loading from "../Loading";
import { Loader } from "lucide-react";
import { RecordsCount } from "../RecordsCount";
import { SearchInput } from "../SearchInput";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { useI18n } from "@/i18n";

function JobTitlesContainer() {
  const { t } = useI18n();
  const [titles, setTitles] = useState<JobTitle[]>([]);
  const [totalJobTitles, setTotalJobTitles] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [initialLoading, setInitialLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a blocked read family or failed fetch never renders as a
  // normal empty list.
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const hasSearched = useRef(false);
  const requestIdRef = useRef(0);
  const loadJobTitles = useCallback(
    async (page: number, search?: string) => {
      const requestId = ++requestIdRef.current;
      if (page === 1) setInitialLoading(true);
      else setLoadingMore(true);
      try {
        const res = await getJobTitleList(
          page,
          APP_CONSTANTS.RECORDS_PER_PAGE,
          "applied",
          search
        );
        if (requestId !== requestIdRef.current) return;
        if (!res || res.success === false || !Array.isArray(res.data)) {
          setError(res?.message ?? "");
          return;
        }
        setTitles((prev) => (page === 1 ? res.data : [...prev, ...res.data]));
        setTotalJobTitles(res.total);
        setPage(page);
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
    []
  );

  const reloadJobTitles = useCallback(async () => {
    await loadJobTitles(1, searchTerm || undefined);
  }, [loadJobTitles, searchTerm]);

  useEffect(() => {
    (async () => await loadJobTitles(1))();
  }, [loadJobTitles]);

  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      loadJobTitles(1, searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // No silent auto-retries through the sentinel while an error is showing —
  // recovery goes through the explicit Retry action.
  const hasMoreJobTitles = error === null && titles.length < totalJobTitles;
  const sentinelRef = useInfiniteScroll(
    hasMoreJobTitles,
    initialLoading || loadingMore,
    useCallback(
      () => loadJobTitles(page + 1, searchTerm || undefined),
      [loadJobTitles, page, searchTerm]
    )
  );

  return (
    <>
      <div className="col-span-3">
        <Card x-chunk="dashboard-06-chunk-0">
          <ResponsiveCardHeader>
            <div className="flex items-baseline gap-2">
              <CardTitle>{t("library.jobTitles")}</CardTitle>
              {!initialLoading && totalJobTitles > 0 && (
                <RecordsCount count={titles.length} total={totalJobTitles} label="job titles" />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              <SearchInput
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder={t("library.searchJobTitles")}
              />
              {/* <AddCompany reloadCompanies={reloadJobTitles} /> */}
            </div>
          </ResponsiveCardHeader>
          <CardContent>
            {initialLoading && <Loading />}
            {error !== null && (
              // A failed read (e.g. blocked jobs family) is not an empty
              // list — surface the Action message with an explicit retry.
              <Alert variant="destructive" className="mb-4">
                <AlertTitle>{t("library.loadFailed")}</AlertTitle>
                <AlertDescription>
                  {error ? <p>{error}</p> : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={initialLoading}
                    onClick={reloadJobTitles}
                  >
                    {t("common.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {titles.length > 0 && (
              <>
                <JobTitlesTable
                  jobTitles={titles}
                  reloadJobTitles={reloadJobTitles}
                />
              </>
            )}
            {hasMoreJobTitles && (
              <div ref={sentinelRef} className="flex justify-center p-4">
                {loadingMore && (
                  <Loader className="h-5 w-5 animate-spin text-blue-500" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default JobTitlesContainer;
