import {
  getActivityCalendarData,
  getJobsActivityForPeriod,
  getJobsActivitySummary,
  getJobsBoardTotals,
  getJobStatusDistribution,
} from "@/actions/dashboard.actions";
import ActivityCalendar from "@/components/dashboard/ActivityCalendar";
import AnalyticsPanel from "@/components/dashboard/AnalyticsPanel";
import BoardTotals from "@/components/dashboard/BoardTotals";
import JobsUnavailableNotice from "@/components/dashboard/JobsUnavailableNotice";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.analytics") };
}

export default async function AnalyticsPage() {
  const { t, locale } = await getServerI18n();
  const [
    totals,
    statusDist,
    trend7,
    trend30,
    summary7,
    summary30,
    activityCalendarData,
  ] = await Promise.all([
    getJobsBoardTotals(),
    getJobStatusDistribution(),
    getJobsActivityForPeriod(7, locale),
    getJobsActivityForPeriod(30, locale),
    getJobsActivitySummary(7),
    getJobsActivitySummary(30),
    getActivityCalendarData(),
  ]);
  // An empty account still gets the current year so the calendar renders a
  // real (empty) grid with a usable year selector instead of a dead select.
  const activityCalendarDataKeys = activityCalendarData.blocked
    ? []
    : Object.keys(activityCalendarData.data);
  const calendarYears =
    activityCalendarDataKeys.length > 0
      ? activityCalendarDataKeys
      : [new Date().getFullYear().toString()];
  return (
    <div className="col-span-3 grid min-w-0 auto-rows-max gap-4">
      <BoardTotals totals={totals} />
      <AnalyticsPanel
        trend7={trend7}
        trend30={trend30}
        statusDist={statusDist}
        activity7={summary7}
        activity30={summary30}
      />
      {activityCalendarData.blocked ? (
        <Card className="w-full min-w-0">
          <CardHeader>
            <CardTitle className="min-w-0 text-lg text-foreground">
              {t("dashboard.activityCalendar")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex h-[200px] min-w-0 items-center justify-center overflow-hidden">
            <JobsUnavailableNotice className="max-w-md" />
          </CardContent>
        </Card>
      ) : (
        <ActivityCalendar
          years={calendarYears}
          dataByYear={activityCalendarData.data}
        />
      )}
    </div>
  );
}
