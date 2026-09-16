"use client";

import { CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ListFilter, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DISCOVERY_STATUSES } from "@/lib/constants";
import { RecordsCount } from "@/components/RecordsCount";
import type { DiscoveryStatus } from "@/models/automation.model";
import { useI18n } from "@/i18n";

interface DiscoveredJobsHeaderProps {
  loadedCount: number;
  totalJobs: number;
  showClear: boolean;
  onClear: () => void;
  statusFilter: DiscoveryStatus[];
  onStatusFilterChange: (filter: DiscoveryStatus[]) => void;
}

export function DiscoveredJobsHeader({
  loadedCount,
  totalJobs,
  showClear,
  onClear,
  statusFilter,
  onStatusFilterChange,
}: DiscoveredJobsHeaderProps) {
  const { t } = useI18n();
  const toggleStatusFilter = (status: DiscoveryStatus, checked: boolean) => {
    onStatusFilterChange(
      checked
        ? [...statusFilter, status]
        : statusFilter.filter((s) => s !== status),
    );
  };

  return (
    <CardHeader>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t("automations.discoveredJobs")}</CardTitle>
          {totalJobs > 0 && (
            <RecordsCount
              count={loadedCount}
              total={totalJobs}
              label={t("common.jobsLabel")}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showClear && (
            <Button variant="outline" size="sm" onClick={onClear}>
              <Trash2 className="h-4 w-4 mr-1.5" />
              {t("common.clear")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <ListFilter className="h-4 w-4 mr-1.5" />
                {t("common.status")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("automations.filterByStatus")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {DISCOVERY_STATUSES.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status.value}
                  checked={statusFilter.includes(status.value)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) =>
                    toggleStatusFilter(status.value, checked)
                  }
                >
                  {t(`automations.discoveryStatuses.${status.value}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </CardHeader>
  );
}
