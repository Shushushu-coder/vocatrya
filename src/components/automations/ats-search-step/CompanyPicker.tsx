"use client";

import { X, Loader2, ChevronsUpDown, ExternalLink, Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { APP_CONSTANTS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { JobBoard, LeverCompany } from "@/models/automation.model";
import { companyBoardUrl } from "@/lib/atsBoardUrl";
import { toastInfo } from "@/lib/toast";
import { PROVIDER_META } from "./types";
import { useAtsCompanySearch } from "./useAtsCompanySearch";
import { useWatchedBoards } from "./useWatchedBoards";
import { JobBoardUrlAdd } from "@/components/JobBoardUrlAdd";
import { useI18n } from "@/i18n";

interface CompanyPickerProps {
  provider: JobBoard;
  companies: LeverCompany[];
  onAdd: (company: LeverCompany) => void;
  onAddMany: (boards: LeverCompany[]) => number;
  onRemove: (token: string) => void;
}

export function CompanyPicker({
  provider,
  companies,
  onAdd,
  onAddMany,
  onRemove,
}: CompanyPickerProps) {
  const { t } = useI18n();
  const meta = PROVIDER_META[provider] ?? PROVIDER_META.greenhouse;
  const {
    query,
    results,
    totalCount,
    open,
    isSearching,
    handleQueryChange,
    handleOpen,
    handleListScroll,
  } = useAtsCompanySearch(provider);

  const atLimit = companies.length >= APP_CONSTANTS.ATS_MAX_COMPANIES;

  const { watched } = useWatchedBoards(provider, open);
  const resultTokens = new Set(results.map((r) => r.token));
  const watchedOnly = watched.filter((w) => !resultTokens.has(w.token));

  const addAllWatched = () => {
    const skipped = onAddMany(watched);
    if (skipped > 0) {
      toastInfo(
        t("automations.skippedAtLimit", {
          skipped,
          max: APP_CONSTANTS.ATS_MAX_COMPANIES,
        }),
      );
    }
  };

  const toggleCompany = (company: LeverCompany) => {
    if (companies.some((c) => c.token === company.token)) {
      onRemove(company.token);
    } else {
      onAdd(company);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center justify-between">
        <span>
          {t("automations.providerCompanies", {
            label: meta.label,
            count: companies.length,
            max: APP_CONSTANTS.ATS_MAX_COMPANIES,
          })}
        </span>
        {totalCount !== null && totalCount > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {t("automations.availableCount", { count: totalCount })}
          </span>
        )}
      </Label>

      <Popover open={open} onOpenChange={handleOpen} modal>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full justify-between font-normal text-muted-foreground",
              atLimit && "opacity-50 cursor-not-allowed",
            )}
            disabled={atLimit}
          >
            {atLimit
              ? t("automations.maxCompaniesReached", {
                  count: APP_CONSTANTS.ATS_MAX_COMPANIES,
                })
              : t("automations.searchCompaniesExample", {
                  example: meta.searchExample,
                })}
            {isSearching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronsUpDown className="h-4 w-4 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-(--radix-popover-trigger-width)"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("automations.searchOrBrowseCompanies")}
              value={query}
              onValueChange={handleQueryChange}
            />
            {/* Outside the group heading: cmdk marks headings aria-hidden, */}
            {/* which would hide this button from keyboard and screen readers. */}
            {watched.length > 0 && (
              <div className="flex items-center justify-between border-b px-3 py-1.5">
                <span className="text-xs text-muted-foreground">
                  {t("automations.watchedOnBoard", { count: watched.length })}
                </span>
                <button
                  type="button"
                  disabled={atLimit}
                  onClick={addAllWatched}
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                >
                  {t("automations.addAllWatched")}
                </button>
              </div>
            )}
            <CommandList onScroll={handleListScroll}>
              {isSearching && results.length === 0 && (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("automations.searching")}
                </div>
              )}
              {!isSearching && results.length === 0 && (
                <CommandEmpty>
                  {t("automations.noMatchesTryUrl")}
                </CommandEmpty>
              )}
              {watched.length > 0 && (
                <CommandGroup heading={t("automations.watchedCount", { count: watched.length })}>
                  {watchedOnly.map((c) => {
                    const selected = companies.some(
                      (sel) => sel.token === c.token,
                    );
                    return (
                      <CommandItem
                        key={`watched-${c.token}`}
                        value={`watched-${c.token}`}
                        disabled={!selected && atLimit}
                        onSelect={() => toggleCompany(c)}
                      >
                        <Check
                          className={cn(
                            "h-4 w-4 shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span>{c.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {c.token}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              <CommandGroup>
                {results.map((c) => {
                  const selected = companies.some(
                    (sel) => sel.token === c.token,
                  );
                  return (
                    <CommandItem
                      key={c.token}
                      value={c.token}
                      disabled={!selected && atLimit}
                      onSelect={() => toggleCompany(c)}
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span>{c.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {c.token}
                      </span>
                      <a
                        href={companyBoardUrl(provider, c)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t("automations.openJobBoard", { name: c.name })}
                        title={t("automations.openJobBoardTitle")}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="ml-auto text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {isSearching && results.length > 0 && (
                <div className="flex items-center justify-center gap-2 p-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("automations.loadingMore")}
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {companies.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {companies.map((c) => (
            <Badge key={c.token} variant="secondary" className="gap-1">
              {c.name}
              <button type="button" onClick={() => onRemove(c.token)}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <JobBoardUrlAdd
        provider={provider}
        placeholder={t(`automations.urlHints.${provider}`)}
        disabled={atLimit}
        onResolved={onAdd}
      />
      <p className="text-sm text-muted-foreground">
        {t("automations.selectCompaniesHelp", { label: meta.label })}
      </p>
    </div>
  );
}
