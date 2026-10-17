"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import { APP_CONSTANTS } from "@/lib/constants";
import { JobSource } from "@/models/job.model";
import JobSourcesTable from "./JobSourcesTable";
import { getJobSourceList } from "@/actions/jobSource.actions";
import Loading from "../Loading";
import { Button } from "../ui/button";
import { RecordsCount } from "../RecordsCount";
import { useI18n } from "@/i18n";

function JobSourcesContainer() {
  const { t } = useI18n();
  const [sources, setSources] = useState<JobSource[]>([]);
  const [totalJobSources, setTotalJobSources] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a blocked read family or failed fetch never renders as a
  // normal empty list or a spinner that never stops.
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  const sawLoading = useRef(false);
  const loadJobSources = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const res = await getJobSourceList(
          page,
          APP_CONSTANTS.RECORDS_PER_PAGE,
          "applied"
        );
        if (!res || res.success === false || !Array.isArray(res.data)) {
          setError(res?.message ?? "");
          return;
        }
        setSources((prev) => (page === 1 ? res.data : [...prev, ...res.data]));
        setTotalJobSources(res.total);
        setPage(page);
        setError(null);
      } catch {
        setError("");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const reloadJobSources = useCallback(async () => {
    await loadJobSources(1);
  }, [loadJobSources]);

  useEffect(() => {
    (async () => await loadJobSources(1))();
  }, [loadJobSources]);

  useEffect(() => {
    if (loading) {
      sawLoading.current = true;
      return;
    }
    if (sawLoading.current) setListSettled(true);
  }, [loading]);

  return (
    <>
      <div className="col-span-3 min-w-0">
        <Card className="min-w-0" x-chunk="dashboard-06-chunk-0">
          <ResponsiveCardHeader className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <CardTitle className="text-foreground">{t("library.jobSources")}</CardTitle>
              {!loading && totalJobSources > 0 && (
                <RecordsCount count={sources.length} total={totalJobSources} label={t("library.jobSourcesLabel")} />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            </div>
          </ResponsiveCardHeader>
          <CardContent>
            {loading && <Loading />}
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
                    disabled={loading}
                    onClick={reloadJobSources}
                  >
                    {t("common.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {sources.length > 0 && (
              <>
                <JobSourcesTable
                  jobSources={sources}
                  reloadJobSources={reloadJobSources}
                />
              </>
            )}
            {listSettled && !loading && error === null && sources.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
                {t("library.emptyList")}
              </p>
            )}
            {error === null && sources.length < totalJobSources && (
              <div className="flex justify-center p-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadJobSources(page + 1)}
                  disabled={loading}
                >
                  {loading ? t("common.loading") : t("common.loadMore")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default JobSourcesContainer;
