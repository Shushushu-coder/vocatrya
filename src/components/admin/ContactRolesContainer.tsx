"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import { APP_CONSTANTS } from "@/lib/constants";
import { ContactRole } from "@/models/contact.model";
import ContactRolesTable from "./ContactRolesTable";
import AddContactRole from "./AddContactRole";
import { getContactRoleList } from "@/actions/contactRole.actions";
import Loading from "../Loading";
import { Loader } from "lucide-react";
import { Button } from "../ui/button";
import { RecordsCount } from "../RecordsCount";
import { SearchInput } from "../SearchInput";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { useI18n } from "@/i18n";

function ContactRolesContainer() {
  const { t } = useI18n();
  const [roles, setRoles] = useState<ContactRole[]>([]);
  const [totalRoles, setTotalRoles] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [initialLoading, setInitialLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // null = healthy. A string carries the Action's failure message (possibly
  // empty) so a failed fetch never renders as a normal empty list.
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  const sawLoading = useRef(false);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const hasSearched = useRef(false);
  const requestIdRef = useRef(0);

  const loadRoles = useCallback(async (page: number, search?: string) => {
    const requestId = ++requestIdRef.current;
    if (page === 1) setInitialLoading(true);
    else setLoadingMore(true);
    try {
      const res = await getContactRoleList(
        page,
        APP_CONSTANTS.RECORDS_PER_PAGE,
        search,
      );
      if (requestId !== requestIdRef.current) return;
      if (!res || res.success === false || !Array.isArray(res.data)) {
        setError(res?.message ?? "");
        return;
      }
      setRoles((prev) => (page === 1 ? res.data : [...prev, ...res.data]));
      setTotalRoles(res.total);
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
  }, []);

  const reloadRoles = useCallback(
    async () => loadRoles(1, searchTerm || undefined),
    [loadRoles, searchTerm],
  );

  useEffect(() => {
    (async () => await loadRoles(1))();
  }, [loadRoles]);

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
      loadRoles(1, searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // No silent auto-retries through the sentinel while an error is showing —
  // recovery goes through the explicit Retry action.
  const hasMoreRoles = error === null && roles.length < totalRoles;
  const sentinelRef = useInfiniteScroll(
    hasMoreRoles,
    initialLoading || loadingMore,
    useCallback(
      () => loadRoles(page + 1, searchTerm || undefined),
      [loadRoles, page, searchTerm],
    ),
  );

  return (
    <div className="col-span-3">
      <Card x-chunk="dashboard-06-chunk-0">
        <ResponsiveCardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>{t("library.contactRoles")}</CardTitle>
            {!initialLoading && totalRoles > 0 && (
              <RecordsCount
                count={roles.length}
                total={totalRoles}
                label={t("library.rolesLabel")}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder={t("library.searchRoles")}
            />
            <AddContactRole reloadRoles={reloadRoles} />
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
                  onClick={reloadRoles}
                >
                  {t("common.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {roles.length > 0 && (
            <ContactRolesTable roles={roles} reloadRoles={reloadRoles} />
          )}
          {listSettled && !initialLoading && error === null && roles.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
              {searchTerm ? t("common.noData") : t("library.emptyList")}
            </p>
          )}
          {hasMoreRoles && (
            <div ref={sentinelRef} className="flex justify-center p-4">
              {loadingMore && (
                <Loader className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ContactRolesContainer;
