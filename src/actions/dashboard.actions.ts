// Barrel for the dashboard data functions, split into src/actions/dashboard/.
// Unlike the other action barrels this file and its modules carry no
// "use server": these are plain server-side reads called from the dashboard
// page.

export type { DashboardJobsReadResult } from "./dashboard/shared";

export { getRecentJobs } from "./dashboard/recent";

export {
  getJobsActivityForPeriod,
  getJobsCalendarData,
} from "./dashboard/charts";

export {
  getOverviewStats,
  getOverviewReminders,
  getOverviewDataState,
} from "./dashboard/overview";
export type {
  OverviewStats,
  OverviewReminder,
  OverviewRemindersData,
  OverviewDataState,
} from "./dashboard/overview";

export {
  getJobsBoardTotals,
  getJobStatusDistribution,
} from "./dashboard/board";
