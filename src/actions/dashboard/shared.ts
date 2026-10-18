import {
  isJobsReadUnavailableError,
  JOBS_READ_UNAVAILABLE_CODE,
} from "@/lib/career/jobsReadDispatch";

export const roundToTenth = (hours: number) => Math.round(hours * 10) / 10;

// Local-time day range: start at 00:00 daysBack days ago, end today 23:59:59.999
export const getLocalDayRange = (
  daysBack: number,
): { start: Date; end: Date } => {
  const now = new Date();
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysBack,
    0,
    0,
    0,
    0,
  );
  return { start, end };
};

// A blocked jobs read family is a declared runtime state, not a data error:
// the dashboard degrades the affected sections to this explicit result instead
// of failing the whole page, and never fabricates zero counts.
export type DashboardJobsReadResult<T> =
  | { blocked: false; data: T }
  | {
      blocked: true;
      code: typeof JOBS_READ_UNAVAILABLE_CODE;
      message: string;
    };

export async function jobsReadOrBlocked<T>(
  read: () => Promise<T>,
): Promise<DashboardJobsReadResult<T>> {
  try {
    return { blocked: false, data: await read() };
  } catch (error) {
    if (isJobsReadUnavailableError(error)) {
      return {
        blocked: true,
        code: JOBS_READ_UNAVAILABLE_CODE,
        message: error.message,
      };
    }
    throw error;
  }
}
