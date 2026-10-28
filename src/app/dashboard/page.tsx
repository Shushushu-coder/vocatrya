import {
  getOverviewDataState,
  getOverviewReminders,
  getOverviewStats,
  getRecentJobs,
} from "@/actions/dashboard.actions";
import GettingStarted from "@/components/dashboard/GettingStarted";
import OverviewMetrics from "@/components/dashboard/OverviewMetrics";
import OverviewReminders from "@/components/dashboard/OverviewReminders";
import RecentUpdates from "@/components/dashboard/RecentUpdates";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.dashboard") };
}

export default async function Dashboard() {
  const [stats, remindersData, recentJobs, dataState] = await Promise.all([
    getOverviewStats(),
    getOverviewReminders(),
    getRecentJobs(),
    getOverviewDataState(),
  ]);
  return (
    <div className="col-span-3 mx-auto grid w-full max-w-[1400px] min-w-0 auto-rows-max gap-4">
      <OverviewMetrics stats={stats} />
      <OverviewReminders
        reminders={remindersData.reminders}
        timeZone={remindersData.timeZone}
      />
      {/* The starter entries replace the empty feed only on a proven-empty
          account; "unknown" keeps the normal workbench (and its degraded
          notices) rather than offering starters on an unverifiable read. */}
      {dataState === "empty" ? (
        <GettingStarted />
      ) : (
        <RecentUpdates jobs={recentJobs} />
      )}
    </div>
  );
}
