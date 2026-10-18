"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import { Tag } from "@/models/job.model";
import { getTagList } from "@/actions/tag.actions";
import { APP_CONSTANTS } from "@/lib/constants";
import Loading from "../Loading";
import { Loader } from "lucide-react";
import { RecordsCount } from "../RecordsCount";
import TagsTable from "./TagsTable";
import AddTag from "./AddTag";
import { SearchInput } from "../SearchInput";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { useI18n } from "@/i18n";

function TagsContainer() {
  const { t } = useI18n();
  const [tags, setTags] = useState<Tag[]>([]);
  const [totalTags, setTotalTags] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [initialLoading, setInitialLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a blocked read family or failed fetch never renders as a
  // normal empty list.
  const [error, setError] = useState<string | null>(null);
  // Count Availability, separate from the numbers: under the A+B read
  // family no Tag→Job relation exists, so the jobs column renders the
  // unsupported marker instead of a frozen legacy count. Responses without
  // the flag come from a legacy read and stay treated as available.
  const [jobsCountAvailable, setJobsCountAvailable] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [listSettled, setListSettled] = useState(false);
  const sawLoading = useRef(false);
  const hasSearched = useRef(false);
  const requestIdRef = useRef(0);
  const loadTags = useCallback(
    async (page: number, search?: string) => {
      const requestId = ++requestIdRef.current;
      if (page === 1) setInitialLoading(true);
      else setLoadingMore(true);
      try {
        const res = await getTagList(
          page,
          APP_CONSTANTS.RECORDS_PER_PAGE,
          search,
        );
        if (requestId !== requestIdRef.current) return;
        if (!res || res.success === false || !Array.isArray(res.data)) {
          setError(res?.message ?? "");
          return;
        }
        setTags((prev) => (page === 1 ? res.data : [...prev, ...res.data]));
        setTotalTags(res.total);
        setPage(page);
        setJobsCountAvailable(res.jobsCountAvailable !== false);
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

  const reloadTags = useCallback(async () => {
    await loadTags(1, searchTerm || undefined);
  }, [loadTags, searchTerm]);

  useEffect(() => {
    (async () => await loadTags(1))();
  }, [loadTags]);

  useEffect(() => {
    if (initialLoading) {
      sawLoading.current = true;
      return;
    }
    if (sawLoading.current) setListSettled(true);
  }, [initialLoading]);

  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      loadTags(1, searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // No silent auto-retries through the sentinel while an error is showing —
  // recovery goes through the explicit Retry action.
  const hasMoreTags = error === null && tags.length < totalTags;
  const sentinelRef = useInfiniteScroll(
    hasMoreTags,
    initialLoading || loadingMore,
    useCallback(
      () => loadTags(page + 1, searchTerm || undefined),
      [loadTags, page, searchTerm],
    ),
  );

  return (
    <>
      <div className="col-span-3 min-w-0">
        <Card className="min-w-0" x-chunk="dashboard-06-chunk-0">
          <ResponsiveCardHeader className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <CardTitle className="text-foreground">{t("library.skillsTags")}</CardTitle>
              {!initialLoading && totalTags > 0 && (
                <RecordsCount
                  count={tags.length}
                  total={totalTags}
                  label={t("library.skillsLabel")}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              <SearchInput
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder={t("library.searchSkills")}
              />
              <AddTag reloadTags={reloadTags} />
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
                    onClick={reloadTags}
                  >
                    {t("common.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {tags.length > 0 && (
              <>
                <TagsTable
                  tags={tags}
                  reloadTags={reloadTags}
                  jobsCountAvailable={jobsCountAvailable}
                />
              </>
            )}
            {listSettled && !initialLoading && error === null && tags.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
                {searchTerm ? t("common.noData") : t("library.emptyList")}
              </p>
            )}
            {hasMoreTags && (
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

export default TagsContainer;
