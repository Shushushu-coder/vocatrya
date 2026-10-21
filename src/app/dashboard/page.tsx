import {
  getOverviewReminders,
  getOverviewStats,
  getRecentActivities,
  getRecentJobs,
} from "@/actions/dashboard.actions";
import OverviewMetrics from "@/components/dashboard/OverviewMetrics";
import OverviewReminders from "@/components/dashboard/OverviewReminders";
import RecentUpdates from "@/components/dashboard/RecentUpdates";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.dashboard") };
}

export default async function Dashboard() {
  const [stats, reminders, recentJobs, recentActivities] = await Promise.all([
    getOverviewStats(),
    getOverviewReminders(),
    getRecentJobs(),
    getRecentActivities(),
  ]);
  return (
    <div className="col-span-3 grid min-w-0 auto-rows-max gap-4">
      <OverviewMetrics stats={stats} />
      <OverviewReminders reminders={reminders} />
      <RecentUpdates jobs={recentJobs} activities={recentActivities} />
    </div>
  );
}
