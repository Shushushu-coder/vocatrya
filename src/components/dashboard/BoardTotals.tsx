"use client";

import {
  BriefcaseBusiness,
  Send,
  MessagesSquare,
  Award,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { DashboardJobsReadResult } from "@/actions/dashboard/shared";
import type { JobsBoardTotals } from "@/lib/career/jobsReadDispatch";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

// Analytics board headline: all-time position-level totals. A blocked jobs
// family renders the explicit notice and em-dashes, never fabricated zeros.
export default function BoardTotals({
  totals,
}: {
  totals: DashboardJobsReadResult<JobsBoardTotals>;
}) {
  const { t, formatNumber } = useI18n();
  const data = totals.blocked ? null : totals.data;
  const items = [
    {
      key: "total",
      icon: BriefcaseBusiness,
      label: t("dashboard.statTotal"),
      value: data?.total ?? null,
    },
    {
      key: "applied",
      icon: Send,
      label: t("dashboard.statApplied"),
      value: data?.applied ?? null,
    },
    {
      key: "interviews",
      icon: MessagesSquare,
      label: t("dashboard.statInterviews"),
      value: data?.interviews ?? null,
    },
    {
      key: "offers",
      icon: Award,
      label: t("dashboard.statOffers"),
      value: data?.offers ?? null,
    },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 grid-cols-2 gap-4 xl:grid-cols-4">
        {items.map((item) => (
          <Card key={item.key} data-testid={`board-total-${item.key}`}>
            <CardContent className="flex items-center gap-3 p-4">
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
      {totals.blocked ? <JobsUnavailableNotice /> : null}
    </div>
  );
}
