import {
  getOverviewDataState,
  getOverviewReminders,
  getOverviewStats,
  getRecentJobs,
} from "@/actions/dashboard.actions";
import { getNextActions } from "@/actions/dashboard/nextActions";
import GettingStarted from "@/components/dashboard/GettingStarted";
import JourneySection from "@/components/dashboard/JourneySection";
import NextActions from "@/components/dashboard/NextActions";
import OverviewMetrics from "@/components/dashboard/OverviewMetrics";
import OverviewReminders from "@/components/dashboard/OverviewReminders";
import RecentUpdates from "@/components/dashboard/RecentUpdates";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.dashboard") };
}

// Overview block order (frozen contract §2.1): O1 welcome + O2 journey cards,
// O3 rule-based next steps, O4 reminders, O5 metrics, O6 recent feed or the
// empty-account starting points.
export default async function Dashboard() {
  const [stats, remindersData, recentJobs, dataState, nextActionsData] =
    await Promise.all([
      getOverviewStats(),
      getOverviewReminders(),
      getRecentJobs(),
      getOverviewDataState(),
      getNextActions(),
    ]);
  return (
    <div className="col-span-3 mx-auto grid w-full max-w-[1400px] min-w-0 auto-rows-max gap-4">
      <JourneySection
        dataState={dataState}
        jobsAbRead={nextActionsData.jobsReadFamily === "ab"}
      />
      <NextActions data={nextActionsData} />
      <OverviewReminders
        reminders={remindersData.reminders}
        timeZone={remindersData.timeZone}
      />
      <OverviewMetrics stats={stats} />
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
