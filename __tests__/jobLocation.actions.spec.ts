import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import {
  getAllJobLocations,
  getJobLocationsList,
  updateJobLocation,
  deleteJobLocationById,
} from "@/actions/jobLocation.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { ATTEMPT_STAGE } from "@/lib/career/identities";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    location: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    workExperience: {
      count: vi.fn(),
    },
    education: {
      count: vi.fn(),
    },
    contact: {
      count: vi.fn(),
    },
    job: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    $transaction: vi.fn(),
    jobOpportunity: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  };
  mPrismaClient.$transaction.mockImplementation(async (run) => run(mPrismaClient));
  return { PrismaClient: vi.fn(function() { return mPrismaClient; }) };
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

describe("Job Location Actions", () => {
  const mockUser = { id: "user-id" };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.jobOpportunity.count as any).mockResolvedValue(0);
  });

  describe("getAllJobLocations", () => {
    it("should return job locations for authenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockLocations = [
        { id: "loc-1", label: "New York", value: "new york" },
        { id: "loc-2", label: "Remote", value: "remote" },
      ];
      (prisma.location.findMany as any).mockResolvedValue(mockLocations);

      const result = await getAllJobLocations();

      expect(result).toEqual(mockLocations);
      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
      });
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getAllJobLocations();

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.location.findMany).not.toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findMany as any).mockRejectedValue(
        new Error("Database error")
      );

      const result = await getAllJobLocations();

      expect(result).toEqual({ success: false, message: "Database error" });
    });
  });

  describe("getJobLocationsList", () => {
    it("should return paginated location list", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "loc-1", label: "New York", value: "new york" },
      ];
      const mockTotal = 1;

      (prisma.location.findMany as any).mockResolvedValue(mockData);
      (prisma.location.count as any).mockResolvedValue(mockTotal);

      const result = await getJobLocationsList(1, 10);

      expect(result).toEqual({ data: mockData, total: mockTotal });
      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.location.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
      });
    });

    it("should filter by countBy when provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "loc-1", label: "New York", value: "new york" },
      ];
      (prisma.location.findMany as any).mockResolvedValue(mockData);
      (prisma.location.count as any).mockResolvedValue(1);
      (prisma.job.groupBy as any).mockResolvedValue([]);

      const result = await getJobLocationsList(1, 10, "applied");

      const expectedData = mockData.map((l) => ({
        ...l,
        _count: { jobsTotal: 0 },
      }));
      expect(result).toEqual({ data: expectedData, total: 1 });
      expect(prisma.location.findMany).toHaveBeenCalledWith({
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
    });

    it("should calculate skip correctly for page 3", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findMany as any).mockResolvedValue([]);
      (prisma.location.count as any).mockResolvedValue(0);

      await getJobLocationsList(3, 5);

      expect(prisma.location.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 })
      );
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getJobLocationsList(1, 10);

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.location.findMany).not.toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      (getCurrentUser as any).mockRejectedValue(
        new Error("Database error")
      );

      const result = await getJobLocationsList(1, 10);

      expect(result).toEqual({ success: false, message: "Database error" });
    });

    it("should filter locations by label when search is provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [{ id: "loc-1", label: "New York", value: "new york" }];
      (prisma.location.findMany as any).mockResolvedValue(mockData);
      (prisma.location.count as any).mockResolvedValue(1);

      const result = await getJobLocationsList(1, 10, undefined, "New");

      expect(result).toEqual({ data: mockData, total: 1 });
      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "New" } }] },
        skip: 0,
        take: 10,
        orderBy: [{ jobsApplied: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.location.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "New" } }] },
      });
    });

    it("should not apply a label filter when search is empty", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findMany as any).mockResolvedValue([]);
      (prisma.location.count as any).mockResolvedValue(0);

      await getJobLocationsList(1, 10, undefined, "");

      expect(prisma.location.findMany).toHaveBeenCalledWith({
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
          id: "loc-1",
          label: "Remote",
          value: "remote",
          _count: { jobsApplied: 6 },
        },
      ];
      (prisma.location.findMany as any).mockResolvedValue(mockData);
      (prisma.location.count as any).mockResolvedValue(1);
      (prisma.jobOpportunity.groupBy as any)
        .mockResolvedValueOnce([{ locationText: "Remote", _count: { id: 1 } }])
        .mockResolvedValueOnce([{ locationText: "Remote", _count: { id: 4 } }]);

      const result = await getJobLocationsList(1, 10, "applied");

      expect(prisma.job.groupBy).not.toHaveBeenCalled();
      expect(prisma.jobOpportunity.groupBy).toHaveBeenNthCalledWith(1, {
        by: ["locationText"],
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
        by: ["locationText"],
        where: { userId: mockUser.id, archivedAt: null },
        _count: { id: true },
      });
      expect(prisma.location.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ label: "asc" }] })
      );
      // The stale relation count (6) is overwritten by the label-mapped
      // opportunity aggregate.
      expect(result.data[0]._count.jobsApplied).toBe(1);
      expect(result.data[0]._count.jobsTotal).toBe(4);
    });

    it("fails closed instead of reading legacy stats when the family is blocked", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (resolveJobsReadFamily as any).mockResolvedValueOnce({
        family: "blocked",
        mode: "BLOCKED",
        reason: "migration-in-progress",
      });

      const result = await getJobLocationsList(1, 10, "applied");

      expect(result.success).toBe(false);
      expect(result.message).toBe(CAREER_JOBS_UNAVAILABLE_MESSAGE);
      expect(prisma.location.findMany).not.toHaveBeenCalled();
      expect(prisma.job.groupBy).not.toHaveBeenCalled();
    });
  });

  describe("updateJobLocation", () => {
    const existing = {
      id: "loc-1",
      label: "New York",
      value: "new york",
      createdBy: "user-id",
    };

    it("should rename the label and recompute the canonical value", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      const updated = { ...existing, label: "Remote US", value: "remote us" };
      (prisma.location.update as any).mockResolvedValue(updated);

      const result = await updateJobLocation("loc-1", "  Remote US  ");

      expect(result).toEqual({ success: true, data: updated });
      expect(prisma.location.findFirst).toHaveBeenNthCalledWith(2, {
        where: { value: "remote us", createdBy: mockUser.id },
      });
      expect(prisma.location.update).toHaveBeenCalledWith({
        where: { id: "loc-1", createdBy: mockUser.id },
        data: { label: "Remote US", value: "remote us" },
      });
    });

    it("should keep the stored value when the label is unchanged", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(existing);
      (prisma.location.update as any).mockResolvedValue(existing);

      const result = await updateJobLocation("loc-1", "New York");

      expect(result.success).toBe(true);
      expect(prisma.location.findFirst).toHaveBeenCalledTimes(1);
    });

    it("should reject a rename that collides with another row's value", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ id: "loc-2", value: "remote" });

      const result = await updateJobLocation("loc-1", "Remote");

      expect(result).toEqual({
        success: false,
        message: "Job location already exists!",
      });
      expect(prisma.location.update).not.toHaveBeenCalled();
    });

    it("should return error when the row does not belong to the user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(null);

      const result = await updateJobLocation("loc-1", "Remote");

      expect(result).toEqual({
        success: false,
        message: "Job location not found",
      });
      expect(prisma.location.update).not.toHaveBeenCalled();
    });

    it("should return error for an empty label", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(existing);

      const result = await updateJobLocation("loc-1", "   ");

      expect(result).toEqual({
        success: false,
        message: "Job location label cannot be empty.",
      });
      expect(prisma.location.update).not.toHaveBeenCalled();
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await updateJobLocation("loc-1", "Remote");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.location.update).not.toHaveBeenCalled();
    });

    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      (prisma.location.update as any).mockRejectedValue(
        new Error("Update failed")
      );

      const result = await updateJobLocation("loc-1", "Remote");

      expect(result).toEqual({ success: false, message: "Update failed" });
    });
  });

  describe("deleteJobLocationById", () => {
    beforeEach(() => {
      (prisma.contact.count as any).mockResolvedValue(0);
    });

    it("should delete a location successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.education.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(0);
      const mockDeleted = { id: "loc-1", label: "New York" };
      (prisma.location.delete as any).mockResolvedValue(mockDeleted);

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({ res: mockDeleted, success: true });
      expect(prisma.location.delete).toHaveBeenCalledWith({
        where: { id: "loc-1", createdBy: mockUser.id },
      });
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it("should prevent deletion when work experiences exist", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(1);

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({
        success: false,
        message:
          "Job location cannot be deleted due to its use in experience section of one of the resume! ",
      });
      expect(prisma.education.count).not.toHaveBeenCalled();
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it("should prevent deletion when education records exist", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.education.count as any).mockResolvedValue(2);

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({
        success: false,
        message:
          "Job location cannot be deleted due to its use in education section of one of the resume! ",
      });
      expect(prisma.job.count).not.toHaveBeenCalled();
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it("should prevent deletion when associated jobs exist", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.education.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(5);

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({
        success: false,
        message:
          "Location cannot be deleted due to 5 number of associated jobs! ",
      });
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it("refuses to delete a location a contact points at", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.education.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(0);
      (prisma.contact.count as any).mockResolvedValue(1);

      const result = await deleteJobLocationById("loc-1");

      expect(prisma.contact.count).toHaveBeenCalledWith({
        where: { locationId: "loc-1", createdBy: mockUser.id },
      });
      expect(result.success).toBe(false);
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.education.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(0);
      (prisma.location.delete as any).mockRejectedValue(
        new Error("Delete failed")
      );

      const result = await deleteJobLocationById("loc-1");

      expect(result).toEqual({ success: false, message: "Delete failed" });
    });
  });
});
