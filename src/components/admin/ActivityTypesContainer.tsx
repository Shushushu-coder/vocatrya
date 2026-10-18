"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import { getActivityTypeList } from "@/actions/activity.actions";
import { APP_CONSTANTS } from "@/lib/constants";
import Loading from "../Loading";
import { Loader } from "lucide-react";
import { Button } from "../ui/button";
import { RecordsCount } from "../RecordsCount";
import ActivityTypesTable from "./ActivityTypesTable";
import AddActivityType from "./AddActivityType";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { useI18n } from "@/i18n";

function ActivityTypesContainer() {
  const { t } = useI18n();
  const [activityTypes, setActivityTypes] = useState<any[]>([]);
  const [totalActivityTypes, setTotalActivityTypes] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [initialLoading, setInitialLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a failed fetch never renders as a normal empty list.
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  const sawLoading = useRef(false);
  const requestIdRef = useRef(0);
  const loadActivityTypes = useCallback(
    async (page: number) => {
      const requestId = ++requestIdRef.current;
      if (page === 1) setInitialLoading(true);
      else setLoadingMore(true);
      try {
        const res = await getActivityTypeList(
          page,
          APP_CONSTANTS.RECORDS_PER_PAGE,
        );
        if (requestId !== requestIdRef.current) return;
        if (!res || res.success === false || !Array.isArray(res.data)) {
          setError(res?.message ?? "");
          return;
        }
        setActivityTypes((prev) =>
          page === 1 ? res.data : [...prev, ...res.data],
        );
        setTotalActivityTypes(res.total);
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
    [],
  );

  const reloadActivityTypes = useCallback(async () => {
    await loadActivityTypes(1);
  }, [loadActivityTypes]);

  useEffect(() => {
    (async () => await loadActivityTypes(1))();
  }, [loadActivityTypes]);

  useEffect(() => {
    if (initialLoading) {
      sawLoading.current = true;
      return;
    }
    if (sawLoading.current) setListSettled(true);
  }, [initialLoading]);

  // No silent auto-retries through the sentinel while an error is showing —
  // recovery goes through the explicit Retry action.
  const hasMoreActivityTypes =
    error === null && activityTypes.length < totalActivityTypes;
  const sentinelRef = useInfiniteScroll(
    hasMoreActivityTypes,
    initialLoading || loadingMore,
    useCallback(() => loadActivityTypes(page + 1), [loadActivityTypes, page]),
  );

  return (
    <>
      <div className="col-span-3">
        <Card>
          <ResponsiveCardHeader>
            <div className="flex items-baseline gap-2">
              <CardTitle>{t("library.activityTypesProjects")}</CardTitle>
              {!initialLoading && totalActivityTypes > 0 && (
                <RecordsCount
                  count={activityTypes.length}
                  total={totalActivityTypes}
                  label={t("library.activityTypesLabel")}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              <AddActivityType reloadActivityTypes={reloadActivityTypes} />
            </div>
          </ResponsiveCardHeader>
          <CardContent>
            {initialLoading && <Loading />}
            {error !== null && (
              // A failed read is not an empty list — surface the Action
              // message with an explicit retry.
              <Alert variant="destructive" className="mb-4">
                <AlertTitle>{t("library.loadFailed")}</AlertTitle>
                <AlertDescription>
                  {error ? <p>{error}</p> : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={initialLoading}
                    onClick={reloadActivityTypes}
                  >
                    {t("common.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {activityTypes.length > 0 && (
              <>
                <ActivityTypesTable
                  activityTypes={activityTypes}
                  reloadActivityTypes={reloadActivityTypes}
                />
              </>
            )}
            {listSettled && !initialLoading && error === null && activityTypes.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
                {t("library.emptyList")}
              </p>
            )}
            {hasMoreActivityTypes && (
              <div ref={sentinelRef} className="flex justify-center p-4">
                {loadingMore && (
                  <Loader className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default ActivityTypesContainer;
