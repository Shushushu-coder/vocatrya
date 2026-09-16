"use client";
import { LayoutGrid, List } from "lucide-react";
import { Button } from "../ui/button";
import { JobsViewMode } from "@/models/job.model";
import { useI18n } from "@/i18n";

type JobsViewToggleProps = {
  value: JobsViewMode;
  onChange: (mode: JobsViewMode) => void;
};

export function JobsViewToggle({ value, onChange }: JobsViewToggleProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      <Button
        size="sm"
        variant={value === "table" ? "secondary" : "ghost"}
        className="h-7 w-7 p-0"
        title={t("jobs.tableView")}
        aria-pressed={value === "table"}
        data-testid="jobs-view-table-btn"
        onClick={() => onChange("table")}
      >
        <List className="h-3.5 w-3.5" />
        <span className="sr-only">{t("jobs.tableView")}</span>
      </Button>
      <Button
        size="sm"
        variant={value === "cards" ? "secondary" : "ghost"}
        className="h-7 w-7 p-0"
        title={t("jobs.cardView")}
        aria-pressed={value === "cards"}
        data-testid="jobs-view-cards-btn"
        onClick={() => onChange("cards")}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span className="sr-only">{t("jobs.cardView")}</span>
      </Button>
    </div>
  );
}
