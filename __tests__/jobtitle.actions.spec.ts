import {
  getAllJobTitles,
  getJobTitleList,
  createJobTitle,
  deleteJobTitleById,
} from "@/actions/jobtitle.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { ATTEMPT_STAGE } from "@/lib/career/identities";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    jobTitle: {
      findMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    workExperience: {
      count: vi.fn(),
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

describe("Job Title Actions", () => {
  const mockUser = { id: "user-id" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAllJobTitles", () => {
    it("should return all job titles for authenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockTitles = [
        { id: "title-1", label: "Developer", value: "developer" },
        { id: "title-2", label: "Designer", value: "designer" },
      ];
      (prisma.jobTitle.findMany as any).mockResolvedValue(mockTitles);

      const result = await getAllJobTitles();

      expect(result).toEqual(mockTitles);
      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
      });
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getAllJobTitles();

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.jobTitle.findMany).not.toHaveBeenCalled();
    });

    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobTitle.findMany as any).mockRejectedValue(
        new Error("Database error")
      );

      const result = await getAllJobTitles();

      expect(result).toEqual({ success: false, message: "Database error" });
    });
  });

  describe("getJobTitleList", () => {
    it("should return paginated job title list", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "title-1", label: "Developer", value: "developer" },
      ];
      const mockTotal = 1;

      (prisma.jobTitle.findMany as any).mockResolvedValue(mockData);
      (prisma.jobTitle.count as any).mockResolvedValue(mockTotal);

      const result = await getJobTitleList(1, 10);

      expect(result).toEqual({ data: mockData, total: mockTotal });
      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        orderBy: [{ jobs: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.jobTitle.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
      });
    });

    it("should filter by countBy when provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "title-1", label: "Developer", value: "developer" },
      ];
      (prisma.jobTitle.findMany as any).mockResolvedValue(mockData);
      (prisma.jobTitle.count as any).mockResolvedValue(1);
      (prisma.job.groupBy as any).mockResolvedValue([]);

      const result = await getJobTitleList(1, 10, "applied");

      const expectedData = mockData.map((t) => ({
        ...t,
        _count: { jobsTotal: 0 },
      }));
      expect(result).toEqual({ data: expectedData, total: 1 });
      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        select: {
          id: true,
          label: true,
          value: true,
          _count: {
            select: {
              jobs: {
                where: { applied: true },
              },
            },
          },
        },
        orderBy: [{ jobs: { _count: "desc" } }, { label: "asc" }],
      });
    });

    it("should calculate skip correctly for page 2", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobTitle.findMany as any).mockResolvedValue([]);
      (prisma.jobTitle.count as any).mockResolvedValue(0);

      await getJobTitleList(2, 10);

      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      );
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getJobTitleList(1, 10);

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.jobTitle.findMany).not.toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      (getCurrentUser as any).mockRejectedValue(
        new Error("Database error")
      );

      const result = await getJobTitleList(1, 10);

      expect(result).toEqual({ success: false, message: "Database error" });
    });

    it("should filter job titles by label when search is provided", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "title-1", label: "Developer", value: "developer" },
      ];
      (prisma.jobTitle.findMany as any).mockResolvedValue(mockData);
      (prisma.jobTitle.count as any).mockResolvedValue(1);

      const result = await getJobTitleList(1, 10, undefined, "Dev");

      expect(result).toEqual({ data: mockData, total: 1 });
      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "Dev" } }] },
        skip: 0,
        take: 10,
        orderBy: [{ jobs: { _count: "desc" } }, { label: "asc" }],
      });
      expect(prisma.jobTitle.count).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id, OR: [{ label: { contains: "Dev" } }] },
      });
    });

    it("should not apply a label filter when search is empty", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobTitle.findMany as any).mockResolvedValue([]);
      (prisma.jobTitle.count as any).mockResolvedValue(0);

      await getJobTitleList(1, 10, undefined, "");

      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        skip: 0,
        take: 10,
        orderBy: [{ jobs: { _count: "desc" } }, { label: "asc" }],
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
          id: "title-1",
          label: "Engineer",
          value: "engineer",
          _count: { jobs: 7 },
        },
      ];
      (prisma.jobTitle.findMany as any).mockResolvedValue(mockData);
      (prisma.jobTitle.count as any).mockResolvedValue(1);
      (prisma.jobOpportunity.groupBy as any)
        .mockResolvedValueOnce([{ title: "Engineer", _count: { id: 2 } }])
        .mockResolvedValueOnce([{ title: "Engineer", _count: { id: 5 } }]);

      const result = await getJobTitleList(1, 10, "applied");

      expect(prisma.job.groupBy).not.toHaveBeenCalled();
      expect(prisma.jobOpportunity.groupBy).toHaveBeenNthCalledWith(1, {
        by: ["title"],
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
        by: ["title"],
        where: { userId: mockUser.id, archivedAt: null },
        _count: { id: true },
      });
      // No AB relation exists to sort by — deterministic label order instead
      // of ordering rows on the frozen legacy count.
      expect(prisma.jobTitle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ label: "asc" }] })
      );
      // The stale relation count (7) is overwritten by the label-mapped
      // opportunity aggregate.
      expect(result.data[0]._count.jobs).toBe(2);
      expect(result.data[0]._count.jobsTotal).toBe(5);
    });

    it("fails closed instead of reading legacy stats when the family is blocked", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (resolveJobsReadFamily as any).mockResolvedValueOnce({
        family: "blocked",
        mode: "BLOCKED",
        reason: "migration-in-progress",
      });

      const result = await getJobTitleList(1, 10, "applied");

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unavailable/i);
      expect(prisma.jobTitle.findMany).not.toHaveBeenCalled();
      expect(prisma.job.groupBy).not.toHaveBeenCalled();
    });
  });

  describe("createJobTitle", () => {
    it("should upsert a job title successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockTitle = {
        id: "title-1",
        label: "Senior Developer",
        value: "senior developer",
        createdBy: mockUser.id,
      };
      (prisma.jobTitle.upsert as any).mockResolvedValue(mockTitle);

      const result = await createJobTitle("Senior Developer");

      expect(result).toEqual(mockTitle);
      expect(prisma.jobTitle.upsert).toHaveBeenCalledWith({
        where: { value_createdBy: { value: "senior developer", createdBy: mockUser.id } },
        update: { label: "Senior Developer" },
        create: {
          label: "Senior Developer",
          value: "senior developer",
          createdBy: mockUser.id,
        },
      });
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await createJobTitle("Developer");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.jobTitle.upsert).not.toHaveBeenCalled();
    });

    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobTitle.upsert as any).mockRejectedValue(
        new Error("Upsert failed")
      );

      const result = await createJobTitle("Developer");

      expect(result).toEqual({ success: false, message: "Upsert failed" });
    });
    it("should canonicalize the value (not just lowercase) for matching", async () => {
      // Regression guard: value computation was switched from
      // label.trim().toLowerCase() to canonicalizeEntityValue(), which also
      // folds diacritics and comma separators. A plain-ASCII label wouldn't
      // catch a revert to the old behavior.
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobTitle.upsert as any).mockImplementation(({ create }: any) =>
        Promise.resolve(create),
      );

      const result = await createJobTitle("Ingénieur Logiciel");

      expect(prisma.jobTitle.upsert).toHaveBeenCalledWith({
        where: {
          value_createdBy: {
            value: "ingenieur logiciel",
            createdBy: mockUser.id,
          },
        },
        update: { label: "Ingénieur Logiciel" },
        create: {
          label: "Ingénieur Logiciel",
          value: "ingenieur logiciel",
          createdBy: mockUser.id,
        },
      });
      expect(result.value).toBe("ingenieur logiciel");
    });
  });

  describe("deleteJobTitleById", () => {
    it("should delete a job title successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(0);
      const mockDeleted = { id: "title-1", label: "Developer" };
      (prisma.jobTitle.delete as any).mockResolvedValue(mockDeleted);

      const result = await deleteJobTitleById("title-1");

      expect(result).toEqual({ res: mockDeleted, success: true });
      expect(prisma.jobTitle.delete).toHaveBeenCalledWith({
        where: { id: "title-1", createdBy: mockUser.id },
      });
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await deleteJobTitleById("title-1");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.jobTitle.delete).not.toHaveBeenCalled();
    });

    it("should prevent deletion when work experiences exist", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(2);

      const result = await deleteJobTitleById("title-1");

      expect(result).toEqual({
        success: false,
        message:
          "Job title cannot be deleted due to its use in experience section of one of the resume! ",
      });
      expect(prisma.job.count).not.toHaveBeenCalled();
      expect(prisma.jobTitle.delete).not.toHaveBeenCalled();
    });

    it("should prevent deletion when associated jobs exist", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(3);

      const result = await deleteJobTitleById("title-1");

      expect(result).toEqual({
        success: false,
        message:
          "Job title cannot be deleted due to 3 number of associated jobs! ",
      });
      expect(prisma.jobTitle.delete).not.toHaveBeenCalled();
    });

    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.workExperience.count as any).mockResolvedValue(0);
      (prisma.job.count as any).mockResolvedValue(0);
      (prisma.jobTitle.delete as any).mockRejectedValue(
        new Error("Delete failed")
      );

      const result = await deleteJobTitleById("title-1");

      expect(result).toEqual({ success: false, message: "Delete failed" });
    });
  });
});
