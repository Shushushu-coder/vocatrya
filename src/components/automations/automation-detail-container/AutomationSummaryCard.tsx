"use client";

import Link from "next/link";
import { format } from "date-fns";
import { AlertTriangle, Clock, FileText, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { AutomationWithResume } from "@/models/automation.model";
import { AutomationSearchConfig } from "./AutomationSearchConfig";
import { useI18n } from "@/i18n";

interface AutomationSummaryCardProps {
  automation: AutomationWithResume;
  retired: boolean;
  resumeMissing: boolean;
  isRunning: boolean;
  totalJobs: number;
  newJobsCount: number;
}

export function AutomationSummaryCard({
  automation,
  retired,
  resumeMissing,
  isRunning,
  totalJobs,
  newJobsCount,
}: AutomationSummaryCardProps) {
  const { t } = useI18n();
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{t("common.status")}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  automation.status === "active" ? "default" : "secondary"
                }
              >
                {automation.status}
              </Badge>
              {isRunning && (
                <Badge variant="default" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("automations.runningBadge")}
                </Badge>
              )}
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.jobBoard")}</p>
            <p className="font-medium capitalize">{automation.jobBoard}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.matchThresholdLabel")}</p>
            <p className="font-medium">{automation.matchThreshold}%</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.schedule")}</p>
            <p className="font-medium flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {t("automations.dailyAt", {
                time: `${automation.scheduleHour.toString().padStart(2, "0")}:00`,
              })}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.resume")}</p>
            {resumeMissing ? (
              <p className="text-amber-600 flex items-center gap-1 text-sm">
                <AlertTriangle className="h-4 w-4" />
                {t("automations.missing")}
              </p>
            ) : (
              <Link
                href={`/dashboard/profile/resume/${automation.resume.id}`}
                className="font-medium flex items-center gap-1 hover:underline"
              >
                <FileText className="h-4 w-4" />
                {automation.resume.title}
              </Link>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.nextRun")}</p>
            <p className="font-medium">
              {automation.nextRunAt && automation.status === "active"
                ? format(new Date(automation.nextRunAt), "MMM d, h:mm a")
                : "-"}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.lastRun")}</p>
            <p className="font-medium">
              {automation.lastRunAt
                ? format(new Date(automation.lastRunAt), "MMM d, h:mm a")
                : t("automations.never")}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("automations.discoveredJobs")}</p>
            <p className="font-medium">
              {t("automations.totalCount", { count: totalJobs })}
              {newJobsCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {t("automations.newCountBadge", { count: newJobsCount })}
                </Badge>
              )}
            </p>
          </div>
        </div>

        <AutomationSearchConfig
          sourceConfig={automation.sourceConfig}
          jobBoard={automation.jobBoard}
          retired={retired}
        />
      </CardContent>
    </Card>
  );
}
