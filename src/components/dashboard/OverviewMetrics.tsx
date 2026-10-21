"use client";

import { BriefcaseBusiness, Send, SquareCheckBig, CalendarClock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { OverviewStats } from "@/actions/dashboard.actions";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

// The overview's four headline numbers. Job-family metrics render "—" when
// the family is blocked rather than a fabricated 0.
export default function OverviewMetrics({ stats }: { stats: OverviewStats }) {
  const { t, formatNumber } = useI18n();
  const items = [
    {
      key: "inProgress",
      icon: BriefcaseBusiness,
      label: t("dashboard.metricInProgress"),
      value: stats.jobsBlocked ? null : stats.inProgress,
    },
    {
      key: "applied7d",
      icon: Send,
      label: t("dashboard.metricApplied7d"),
      value: stats.jobsBlocked ? null : stats.applied7d,
    },
    {
      key: "openTasks",
      icon: SquareCheckBig,
      label: t("dashboard.metricOpenTasks"),
      value: stats.openTasks,
    },
    {
      key: "upcomingActivities",
      icon: CalendarClock,
      label: t("dashboard.metricUpcoming7d"),
      value: stats.upcomingActivities,
    },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 grid-cols-2 gap-4 xl:grid-cols-4">
        {items.map((item) => (
          <Card key={item.key} data-testid={`overview-metric-${item.key}`}>
            <CardContent className="flex items-center gap-3 px-4 py-3">
              <item.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm text-muted-foreground">
                  {item.label}
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {item.value == null ? "—" : formatNumber(item.value)}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {stats.jobsBlocked ? <JobsUnavailableNotice /> : null}
    </div>
  );
}
