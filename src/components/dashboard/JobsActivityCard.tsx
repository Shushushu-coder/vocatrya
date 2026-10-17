"use client";

import { RefObject, useMemo, useRef } from "react";
import { Pie, PieSvgProps } from "@nivo/pie";
import { animated } from "@react-spring/web";
import { useTheme } from "next-themes";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  JobsActivitySummary,
  TopActivityType,
} from "@/actions/dashboard.actions";
import { useElementWidth } from "@/hooks/useElementWidth";
import { usePersistedTabIndex } from "@/hooks/usePersistedTabIndex";
import { APP_CONSTANTS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  ARC_LABEL_TEXT_COLOR,
  arcLabelLines,
  buildDonutSlices,
  CHART_HEIGHT,
  donutLayout,
  DonutSlice,
} from "./jobsActivityChart";

interface JobsActivityCardProps {
  data: {
    label: string;
    summary: JobsActivitySummary;
  }[];
}

type ArcLinkLabelProps = Parameters<
  NonNullable<PieSvgProps<DonutSlice>["arcLinkLabelComponent"]>
>[0];

// Hole the total needs before the hours, jobs and trend lines all clear the
// ring; under it the trend goes and the other two step down a size.
const FULL_TOTAL_HOLE = 96;

// nivo renders an arc link label as one <text>, so stacking the hours under
// the name needs a custom component rather than a label formatter.
// The budget arrives by ref because a new component type would remount the
// whole label subtree on every frame the card resizes.
function makeArcLinkLabel(maxChars: RefObject<number>) {
  return function ArcLinkLabel({ datum, style }: ArcLinkLabelProps) {
    const [name, hours] = arcLabelLines(datum.data, maxChars.current);

    return (
      <animated.g opacity={style.opacity}>
        <animated.path
          fill="none"
          stroke={style.linkColor}
          strokeWidth={style.thickness}
          d={style.path}
        />
        <animated.text
          transform={style.textPosition}
          textAnchor={style.textAnchor}
          dominantBaseline="central"
          fill={style.textColor}
          fontSize={11}
        >
          <tspan x={0} dy="-0.5em">
            {name}
          </tspan>
          <tspan x={0} dy="1.15em" fontWeight={600}>
            {hours}
          </tspan>
        </animated.text>
      </animated.g>
    );
  };
}

import { useI18n } from "@/i18n";

