"use client";

import Link from "next/link";
import { BriefcaseBusiness } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n, getLocalizedJobStatus } from "@/i18n";
import type { DashboardJobsReadResult } from "@/actions/dashboard/shared";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

const MAX_ROWS = 5;

type RecentJob = {
  id: string;
  appliedDate?: Date | string | null;
  createdAt?: Date | string | null;
  JobTitle?: { label: string } | null;
  Company?: { label: string } | null;
  Location?: { label: string } | null;
  Status?: { label: string; value: string } | null;
};

type FeedRow = {
  id: string;
  title: string;
  detail?: string;
  at: Date | string;
  href: string;
};

// Compact feed of the most recent applications.
export default function RecentUpdates({
  jobs,
}: {
  jobs: DashboardJobsReadResult<RecentJob[]>;
}) {
  const { t, formatDate } = useI18n();

  const rows: FeedRow[] = [];
  if (!jobs.blocked) {
    for (const job of jobs.data) {
      const at = job.appliedDate ?? job.createdAt;
      if (!at) continue;
      rows.push({
        id: `job:${job.id}`,
        title: job.JobTitle?.label ?? "",
        detail: [
          job.Company?.label,
          job.Location?.label,
          job.Status ? getLocalizedJobStatus(job.Status, t) : null,
        ]
          .filter(Boolean)
          .join(" · "),
        at,
        href: `/dashboard/myjobs/${job.id}`,
      });
    }
  }
  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const visible = rows.slice(0, MAX_ROWS);

  return (
    <Card data-testid="recent-updates">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-foreground">
          {t("dashboard.recentUpdates")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-3 pb-3">
        {jobs.blocked ? <JobsUnavailableNotice className="mb-2" /> : null}
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {t("dashboard.noRecentUpdates")}
          </p>
        ) : (
          visible.map((row) => (
            <Link
              key={row.id}
              href={row.href}
              className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <BriefcaseBusiness className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{row.title}</p>
                {row.detail ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {row.detail}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDate(row.at, { month: "short", day: "numeric" })}
              </span>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
