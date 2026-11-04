import { getCareerInsights } from "@/actions/dashboard/insights";
import type { DashboardJobsReadResult } from "@/actions/dashboard/shared";
import JobsCalendar from "@/components/dashboard/JobsCalendar";
import AnalyticsPanel from "@/components/dashboard/AnalyticsPanel";
import BoardTotals from "@/components/dashboard/BoardTotals";
import JobsUnavailableNotice from "@/components/dashboard/JobsUnavailableNotice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.analytics") };
}

export default async function AnalyticsPage() {
  const { t, locale } = await getServerI18n();
  const insights = await getCareerInsights(locale);

  // Every jobs-dependent surface shares the single insights read: a blocked
  // family degrades each section to the same typed result while the
  // family-independent M6/M7 numbers stay real.
  const pick = <T,>(
    select: (data: NonNullable<typeof insights.data>) => T,
  ): DashboardJobsReadResult<T> =>
    insights.blocked
      ? { blocked: true, code: insights.code, message: insights.message }
      : { blocked: false, data: select(insights.data) };

  const jobsCalendarData = pick((data) => data.calendarByYear);
  // An empty account still gets the current year so the calendar renders a
  // real (empty) grid with a usable year selector instead of a dead select.
  const jobsCalendarDataKeys = jobsCalendarData.blocked
    ? []
    : Object.keys(jobsCalendarData.data);
  const calendarYears =
    jobsCalendarDataKeys.length > 0
      ? jobsCalendarDataKeys
      : [new Date().getFullYear().toString()];
  return (
    <div className="col-span-3 grid min-w-0 auto-rows-max gap-4">
      <BoardTotals insights={insights} />
      <AnalyticsPanel
        trend7={pick((data) => data.trend7)}
        trend30={pick((data) => data.trend30)}
        statusDist={pick((data) => data.statusDistribution)}
        family={insights.blocked ? null : insights.data.family}
      />
      {jobsCalendarData.blocked ? (
        <Card className="w-full min-w-0">
          <CardHeader>
            <CardTitle className="min-w-0 text-lg text-foreground">
              {t("dashboard.jobsCalendar")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex h-[200px] min-w-0 items-center justify-center overflow-hidden">
            <JobsUnavailableNotice className="max-w-md" />
          </CardContent>
        </Card>
      ) : (
        <JobsCalendar
          years={calendarYears}
          dataByYear={jobsCalendarData.data}
        />
      )}
    </div>
  );
}
