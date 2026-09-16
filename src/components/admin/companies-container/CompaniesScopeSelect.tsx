"use client";

import { useCallback, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAtsCompanyCount } from "@/actions/atsCompany.actions";
import { ATS_BOARDS } from "@/models/automation.model";
import { PROVIDER_META } from "@/components/automations/ats-search-step/types";
import type { CompanyScope } from "./useCompanyScope";
import { useI18n } from "@/i18n";

type Props = {
  scope: CompanyScope;
  onScopeChange: (next: CompanyScope) => void;
};

export function CompaniesScopeSelect({ scope, onScopeChange }: Props) {
  const { t } = useI18n();
  // Counts are decoration; fetched on first open so a visit that never
  // touches Browse pays no round-trips.
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open || counts) return;
      Promise.all(ATS_BOARDS.map((p) => getAtsCompanyCount(p)))
        .then((totals) =>
          setCounts(
            Object.fromEntries(ATS_BOARDS.map((p, i) => [p, totals[i]])),
          ),
        )
        .catch(() => {});
    },
    [counts],
  );

  return (
    <Select
      value={scope}
      onValueChange={(v) => onScopeChange(v as CompanyScope)}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={t("companies.selectScope")}
        className="h-8 w-[180px]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{t("nav.library")}</SelectLabel>
          <SelectItem value="mine">{t("companies.myCompanies")}</SelectItem>
          <SelectItem value="watchlist">{t("companies.watchlist")}</SelectItem>
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>{t("companies.browseBoards")}</SelectLabel>
          {ATS_BOARDS.map((provider) => (
            <SelectItem key={provider} value={`board:${provider}`}>
              {PROVIDER_META[provider].label}
              {counts?.[provider] !== undefined && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {counts[provider].toLocaleString()}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
