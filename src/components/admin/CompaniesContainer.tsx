"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader } from "lucide-react";
import AddCompany from "./AddCompany";
import BoardsTable from "./BoardsTable";
import CompaniesTable from "./CompaniesTable";
import { WatchMergeDialog, type PendingMerge } from "./WatchMergeDialog";
import { Card, CardContent, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import Loading from "../Loading";
import { RecordsCount } from "../RecordsCount";
import { SearchInput } from "../SearchInput";
import { JobBoardUrlAdd } from "../JobBoardUrlAdd";
import { getCompanyById, watchBoardCompany } from "@/actions/company.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import { PROVIDER_META } from "@/components/automations/ats-search-step/types";
import { CompaniesScopeSelect } from "./companies-container/CompaniesScopeSelect";
import { useBoardsBrowse } from "./companies-container/useBoardsBrowse";
import { useCompaniesList } from "./companies-container/useCompaniesList";
import {
  boardProvider,
  useCompanyScope,
} from "./companies-container/useCompanyScope";
import type { LeverCompany } from "@/models/automation.model";
import { useI18n } from "@/i18n";

function CompaniesContainer() {
  const { t } = useI18n();
  const { scope, setScope } = useCompanyScope();
  const provider = boardProvider(scope);
  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editCompany, setEditCompany] = useState(null);
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null);

  const listScope = scope === "watchlist" ? "watchlist" : "mine";
  const list = useCompaniesList(listScope, searchTerm, !provider);
  const browse = useBoardsBrowse(provider, searchTerm);

  const onEditCompany = async (companyId: string) => {
    const company = await getCompanyById(companyId);
    setEditCompany(company);
    setDialogOpen(true);
  };

  const onUrlResolved = useCallback(
    async (company: LeverCompany) => {
      if (!provider) return;
      const res = await watchBoardCompany(provider, company);
      if (res.success) {
        browse.markWatched(company.token, res.data.companyId);
        toastSuccess(
          t("companies.addedToWatchlist", { name: company.name }),
        );
      } else if ("needsConfirm" in res) {
        setPendingMerge({ provider, board: company, existing: res.existing });
      } else {
        toastError(res.message);
      }
    },
    [browse, provider, t],
  );

  const confirmMerge = async () => {
    if (!pendingMerge) return;
    const { provider: p, board } = pendingMerge;
    const res = await watchBoardCompany(p, board, { confirmMerge: true });
    setPendingMerge(null);
    if (res.success) {
      browse.markWatched(board.token, res.data.companyId);
      toastSuccess(t("companies.linkedToWatchlist", { name: board.name }));
    } else if (!("needsConfirm" in res)) {
      toastError(res.message);
    }
  };

  const loading = provider ? browse.initialLoading : list.initialLoading;
  const [listSettled, setListSettled] = useState(false);
  const sawLoading = useRef(false);
  // Browse search clears rows before its debounce. Hide the empty state until
  // the next load actually starts and finishes, so a pending read is not shown
  // as an empty company list.
  useEffect(() => {
    setListSettled(false);
    sawLoading.current = false;
  }, [searchTerm, scope]);
  useEffect(() => {
    if (loading) {
      sawLoading.current = true;
      return;
    }
    if (sawLoading.current) setListSettled(true);
  }, [loading]);
  const loadingMore = provider ? browse.loadingMore : list.loadingMore;
  const hasMore = provider ? browse.hasMore : list.hasMore;
  const sentinelRef = provider ? browse.sentinelRef : list.sentinelRef;
  const shownCount = provider ? browse.rows.length : list.companies.length;
  const shownTotal = provider ? browse.total : list.total;

  return (
    <>
      <div className="col-span-3 min-w-0">
        <Card className="min-w-0" x-chunk="dashboard-06-chunk-0">
          <ResponsiveCardHeader className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <CardTitle className="text-foreground">{t("library.companies")}</CardTitle>
              {!loading && shownCount > 0 && (
                <RecordsCount
                  count={shownCount}
                  total={shownTotal}
                  label={t("library.companiesLabel")}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              <CompaniesScopeSelect scope={scope} onScopeChange={setScope} />
              <SearchInput
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder={t("companies.searchPlaceholder")}
              />
              <AddCompany
                editCompany={editCompany}
                reloadCompanies={list.reload}
                resetEditCompany={() => setEditCompany(null)}
                dialogOpen={dialogOpen}
                setDialogOpen={setDialogOpen}
              />
            </div>
          </ResponsiveCardHeader>
          <CardContent>
            {provider && (
              <div className="mb-4">
                <JobBoardUrlAdd
                  provider={provider}
                  placeholder={PROVIDER_META[provider].urlHint}
                  disabled={false}
                  onResolved={onUrlResolved}
                />
              </div>
            )}
            {loading && <Loading />}
            {provider ? (
              browse.rows.length > 0 && (
                <BoardsTable
                  provider={provider}
                  rows={browse.rows}
                  watchedMap={browse.watchedMap}
                  onWatched={browse.markWatched}
                  onUnwatched={browse.unmarkWatched}
                  onNeedsMerge={setPendingMerge}
                />
              )
            ) : list.error !== null ? (
              // A failed read (e.g. blocked jobs family) is not an empty
              // list — surface the Action message with an explicit retry.
              <Alert variant="destructive" className="mb-4">
                <AlertTitle>{t("companies.loadFailed")}</AlertTitle>
                <AlertDescription>
                  {list.error ? <p>{list.error}</p> : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={loading}
                    onClick={list.reload}
                  >
                    {t("common.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : list.companies.length > 0 ? (
                <CompaniesTable
                  companies={list.companies}
                  reloadCompanies={list.reload}
                  editCompany={onEditCompany}
                  scope={listScope}
                />
              ) : listSettled && !loading ? (
                <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
                  {t("companies.noCompanies")}
                </p>
              ) : null}
            {listSettled && !loading && provider && browse.rows.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground" data-testid="library-empty">
                {t("companies.noCompanies")}
              </p>
            )}
            {hasMore && (
              <div ref={sentinelRef} className="flex justify-center p-4">
                {loadingMore && (
                  <Loader className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <WatchMergeDialog
        pending={pendingMerge}
        onConfirm={confirmMerge}
        onCancel={() => setPendingMerge(null)}
      />
    </>
  );
}

export default CompaniesContainer;
