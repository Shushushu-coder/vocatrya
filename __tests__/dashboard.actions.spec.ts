import {
  getRecentJobs,
  getJobsActivityForPeriod,
  getJobsCalendarData,
} from "@/actions/dashboard.actions";
import { APP_CONSTANTS } from "@/lib/constants";
import { getCurrentUser } from "@/utils/user.utils";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Mock the Prisma Client
vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    job: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return {
    PrismaClient: vi.fn(function () {
      return mPrismaClient;
    }),
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

describe("Dashboard Actions", () => {
  const mockUser = { id: "user-id" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRecentJobs", () => {
    it("should return recent jobs for authenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockJobs = [
        {
          id: "job-1",
          title: "Software Engineer",
          Company: { label: "Company 1" },
          Status: { label: "Applied" },
        },
        {
          id: "job-2",
          title: "Frontend Developer",
          Company: { label: "Company 2" },
          Status: { label: "Interview" },
        },
      ];
      (prisma.job.findMany as any).mockResolvedValue(mockJobs);

      const result = await getRecentJobs();

      expect(result).toEqual({ blocked: false, data: mockJobs });
      expect(prisma.job.findMany).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          applied: true,
        },
        include: {
          JobSource: true,
          JobTitle: true,
          Company: true,
          Status: true,
          Location: true,
        },
        orderBy: {
          appliedDate: "desc",
        },
        take: APP_CONSTANTS.RECENT_NUM_JOBS,
      });
    });

    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(getRecentJobs()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should handle database errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.findMany as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(getRecentJobs()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should return empty array when no jobs found", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.findMany as any).mockResolvedValue([]);

      const result = await getRecentJobs();

      expect(result).toEqual({ blocked: false, data: [] });
    });

    it("returns a typed blocked result when the jobs read family is blocked", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      // A migration-state row in a non-terminal status resolves the runtime to
      // BLOCKED before any jobs delegate is touched.
      (prisma as any).abMigrationState = {
        findUnique: vi.fn().mockResolvedValue({
          id: "state-1",
          scopeKey: "instance",
          migrationKey: "ab-migration",
          status: "IN_PROGRESS",
          completedAt: null,
          verifiedAt: null,
          errorCode: null,
        }),
      };
      try {
        const result = await getRecentJobs();
        expect(result).toMatchObject({
          blocked: true,
          code: "JOBS_READ_UNAVAILABLE",
        });
        expect("data" in result).toBe(false);
        expect(prisma.job.findMany).not.toHaveBeenCalled();
      } finally {
        delete (prisma as any).abMigrationState;
      }
    });
  });

  describe("getJobsActivityForPeriod", () => {
    it("should return jobs activity data for authenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockJobData = [
        {
          appliedDate: new Date("2024-01-01"),
          _count: { _all: 3 },
        },
        {
          appliedDate: new Date("2024-01-02"),
          _count: { _all: 5 },
        },
      ];
      (prisma.job.groupBy as any).mockResolvedValue(mockJobData);

      const result = await getJobsActivityForPeriod();

      expect(result.blocked).toBe(false);
      if (result.blocked) return;
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(7);
      result.data.forEach((item: any) => {
        expect(item).toHaveProperty("day");
        expect(item).toHaveProperty("value");
        expect(typeof item.value).toBe("number");
      });
    });

    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(getJobsActivityForPeriod()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should handle database errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.groupBy as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(getJobsActivityForPeriod()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should return zero values for days with no jobs", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.groupBy as any).mockResolvedValue([]);

      const result = await getJobsActivityForPeriod();

      expect(result.blocked).toBe(false);
      if (result.blocked) return;
      expect(result.data.length).toBe(7);
      result.data.forEach((item: any) => {
        expect(item.value).toBe(0);
      });
    });
  });

  describe("getJobsCalendarData", () => {
    it("should return calendar data grouped by year for authenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockJobData = [
        {
          appliedDate: new Date("2024-01-15"),
          _count: { _all: 2 },
        },
        {
          appliedDate: new Date("2024-03-20"),
          _count: { _all: 3 },
        },
        {
          appliedDate: new Date("2023-12-10"),
          _count: { _all: 1 },
        },
      ];
      (prisma.job.groupBy as any).mockResolvedValue(mockJobData);

      const result = await getJobsCalendarData();

      expect(result.blocked).toBe(false);
      expect(prisma.job.groupBy).toHaveBeenCalledTimes(1);
    });

    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(getJobsCalendarData()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should handle database errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.groupBy as any).mockRejectedValue(
        new Error("Database error"),
      );

      await expect(getJobsCalendarData()).rejects.toThrow(
        "Failed to fetch jobs list. ",
      );
    });

    it("should return empty object when no job data", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.groupBy as any).mockResolvedValue([]);

      const result = await getJobsCalendarData();

      expect(result).toEqual({ blocked: false, data: {} });
    });

    it("should correctly group jobs by year", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockJobData = [
        {
          appliedDate: new Date("2024-06-15"),
          _count: { _all: 2 },
        },
        {
          appliedDate: new Date("2024-06-16"),
          _count: { _all: 3 },
        },
      ];
      (prisma.job.groupBy as any).mockResolvedValue(mockJobData);

      const result = await getJobsCalendarData();

      expect(result.blocked).toBe(false);
      if (result.blocked) return;
      expect(result.data).toHaveProperty("2024");
      expect(Array.isArray(result.data["2024"])).toBe(true);
      expect(result.data["2024"].length).toBe(2);
      result.data["2024"].forEach((item: any) => {
        expect(item).toHaveProperty("day");
        expect(item).toHaveProperty("value");
      });
    });

    it("should aggregate counts for same date", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockJobData = [
        {
          appliedDate: new Date("2024-06-15T10:00:00Z"),
          _count: { _all: 2 },
        },
        {
          appliedDate: new Date("2024-06-15T14:00:00Z"),
          _count: { _all: 3 },
        },
      ];
      (prisma.job.groupBy as any).mockResolvedValue(mockJobData);

      const result = await getJobsCalendarData();

      expect(result.blocked).toBe(false);
      if (result.blocked) return;
      expect(result.data["2024"].length).toBe(1);
      expect(result.data["2024"][0].value).toBe(5);
    });
  });
});
