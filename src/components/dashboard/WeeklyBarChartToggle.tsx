"use client";

import { useState, useEffect, useMemo } from "react";
import { useTheme } from "next-themes";
import { ResponsiveBar } from "@nivo/bar";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { usePersistedTabIndex } from "@/hooks/usePersistedTabIndex";
import {
  SERIES_COLORS,
  OTHER_COLOR,
  OTHER_SLICE_ID,
  otherBucketLabel,
} from "./jobsActivityChart";
import { useI18n } from "@/i18n";
import JobsUnavailableNotice from "./JobsUnavailableNotice";

type ChartConfig = {
  label: string;
  data: any[];
  keys: string[];
  groupMode?: "grouped" | "stacked";
  axisLeftLegend: string;
  tooltipLabel?: (key: string) => string;
  // Set when the series' source read is blocked: the tab stays selectable but
  // shows an explicit unavailable state instead of a fabricated chart.
  unavailable?: boolean;
};

type WeeklyBarChartToggleProps = {
  charts: ChartConfig[];
};

export default function WeeklyBarChartToggle({
  charts,
}: WeeklyBarChartToggleProps) {
  const { t } = useI18n();
  const [activeIndex, selectTab] = usePersistedTabIndex(
    APP_CONSTANTS.DASHBOARD_WEEKLY_CHART_STORAGE_KEY,
    charts.map((chart) => chart.label),
  );
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";
  const current = charts[activeIndex];
  const activityColors = useMemo(
    () =>
      new Map(
        current.keys.map((key, index) => [
          key,
          key === OTHER_SLICE_ID
            ? OTHER_COLOR[theme]
            : SERIES_COLORS[theme][index],
        ]),
      ),
    [current.keys, theme],
  );

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    setIsSmallScreen(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsSmallScreen(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const roundedData = current.data.map((item) => {
    const newItem: any = { ...item };
    current.keys.forEach((key) => {
      if (typeof newItem[key] === "number") {
        newItem[key] = Math.round(newItem[key] * 100) / 100;
      }
    });
    return newItem;
  });

  const isJobsChart = current.label !== "Activities";
  const maxValue = isJobsChart
    ? Math.max(
        0,
        ...roundedData.flatMap((item) =>
          current.keys.map((key) =>
            typeof item[key] === "number" ? item[key] : 0,
          ),
        ),
      )
    : undefined;
  const intTickValues = isJobsChart
    ? Array.from({ length: (maxValue as number) + 1 }, (_, i) => i)
    : undefined;

  const totalHours =
    current.label === "Activities"
      ? roundedData.reduce(
          (sum, item) =>
            sum +
            current.keys.reduce(
              (keySum, key) =>
                keySum + (typeof item[key] === "number" ? item[key] : 0),
              0,
            ),
          0,
        )
      : null;

  return (
    <Card className="mb-2 min-w-0 @3xl/main:mb-0">
      <CardHeader className="pb-3">
        <div className="mb-1 mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <CardTitle className="truncate text-lg text-foreground">
              {current.label === "Activities"
                ? t("dashboard.weeklyActivities")
                : t("dashboard.weeklyJobs")}
            </CardTitle>
            {totalHours !== null && (
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {t("dashboard.hoursAbbr", { hours: totalHours.toFixed(1) })}
              </span>
            )}
          </div>
          <div
            className="flex shrink-0 rounded-md border text-xs"
            data-testid="weekly-chart-toggle-group"
          >
            {charts.map((chart, index) => (
              <button
                key={chart.label}
                type="button"
                onClick={() => selectTab(index)}
                className={cn(
                  "px-2 py-1 transition-colors motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  index === 0 && "rounded-l-md",
                  index === charts.length - 1 && "rounded-r-md",
                  activeIndex === index
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                {chart.label === "Activities"
                  ? t("nav.activities")
                  : t("nav.jobs")}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="h-[240px] min-w-0 overflow-hidden p-3 pt-1">
        {current.unavailable ? (
          <div className="flex h-[200px] items-center justify-center">
            <JobsUnavailableNotice className="max-w-md" />
          </div>
        ) : (
        <div className="h-[200px] min-w-0">
          <ResponsiveBar
            data={roundedData}
            keys={current.keys}
            indexBy="day"
            animate={!reduceMotion}
            motionConfig="gentle"
            margin={{
              top: 20,
              right: 10,
              bottom: 40,
              left: isSmallScreen ? 44 : 56,
            }}
            padding={0.6}
            groupMode={current.groupMode}
            colors={
              current.groupMode === "stacked"
                ? (bar) => activityColors.get(String(bar.id)) ?? "#94a3b8"
                : "#2a7ef0"
            }
            enableTotals={current.groupMode === "stacked" ? true : false}
            valueFormat={(value) =>
              current.label === "Activities"
                ? value.toFixed(1)
                : value.toFixed(0)
            }
            theme={{
              text: {
                fill: "var(--color-muted-foreground)",
              },
              tooltip: {
                container: {
                  background: "var(--color-popover)",
                  color: "var(--color-popover-foreground)",
                },
              },
            }}
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
              format: isSmallScreen
                ? (value: string) => value.split(", ")[1] ?? value
                : undefined,
            }}
            axisLeft={{
              tickSize: 5,
              tickPadding: 5,
              tickRotation: 0,
              legend: current.axisLeftLegend,
              legendPosition: "middle",
              legendOffset: isSmallScreen ? -36 : -48,
              truncateTickAt: 0,
              tickValues: intTickValues,
            }}
            tooltip={({ id, value, indexValue, color, data }) => (
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
                {current.tooltipLabel
                  ? current.tooltipLabel(String(id))
                  : String(id) === "value"
                    ? current.axisLeftLegend
                        .toLowerCase()
                        .replace(/\(.*\)/, "")
                        .trim()
                        .replace(/\b\w/g, (c) => c.toUpperCase())
                    : String(id) === OTHER_SLICE_ID
                      ? otherBucketLabel(
                          current.keys.filter((key) => key !== OTHER_SLICE_ID),
                        )
                      : String(id)}
                :{" "}
                <strong>
                  {current.label === "Activities"
                    ? Number(value).toFixed(1)
                    : value}
                </strong>
                {String(id) === OTHER_SLICE_ID &&
                  (data as any).otherBreakdown?.length > 0 &&
                  (data as any).otherBreakdown.map(
                    (activity: { label: string; hours: number }) => (
                      <div key={activity.label}>
                        {activity.label} – {activity.hours}h
                      </div>
                    ),
                  )}
              </div>
            )}
          />
        </div>
        )}
      </CardContent>
    </Card>
  );
}
