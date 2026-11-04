"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ResponsiveBar } from "@nivo/bar";
import { ResponsivePie } from "@nivo/pie";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { usePersistedTabIndex } from "@/hooks/usePersistedTabIndex";
import { useI18n, getLocalizedJobStatus } from "@/i18n";
import type { DashboardJobsReadResult } from "@/actions/dashboard/shared";
import type { InsightTrendWindow } from "@/actions/dashboard/insights";
import type { JobStatusCount } from "@/lib/career/jobsReadDispatch";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

// Statuses exceed the 3-hue activity palette; this ordered set keeps each
// bucket visually distinct on both card surfaces.
const STATUS_COLORS = {
  light: [
    "#2a9d90",
    "#c97e22",
    "#6d4fc7",
    "#2a7ef0",
    "#d64550",
    "#4d8f2f",
    "#b05aa0",
    "#946a3b",
    "#3e7fbf",
    "#7a8a99",
  ],
  dark: [
    "#16a89a",
    "#c08438",
    "#8b72e8",
    "#4a92f5",
    "#e26b74",
    "#62a844",
    "#c973b8",
    "#b08d57",
    "#5b97cf",
    "#9aa5b1",
  ],
} as const;

const TAB_VALUES = ["trend", "status"] as const;
const WINDOW_VALUES = ["7d", "30d"] as const;
const CHART_HEIGHT = 220;

type AnalyticsPanelProps = {
  trend7: DashboardJobsReadResult<InsightTrendWindow>;
  trend30: DashboardJobsReadResult<InsightTrendWindow>;
  statusDist: DashboardJobsReadResult<JobStatusCount[]>;
  /** ab/legacy family — labels family-dependent units honestly (e.g. the
   *  neutral offer-declined bucket wording only applies to the ab-derived
   *  distribution). Null when the jobs read is blocked. */
  family?: "ab" | "legacy" | null;
};

const NIVO_THEME = {
  text: { fill: "var(--color-muted-foreground)" },
  tooltip: {
    container: {
      background: "var(--color-popover)",
      color: "var(--color-popover-foreground)",
    },
  },
};

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-testid="analytics-empty-note"
      className="px-2 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </p>
  );
}

