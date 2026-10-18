import {
  getActivityCalendarData,
  getActivityDataForPeriod,
  getJobsActivityForPeriod,
  getJobsActivitySummary,
  getRecentActivities,
  getRecentJobs,
} from "@/actions/dashboard.actions";
import ActivityCalendar from "@/components/dashboard/ActivityCalendar";
import JobsActivityCard from "@/components/dashboard/JobsActivityCard";
import JobsApplied from "@/components/dashboard/JobsAppliedCard";
import JobsUnavailableNotice from "@/components/dashboard/JobsUnavailableNotice";
import RecentCardToggle from "@/components/dashboard/RecentCardToggle";
import WeeklyBarChartToggle from "@/components/dashboard/WeeklyBarChartToggle";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.dashboard") };
}

export default async function Dashboard() {
  const { t } = await getServerI18n();
  const [
    summary7Days,
    summary30Days,
    recentJobs,
    recentActivities,
    weeklyData,
    activitiesData,
    activityCalendarData,
  ] = await Promise.all([
    getJobsActivitySummary(7),
    getJobsActivitySummary(30),
    getRecentJobs(),
    getRecentActivities(),
    getJobsActivityForPeriod(),
    getActivityDataForPeriod(),
    getActivityCalendarData(),
  ]);
  const activityCalendarDataKeys = activityCalendarData.blocked
    ? []
    : Object.keys(activityCalendarData.data);
  return (
    <>
      <div className="@container grid min-w-0 grid-cols-1 auto-rows-max items-start gap-4 @3xl/main:col-span-2">
        <div className="grid min-w-0 gap-4 @lg:grid-cols-4">
          <JobsApplied />
          <JobsActivityCard
            data={[
              { label: "7d", summary: summary7Days },
              { label: "30d", summary: summary30Days },
            ]}
          />
        </div>
        <WeeklyBarChartToggle
          charts={[
            {
              label: "Jobs",
              data: weeklyData.blocked ? [] : weeklyData.data,
              keys: weeklyData.blocked ? [] : ["value"],
              unavailable: weeklyData.blocked,
              axisLeftLegend: t("dashboard.jobsAppliedAxis"),
            },
            {
              label: "Activities",
              data: activitiesData.data,
              keys: activitiesData.keys,
              groupMode: "stacked",
              axisLeftLegend: t("dashboard.timeSpentHours"),
            },
          ]}
        />
      </div>
      <div className="min-w-0 @3xl/main:relative @3xl/main:self-stretch">
        <RecentCardToggle jobs={recentJobs} activities={recentActivities} />
      </div>
      <div className="col-span-3 w-full min-w-0">
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
            years={activityCalendarDataKeys}
            dataByYear={activityCalendarData.data}
          />
        )}
      </div>
    </>
  );
}
