"use client";

import Link from "next/link";
import {
  Activity,
  Award,
  BellRing,
  BriefcaseBusiness,
  CalendarClock,
  ListTodo,
  MessagesSquare,
  NotebookPen,
  Send,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { CareerInsightsPayload } from "@/actions/dashboard/insights";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

// Analytics board headline metrics (CAREER-INSIGHTS contract M1–M7). A
// blocked jobs family renders em-dashes plus the explicit notice — never
// fabricated zeros — while the family-independent M6 task half and M7 still
// show real numbers. Cards drill into real routes; M6 has no single target
// (mixed job events + tasks) so it stays unlinked.
export default function BoardTotals({
  insights,
}: {
  insights: CareerInsightsPayload;
}) {
  const { t, formatNumber } = useI18n();
  const blocked = insights.blocked;
  const board = blocked ? null : insights.data.board;
  const family = blocked ? null : insights.data.family;
  const migratedOrigin = !blocked && insights.data.migratedOrigin;
  const followUps = insights.followUps;

  const followUpSecondary = [
    followUps.overdueCount > 0
      ? t("dashboard.followUpsOverdue", { count: followUps.overdueCount })
      : null,
    followUps.tasksOnly ? t("dashboard.followUpsTasksOnly") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const items: MetricCard[] = [
    {
      key: "total",
      icon: BriefcaseBusiness,
      label: t("dashboard.statTotal"),
      value: board?.total ?? null,
      href: "/dashboard/myjobs",
    },
    {
      key: "inProgress",
      icon: Activity,
      label: t("dashboard.metricInProgress"),
      value: board?.inProgress ?? null,
      href: "/dashboard/myjobs",
    },
    {
      key: "applied",
      icon: Send,
      label: t("dashboard.statApplied"),
      value: board?.appliedPositions ?? null,
      secondary:
        board == null
          ? null
          : board.appliedAttempts === null
            ? t("dashboard.statAppliedAttemptsUnavailable")
            : t("dashboard.appliedAttemptsLine", {
                count: board.appliedAttempts,
              }),
      // `applied=true` is the ever-applied flag — `filter=applied` would
      // mean "currently AT applied status" on legacy, a different metric.
      href: "/dashboard/myjobs?applied=true",
    },
  ];

  if (board?.interview.scope === "rounds") {
    items.push(
      {
        // Keep the observable `board-total-interviews` id — the label now
        // names the round unit honestly instead of the metric id.
        key: "interviews",
        icon: MessagesSquare,
        label: t("dashboard.statInterviewRoundsDone"),
        value: board.interview.completedRounds,
        href: "/dashboard/myjobs?tab=upcoming",
      },
      {
        key: "interviewScheduled",
        icon: CalendarClock,
        label: t("dashboard.statInterviewRoundsScheduled"),
        value: board.interview.scheduledRounds,
        href: "/dashboard/myjobs?tab=upcoming",
      },
    );
  } else {
    // Legacy degrade: a position-unit count, labelled as such (D2). A blocked
    // family shows the same single card as an em-dash placeholder.
    items.push({
      key: "interviews",
      icon: MessagesSquare,
      label:
        board?.interview.scope === "positions"
          ? t("dashboard.statInterviewingPositions")
          : t("dashboard.statInterviews"),
      value:
        board?.interview.scope === "positions"
          ? board.interview.interviewingPositions
          : null,
      secondary:
        board?.interview.scope === "positions"
          ? t("dashboard.statInterviewingPositionsNote")
          : null,
      href: "/dashboard/myjobs",
    });
  }

  items.push(
    {
      key: "offers",
      icon: Award,
      label: t("dashboard.statOffersCurrent"),
      value: board?.offersCurrent ?? null,
      href: "/dashboard/myjobs",
    },
    // M9 conditional metric (frozen §2.10/D9): present only while the ab
    // read surface serves the debrief domain count — legacy/blocked and
    // read failures leave the block absent, never a placeholder.
    ...(blocked || insights.data.awaitingReflectionInterviews == null
      ? []
      : [
          {
            key: "awaitingReflection",
            icon: NotebookPen,
            label: t("dashboard.statAwaitingReflection"),
            value: insights.data.awaitingReflectionInterviews,
            href: "/dashboard/myjobs",
          },
        ]),
    {
      key: "followUps",
      icon: BellRing,
      label: t("dashboard.statFollowUps"),
      value: followUps.total,
      secondary: followUpSecondary || null,
    },
    {
      key: "openTasks",
      icon: ListTodo,
      label: t("dashboard.metricOpenTasks"),
      value: insights.openTasks,
      href: "/dashboard/tasks",
    },
  );

  const cardBody = (item: MetricCard) => (
    <CardContent className="flex items-center gap-3 p-4">
      <item.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{item.label}</p>
        <p className="text-2xl font-semibold tabular-nums">
          {item.value == null ? "—" : formatNumber(item.value)}
        </p>
        {item.secondary ? (
          <p className="truncate text-xs text-muted-foreground">
            {item.secondary}
          </p>
        ) : null}
      </div>
    </CardContent>
  );

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 grid-cols-2 gap-4 xl:grid-cols-4">
        {items.map((item) => (
          <Card key={item.key} data-testid={`board-total-${item.key}`}>
            {item.href && !blocked ? (
              <Link
                href={item.href}
                className="block rounded-xl transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {cardBody(item)}
              </Link>
            ) : (
              cardBody(item)
            )}
          </Card>
        ))}
      </div>
      {blocked ? <JobsUnavailableNotice /> : null}
      {family === "ab" ? (
        <div className="space-y-1" data-testid="board-insights-footnotes">
          <p className="text-xs text-muted-foreground">
            {t("dashboard.insightsExcludeArchived")}
          </p>
          {migratedOrigin ? (
            <p className="text-xs text-muted-foreground">
              {t("dashboard.insightsMigratedRounds")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type MetricCard = {
  key: string;
  icon: LucideIcon;
  label: string;
  value: number | null;
  secondary?: string | null;
  href?: string;
};
