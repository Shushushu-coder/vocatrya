import {
  getJobsCalendarData,
  getJobsActivityForPeriod,
  getJobsBoardTotals,
  getJobStatusDistribution,
} from "@/actions/dashboard.actions";
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
  const [totals, statusDist, trend7, trend30, jobsCalendarData] =
    await Promise.all([
      getJobsBoardTotals(),
      getJobStatusDistribution(),
      getJobsActivityForPeriod(7, locale),
      getJobsActivityForPeriod(30, locale),
      getJobsCalendarData(),
    ]);
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
      <BoardTotals totals={totals} />
      <AnalyticsPanel
        trend7={trend7}
        trend30={trend30}
        statusDist={statusDist}
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
