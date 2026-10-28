"use client";
import { useState } from "react";
import { useI18n } from "@/i18n";
import { ResponsiveCalendar } from "@nivo/calendar";
import { format, parseISO } from "date-fns";
import { useTheme } from "next-themes";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
// make sure parent container have a defined height when using
// responsive component, otherwise height will be 0 and
// no chart will be rendered.
// website examples showcase many properties,
// you'll often use just a few of them.
export default function JobsCalendar({
  years,
  dataByYear,
}: {
  years: string[];
  dataByYear: Record<string, any[]>;
}) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const [year, setYear] = useState(years.at(-1));
  const borderColor = "var(--color-card)";
  const data = dataByYear[year ?? ""] ?? [];
  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="min-w-0 text-lg text-foreground">{t("dashboard.jobsCalendar")}</CardTitle>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-[100px]" aria-label={t("dashboard.selectYear")}>
              <SelectValue placeholder={t("dashboard.selectYear")} />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="h-[200px] min-w-0 overflow-hidden">
        <ResponsiveCalendar
          data={data}
          from={`${year}-01-01`}
          to={`${year}-12-31`}
          emptyColor={resolvedTheme === "light" ? "#eeeeee" : "#30363d"}
          colors={["#90e0ef", "#48cae4", "#00b4d8", "#0096c7", "#0077b6"]}
          minValue={2}
          margin={{ top: 20, right: 0, bottom: 20, left: 0 }}
          yearSpacing={40}
          monthBorderColor={borderColor}
          dayBorderWidth={2}
          dayBorderColor={borderColor}
          tooltip={(day) => (
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
              <div><strong>{format(parseISO(day.day), "EEE MMM d, yyyy")}</strong></div>
              <div>
                {t(
                  Number(day.value) === 1
                    ? "dashboard.calendarJobsOne"
                    : "dashboard.calendarJobsMany",
                  { count: day.value },
                )}
              </div>
            </div>
          )}
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
          legends={[
            {
              anchor: "bottom-right",
              direction: "row",
              translateY: 36,
              itemCount: 4,
              itemWidth: 42,
              itemHeight: 36,
              itemsSpacing: 14,
              itemDirection: "right-to-left",
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
