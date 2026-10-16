// Covers the paginated list in jobSource.actions.ts — not the same-named
// bare-array getJobSourceList in job/references.ts (see job.actions.spec.ts).
import {
  getJobSourceList,
  deleteJobSourceById,
} from "@/actions/jobSource.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { ATTEMPT_STAGE } from "@/lib/career/identities";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    jobSource: {
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    job: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    jobOpportunity: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  };
  return {
    PrismaClient: vi.fn(function () {
      return mPrismaClient;
    }),
  };
});

// The stats columns follow resolveJobsReadFamily; these mocked-action tests
// exercise the legacy branch, so pin the family instead of growing a fake
// migration-state delegate surface.
vi.mock("@/lib/career/jobsReadDispatch", () => ({
  resolveJobsReadFamily: vi.fn(async () => ({
    family: "legacy",
    mode: "LEGACY_ONLY",
    reason: "test-legacy",
  })),
}));

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("Job Source Actions", () => {
  const mockUser = { id: "user-id" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getJobSourceList", () => {
    it("should return paginated job source list", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [{ id: "src-1", label: "LinkedIn", value: "linkedin" }];
      (prisma.jobSource.findMany as any).mockResolvedValue(mockData);
      (prisma.jobSource.count as any).mockResolvedValue(1);

      const result = await getJobSourceList(1, 10);

      expect(result).toEqual({ data: mockData, total: 1 });
      expect(prisma.jobSource.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.jobSource.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
      });
    });

    it("should select applied counts and splice jobsTotal when countBy is provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [{ id: "src-1", label: "LinkedIn", value: "linkedin" }];
      (prisma.jobSource.findMany as any).mockResolvedValue(mockData);
      (prisma.jobSource.count as any).mockResolvedValue(1);
      (prisma.job.groupBy as any).mockResolvedValue([
        { jobSourceId: "src-1", _count: { id: 4 } },
      ]);

      const result = await getJobSourceList(1, 10, "applied");

      expect(result).toEqual({
        data: [{ ...mockData[0], _count: { jobsTotal: 4 } }],
        total: 1,
      });
      expect(prisma.jobSource.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        select: {
          id: true,
          label: true,
          value: true,
          _count: {
            select: {
              jobsApplied: {
                where: { applied: true },
              },
            },
          },
        },
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.job.groupBy).toHaveBeenCalledWith({
        by: ["jobSourceId"],
        where: { userId: mockUser.id },
        _count: { id: true },
      });
    });

    it("should calculate skip correctly for page 3", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findMany as any).mockResolvedValue([]);
      (prisma.jobSource.count as any).mockResolvedValue(0);

      await getJobSourceList(3, 5);

      expect(prisma.jobSource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 })
      );
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getJobSourceList(1, 10);

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.jobSource.findMany).not.toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      (getCurrentUser as any).mockRejectedValue(new Error("Database error"));

      const result = await getJobSourceList(1, 10);

      expect(result).toEqual({ success: false, message: "Database error" });
    });

    it("should filter job sources by label when search is provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [{ id: "src-1", label: "LinkedIn", value: "linkedin" }];
      (prisma.jobSource.findMany as any).mockResolvedValue(mockData);
      (prisma.jobSource.count as any).mockResolvedValue(1);

      const result = await getJobSourceList(1, 10, undefined, "Link");

      expect(result).toEqual({ data: mockData, total: 1 });
      expect(prisma.jobSource.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "Link" } }] },
        skip: 0,
        take: 10,
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.jobSource.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "Link" } }] },
      });
    });

    it("should not apply a label filter when search is empty", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findMany as any).mockResolvedValue([]);
      (prisma.jobSource.count as any).mockResolvedValue(0);

      await getJobSourceList(1, 10, undefined, "");

      expect(prisma.jobSource.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
    });

    it("reads stats from JobOpportunity label groups under the A+B family", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (resolveJobsReadFamily as any).mockResolvedValueOnce({
        family: "ab",
        mode: "AB_NATIVE",
        reason: "test-ab",
      });
      const mockData = [
        {
          id: "src-1",
          label: "Indeed",
          value: "indeed",
          _count: { jobsApplied: 8 },
        },
      ];
      (prisma.jobSource.findMany as any).mockResolvedValue(mockData);
      (prisma.jobSource.count as any).mockResolvedValue(1);
      (prisma.jobOpportunity.groupBy as any)
        .mockResolvedValueOnce([{ sourceLabel: "Indeed", _count: { id: 3 } }])
        .mockResolvedValueOnce([{ sourceLabel: "Indeed", _count: { id: 6 } }]);

      const result = await getJobSourceList(1, 10, "applied");

      expect(prisma.job.groupBy).not.toHaveBeenCalled();
      expect(prisma.jobOpportunity.groupBy).toHaveBeenNthCalledWith(1, {
        by: ["sourceLabel"],
        where: {
          userId: mockUser.id,
          archivedAt: null,
          applicationAttempts: {
            some: {
              archivedAt: null,
              OR: [
                { submittedAt: { not: null } },
                { currentStageCategory: { not: ATTEMPT_STAGE.DRAFT } },
              ],
            },
          },
        },
        _count: { id: true },
      });
      expect(prisma.jobOpportunity.groupBy).toHaveBeenNthCalledWith(2, {
        by: ["sourceLabel"],
        where: { userId: mockUser.id, archivedAt: null },
        _count: { id: true },
      });
      expect(prisma.jobSource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ label: "asc" }] })
      );
      // The stale relation count (8) is overwritten by the label-mapped
      // opportunity aggregate.
      expect(result.data[0]._count.jobsApplied).toBe(3);
      expect(result.data[0]._count.jobsTotal).toBe(6);
    });

    it("fails closed instead of reading legacy stats when the family is blocked", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (resolveJobsReadFamily as any).mockResolvedValueOnce({
        family: "blocked",
        mode: "BLOCKED",
        reason: "migration-in-progress",
      });

      const result = await getJobSourceList(1, 10, "applied");

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unavailable/i);
      expect(prisma.jobSource.findMany).not.toHaveBeenCalled();
      expect(prisma.job.groupBy).not.toHaveBeenCalled();
    });
  });

  describe("deleteJobSourceById", () => {
    it("should delete a job source with no linked jobs", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.count as any).mockResolvedValue(0);
      (prisma.jobSource.delete as any).mockResolvedValue({ id: "src-1" });

      const result = await deleteJobSourceById("src-1");

      expect(result).toEqual({ res: { id: "src-1" }, success: true });
      expect(prisma.jobSource.delete).toHaveBeenCalledWith({
        where: { id: "src-1", createdBy: mockUser.id },
      });
    });

    it("should refuse to delete a job source that has linked jobs", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.count as any).mockResolvedValue(2);

      const result = await deleteJobSourceById("src-1");

      expect(result).toEqual({
        success: false,
        message:
          "Job source cannot be deleted due to 2 number of associated jobs! ",
      });
      expect(prisma.jobSource.delete).not.toHaveBeenCalled();
    });
  });
});