export default function AnalyticsPanel({
  trend7,
  trend30,
  statusDist,
  family = null,
}: AnalyticsPanelProps) {
  const { t, formatNumber } = useI18n();
  const [tabIndex, selectTab] = usePersistedTabIndex(
    APP_CONSTANTS.DASHBOARD_ANALYTICS_TAB_STORAGE_KEY,
    TAB_VALUES,
  );
  const [windowIndex, selectWindow] = usePersistedTabIndex(
    APP_CONSTANTS.DASHBOARD_ANALYTICS_WINDOW_STORAGE_KEY,
    WINDOW_VALUES,
  );
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const activeTab = TAB_VALUES[tabIndex];
  const trend = windowIndex === 0 ? trend7 : trend30;
  const windowed = activeTab !== "status";

  return (
    <Card data-testid="analytics-panel" className="min-w-0">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate text-lg text-foreground">
            {t("dashboard.analyticsTitle")}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-3">
            {windowed ? (
              <div
                className="flex rounded-md border text-xs"
                data-testid="analytics-window-toggle"
              >
                {WINDOW_VALUES.map((window, index) => (
                  <button
                    key={window}
                    type="button"
                    onClick={() => selectWindow(index)}
                    className={cn(
                      "px-2 py-1 transition-colors motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      index === 0 && "rounded-l-md",
                      index === WINDOW_VALUES.length - 1 && "rounded-r-md",
                      windowIndex === index
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    {window === "7d"
                      ? t("dashboard.window7d")
                      : t("dashboard.window30d")}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("dashboard.windowAllTime")}
              </span>
            )}
          </div>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            selectTab(TAB_VALUES.indexOf(value as (typeof TAB_VALUES)[number]))
          }
        >
          <TabsList data-testid="analytics-tabs" className="h-9">
            <TabsTrigger value="trend">{t("dashboard.tabTrend")}</TabsTrigger>
            <TabsTrigger value="status">{t("dashboard.tabStatus")}</TabsTrigger>
          </TabsList>

          <TabsContent value="trend">
            {trend.blocked ? (
              <div className="flex justify-center py-6">
                <JobsUnavailableNotice className="max-w-md" />
              </div>
            ) : (
              <>
                <p className="px-2 pb-1 text-xs text-muted-foreground">
                  {t("dashboard.trendWindowTotal", {
                    count: trend.data.total,
                  })}
                </p>
                {trend.data.days.every((d) => d.value === 0) ? (
                  <EmptyNote>
                    {t("dashboard.noApplicationsInWindow")}
                  </EmptyNote>
                ) : (
                  <div style={{ height: CHART_HEIGHT }} className="min-w-0">
                <ResponsiveBar
                  data={trend.data.days}
                  keys={["value"]}
                  indexBy="day"
                  animate={!reduceMotion}
                  motionConfig="gentle"
                  margin={{ top: 20, right: 10, bottom: 40, left: 48 }}
                  padding={0.6}
                  colors="#2a7ef0"
                  enableTotals={false}
                  valueFormat={(value) => value.toFixed(0)}
                  theme={NIVO_THEME}
                  axisTop={null}
                  axisRight={null}
                  enableGridX={false}
                  enableGridY={false}
                  enableLabel={true}
                  labelSkipHeight={1}
                  labelTextColor={{
                    from: "color",
                    modifiers: [["darker", 1.6]],
                  }}
                  axisBottom={{
                    tickSize: 5,
                    tickPadding: 5,
                    tickRotation: 0,
                    legendPosition: "middle",
                    legendOffset: 32,
                    truncateTickAt: 0,
                  }}
                  axisLeft={{
                    tickSize: 5,
                    tickPadding: 5,
                    tickRotation: 0,
                    legend: t("dashboard.jobsAppliedAxis"),
                    legendPosition: "middle",
                    legendOffset: -40,
                    truncateTickAt: 0,
                    // Discrete daily counts: integer ticks only, never a
                    // fractional axis that implies half an application.
                    tickValues: Array.from(
                      {
                        length:
                          Math.max(0, ...trend.data.days.map((d) => d.value)) + 1,
                      },
                      (_, i) => i,
                    ),
                  }}
                  tooltip={({ value, indexValue, color }) => (
                    <div
                      style={{
                        background: "var(--color-popover)",
                        color: "var(--color-popover-foreground)",
                        border: "1px solid var(--color-border)",
                        padding: "6px 10px",
                        borderRadius: 4,
                        fontSize: 13,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <div style={{ marginBottom: 4 }}>{indexValue}</div>
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          background: color,
                          borderRadius: 2,
                          marginRight: 6,
                        }}
                      />
                      {t("dashboard.jobsAppliedAxis")}: <strong>{value}</strong>
                    </div>
                  )}
                />
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="status">
            <StatusDistribution
              statusDist={statusDist}
              theme={theme}
              family={family}
            />
          </TabsContent>
        </Tabs>
      </CardHeader>
    </Card>
  );
}

function StatusDistribution({
  statusDist,
  theme,
  family,
}: {
  statusDist: DashboardJobsReadResult<JobStatusCount[]>;
  theme: "light" | "dark";
  family: "ab" | "legacy" | null;
}) {
  const { t, formatNumber } = useI18n();
  if (statusDist.blocked) {
    return (
      <div className="flex justify-center py-6">
        <JobsUnavailableNotice className="max-w-md" />
      </div>
    );
  }
  const entries = statusDist.data.filter((entry) => entry.count > 0);
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) {
    return <EmptyNote>{t("dashboard.noStatusData")}</EmptyNote>;
  }
  const slices = entries.map((entry, index) => ({
    id: entry.status,
    // D3: in the A+B distribution "offer-declined" is a WITHDRAWN mapping —
    // the label stays neutral instead of claiming an offer was declined. The
    // legacy value is a user-picked status, so it keeps its own wording.
    label:
      family === "ab" && entry.status === "offer-declined"
        ? t("dashboard.statusOfferDeclinedNeutral")
        : getLocalizedJobStatus(entry.status, t) || entry.status,
    value: entry.count,
    color: STATUS_COLORS[theme][index % STATUS_COLORS[theme].length],
  }));

  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div style={{ height: CHART_HEIGHT }} className="min-w-0">
        <ResponsivePie
          data={slices}
          innerRadius={0.62}
          padAngle={1}
          cornerRadius={3}
          margin={{ top: 12, bottom: 12 }}
          colors={{ datum: "data.color" }}
          enableArcLinkLabels={false}
          enableArcLabels={false}
          theme={NIVO_THEME}
          tooltip={({ datum }) => (
            <div
              style={{
                background: "var(--color-popover)",
                color: "var(--color-popover-foreground)",
                border: "1px solid var(--color-border)",
                padding: "6px 10px",
                borderRadius: 4,
                fontSize: 13,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: datum.color,
                  borderRadius: 2,
                  marginRight: 6,
                }}
              />
              {datum.label}: <strong>{datum.value}</strong>
            </div>
          )}
        />
      </div>
      <ul
        className="grid gap-1 px-2 pb-2 sm:min-w-44"
        data-testid="status-legend"
      >
        {slices.map((slice) => (
          <li key={slice.id} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: slice.color }}
            />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatNumber(slice.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