export default function JobsActivityCard({ data }: JobsActivityCardProps) {
  const { t } = useI18n();
  const [activeIndex, selectTab] = usePersistedTabIndex(
    APP_CONSTANTS.DASHBOARD_JOBS_ACTIVITY_STORAGE_KEY,
    data.map((item) => item.label),
  );
  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";
  const current = data[activeIndex];
  const {
    jobsApplied,
    jobsTrend,
    topActivities,
    otherActivities,
    otherHours,
    totalHours,
  } = current.summary;
  const slices = buildDonutSlices(
    topActivities,
    otherHours,
    theme,
    otherActivities,
  );
  const layout = donutLayout(chartWidth);
  const roomyTotal = layout.holeDiameter >= FULL_TOTAL_HOLE;
  const maxLabelChars = useRef(layout.maxLabelChars);
  maxLabelChars.current = layout.maxLabelChars;
  const arcLinkLabelComponent = useMemo(
    () => makeArcLinkLabel(maxLabelChars),
    [],
  );

  return (
    <Card className="min-w-0 @lg:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <CardTitle className="min-w-0 truncate text-lg text-foreground">
              {t("dashboard.jobsAndActivity")}
            </CardTitle>
            <span className="shrink-0 text-xs text-muted-foreground">
              {current.label === "7d"
                ? t("dashboard.window7d")
                : current.label === "30d"
                  ? t("dashboard.window30d")
                  : current.label}
            </span>
          </div>
          <div
            className="flex shrink-0 rounded-md border text-xs"
            data-testid="jobs-activity-toggle-group"
          >
            {data.map((item, index) => (
              <button
                key={item.label}
                type="button"
                onClick={() => selectTab(index)}
                className={cn(
                  "px-2 py-1 transition-colors motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  index === 0 && "rounded-l-md",
                  index === data.length - 1 && "rounded-r-md",
                  activeIndex === index
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                {item.label === "7d"
                  ? t("dashboard.window7d")
                  : item.label === "30d"
                    ? t("dashboard.window30d")
                    : item.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div ref={chartRef} className="relative h-[200px] w-full">
          {slices.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center">
              <div className="h-[132px] w-[132px] rounded-full border-[18px] border-muted" />
              <p className="absolute inset-x-0 bottom-0 text-center text-sm text-muted-foreground">
                {t("activities.noActivities")}
              </p>
            </div>
          ) : (
            chartWidth > 0 && (
              <Pie
                data={slices}
                // Sized from the card's own measurement rather than a second
                // one of nivo's: two observers on this box update a frame
                // apart, and the frame where the new gutters met the old
                // width collapsed the donut to half its radius.
                width={chartWidth}
                height={CHART_HEIGHT}
                // Width changes land on every frame of the panel's 200ms
                // transition, so the donut tracks them instead of springing
                // toward each one in turn.
                animate={false}
                margin={{
                  top: 26,
                  right: layout.gutter,
                  bottom: 26,
                  left: layout.gutter,
                }}
                innerRadius={0.72}
                padAngle={2}
                cornerRadius={2}
                activeOuterRadiusOffset={4}
                colors={{ datum: "data.color" }}
                borderWidth={0}
                enableArcLabels={false}
                enableArcLinkLabels
                arcLinkLabelComponent={arcLinkLabelComponent}
                arcLinkLabelsThickness={2}
                arcLinkLabelsDiagonalLength={10}
                arcLinkLabelsStraightLength={12}
                arcLinkLabelsTextOffset={4}
                arcLinkLabelsColor={{ from: "data.color" }}
                arcLinkLabelsTextColor={ARC_LABEL_TEXT_COLOR[theme]}
                theme={{
                  text: { fontSize: 11 },
                  tooltip: {
                    container: {
                      background: "var(--color-popover)",
                      color: "var(--color-popover-foreground)",
                    },
                  },
                }}
                tooltip={({ datum }) => (
                  <div
                    style={{
                      background: "var(--color-popover)",
                      color: "var(--color-popover-foreground)",
                      border: "1px solid var(--color-border)",
                      padding: "6px 12px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <strong>{datum.data.label}</strong> — {datum.value}h
                    {datum.data.breakdown?.map((activity: TopActivityType) => (
                      <div key={activity.label}>
                        {activity.label} — {activity.hours}h
                      </div>
                    ))}
                  </div>
                )}
              />
            )
          )}
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-px text-center"
            data-testid="jobs-activity-total"
          >
            <span
              className={cn(
                "font-bold leading-tight tabular-nums",
                roomyTotal ? "text-xl" : "text-base",
              )}
            >
              {totalHours}
              {t("common.hoursShort")}
            </span>
            <span
              className={cn(
                "text-muted-foreground tabular-nums",
                roomyTotal ? "text-sm" : "text-xs",
              )}
            >
              {t(
                jobsApplied === 1
                  ? "dashboard.jobCountOne"
                  : "dashboard.jobCountMany",
                { count: jobsApplied },
              )}
            </span>
            {current.summary.jobsInterview != null && (
              <span
                className={cn(
                  "text-muted-foreground tabular-nums",
                  roomyTotal ? "text-xs" : "text-[10px]",
                )}
                data-testid="jobs-activity-interview-count"
              >
                {t(
                  current.summary.jobsInterview === 1
                    ? "dashboard.interviewCountOne"
                    : "dashboard.interviewCountMany",
                  { count: current.summary.jobsInterview },
                )}
              </span>
            )}
            {current.summary.jobsOffer != null && (
              <span
                className={cn(
                  "text-muted-foreground tabular-nums",
                  roomyTotal ? "text-xs" : "text-[10px]",
                )}
                data-testid="jobs-activity-offer-count"
              >
                {t(
                  current.summary.jobsOffer === 1
                    ? "dashboard.offerCountOne"
                    : "dashboard.offerCountMany",
                  { count: current.summary.jobsOffer },
                )}
              </span>
            )}
            {jobsTrend !== 0 && roomyTotal && (
              <span
                className={cn(
                  "flex items-center gap-0.5 text-[10px] tabular-nums",
                  jobsTrend > 0 ? "text-success" : "text-destructive-text",
                )}
              >
                {jobsTrend > 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {Math.abs(jobsTrend)}%
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
