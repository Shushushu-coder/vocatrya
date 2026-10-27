import {
  addJob,
  createLocation,
  createJobSource,
  deleteJobById,
  getJobDetails,
  getJobsList,
  getJobSourceList,
  getStatusList,
  saveJobMatchResult,
  updateJob,
  updateJobStatus,
} from "@/actions/job.actions";
import { getMockJobDetails, getMockJobsList } from "@/lib/mock.utils";
import { JobResponse } from "@/models/job.model";
import { getCurrentUser } from "@/utils/user.utils";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Mock the Prisma Client
vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    jobStatus: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    jobSource: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
    },
    job: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    location: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    jobTitle: { count: vi.fn() },
    company: { count: vi.fn() },
    resume: { count: vi.fn() },
    coverLetter: { count: vi.fn() },
    tag: { count: vi.fn() },
    userSettings: { findUnique: vi.fn(() => null) },
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("jobActions", () => {
  const mockUser = { id: "user-id" };
  const jobData = {
    id: "job-id",
    title: "job-title-id",
    company: "company-id",
    location: "location-id",
    type: "FT",
    status: "status-id",
    source: "source-id",
    salaryRange: "$50,000 - $70,000",
    createdAt: expect.any(Date),
    dueDate: new Date("2023-01-01"),
    dateApplied: new Date("2022-12-31"),
    jobDescription: "Job description",
    jobUrl: "https://example.com/job",
    applied: true,
    userId: mockUser.id,
    resume: "",
    tags: [],
  };
  const refModels = [
    "jobTitle",
    "company",
    "location",
    "jobSource",
    "resume",
    "coverLetter",
    "tag",
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    for (const model of refModels) {
      (prisma as any)[model].count.mockResolvedValue(1);
    }
    (prisma.jobStatus.findUnique as any).mockResolvedValue({
      id: "status-id",
      value: "new",
      label: "New",
    });
    (prisma.jobSource.upsert as any).mockResolvedValue({ count: 0 });
  });
  describe("getStatusList", () => {
    it("should return status list on successful query", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      const mockStatuses = [
        { id: "1", label: "Pending", value: "pending" },
        { id: "2", label: "Processing", value: "processing" },
      ];
      (prisma.jobStatus.findMany as any).mockResolvedValue(mockStatuses);

      const result = await getStatusList();
      expect(result).toEqual(mockStatuses);
    });

    it("returns canonical order regardless of the database row order", async () => {
      // Regression guard: business semantics must not depend on the physical
      // order of the JobStatus reference table (row order is an accident of
      // seed history, e.g. offer-accepted rows landed first).
      const scrambled = [
        { id: "9", label: "Offer Declined", value: "offer-declined" },
        { id: "1", label: "New", value: "new" },
        { id: "8", label: "Archived", value: "archived" },
        { id: "3", label: "Applied", value: "applied" },
        { id: "4", label: "Interview", value: "interview" },
        { id: "2", label: "Draft", value: "draft" },
        { id: "5", label: "Offer", value: "offer" },
        { id: "6", label: "Offer Accepted", value: "offer-accepted" },
        { id: "7", label: "Rejected", value: "rejected" },
        { id: "10", label: "Expired", value: "expired" },
      ];
      (prisma.jobStatus.findMany as any).mockResolvedValue(scrambled);

      const result = await getStatusList();

      expect(result.map((s: any) => s.value)).toEqual([
        "new",
        "draft",
        "applied",
        "interview",
        "offer",
        "offer-accepted",
        "offer-declined",
        "rejected",
        "expired",
        "archived",
      ]);
    });

    it("initializes default statuses when the table is empty", async () => {
      vi.mocked(prisma.jobStatus.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: "new", value: "new", label: "New" } as never,
      ]);
      const result = await getStatusList();
      expect(prisma.jobStatus.upsert).toHaveBeenCalledWith({ where: { value: "new" }, update: {}, create: { label: "New", value: "new" } });
      expect(result[0].value).toBe("new");
    });

    it("should throw error on failure", async () => {
      const mockErrorResponse = {
        success: false,
        message: "Failed to fetch status list.",
      };
      (prisma.jobStatus.findMany as any).mockRejectedValue(
        new Error("Failed to fetch status list."),
      );

      await expect(getStatusList()).resolves.toStrictEqual(mockErrorResponse);
    });
  });
  describe("getJobSourceList", () => {
    it("should return job source list on successful query", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const mockData = [
        { id: "1", label: "Source 1", value: "source1" },
        { id: "2", label: "Source 2", value: "source2" },
      ];
      (prisma.jobSource.findMany as any).mockResolvedValue(mockData);

      const result = await getJobSourceList();

      expect(result).toEqual(mockData);
      expect(prisma.jobSource.findMany).toHaveBeenCalled();
      expect(prisma.jobSource.upsert).toHaveBeenCalled();
    });

    it("should returns failure response on error", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findMany as any).mockRejectedValue(
        new Error("Failed to fetch job source list."),
      );

      const result = await getJobSourceList();

      expect(result).toEqual({
        success: false,
        message: "Failed to fetch job source list.",
      });

      expect(prisma.jobSource.findMany).toHaveBeenCalled();
    });
  });

  describe("getJobsList", () => {
    it("should retrieve jobs with default parameters", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const { data, total } = await getMockJobsList(1, 10);
      (prisma.job.findMany as any).mockResolvedValue(data);
      (prisma.job.count as any).mockResolvedValue(total);

      const result = await getJobsList();

      expect(result).toEqual({
        success: true,
        data,
        total,
        timeZone: expect.any(String),
      });
      expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.job.count).toHaveBeenCalledTimes(1);
    });
    it("should hide the pre-rank score of un-analyzed jobs and drop matchData", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.findMany as any).mockResolvedValue([
        {
          id: "unanalyzed",
          matchScore: 28,
          matchData: JSON.stringify({ prerankScore: 0.29, analyzed: false }),
        },
        {
          id: "analyzed",
          matchScore: 71,
          matchData: JSON.stringify({ matchScore: 71, body: "## Summary" }),
        },
        { id: "unmatched", matchScore: null, matchData: null },
      ]);
      (prisma.job.count as any).mockResolvedValue(3);

      const result = await getJobsList();

      expect(result.data).toStrictEqual([
        { id: "unanalyzed", matchScore: null },
        { id: "analyzed", matchScore: 71 },
        { id: "unmatched", matchScore: null },
      ]);
    });
    it("should return error when fetching data fails", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      (prisma.job.findMany as any).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await getJobsList();

      expect(result).toEqual({
        success: false,
        message: "Database error",
      });
    });
    it("should return error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getJobsList();

      expect(result).toEqual({
        success: false,
        message: "Not authenticated",
      });
    });

    describe("search functionality", () => {
      it("should build OR clause when search parameter is provided", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        const { data, total } = await getMockJobsList(1, 10);
        (prisma.job.findMany as any).mockResolvedValue(data);
        (prisma.job.count as any).mockResolvedValue(total);

        await getJobsList(1, 10, undefined, "Amazon");

        expect(prisma.job.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              userId: mockUser.id,
              OR: [
                { JobTitle: { label: { contains: "Amazon" } } },
                { Company: { label: { contains: "Amazon" } } },
                { Location: { label: { contains: "Amazon" } } },
                { JobSource: { label: { contains: "Amazon" } } },
                { description: { contains: "Amazon" } },
              ],
            }),
          }),
        );
        expect(prisma.job.count).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              OR: [
                { JobTitle: { label: { contains: "Amazon" } } },
                { Company: { label: { contains: "Amazon" } } },
                { Location: { label: { contains: "Amazon" } } },
                { JobSource: { label: { contains: "Amazon" } } },
                { description: { contains: "Amazon" } },
              ],
            }),
          }),
        );
      });

      it("should search across job title", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "Developer");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          JobTitle: { label: { contains: "Developer" } },
        });
      });

      it("should search across company name", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "Google");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          Company: { label: { contains: "Google" } },
        });
      });

      it("should search across location", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "Remote");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          Location: { label: { contains: "Remote" } },
        });
      });

      it("should search across job source", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "LinkedIn");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          JobSource: { label: { contains: "LinkedIn" } },
        });
      });

      it("should exclude JobSource from search OR when sourceValue is set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          "LinkedIn",
          undefined,
          undefined,
          undefined,
          undefined,
          "linkedin",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).not.toContainEqual({
          JobSource: { label: { contains: "LinkedIn" } },
        });
      });

      it("should search across description", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "React");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          description: { contains: "React" },
        });
      });

      it("should treat the applied filter as ever-applied (flag), not the applied stage", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, "applied", "Developer");

        // "Applied" is a history filter: an interview/rejected/offer job that
        // was applied must still match, so the where clause uses the flag, not
        // Status.value === "applied".
        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.applied).toBe(true);
        expect(findManyCall.where.Status).toBeUndefined();
        expect(findManyCall.where.OR).toEqual(expect.any(Array));
      });

      it("should not include OR clause when search is undefined", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, undefined);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toBeUndefined();
      });

      it("should not include OR clause when search is empty string", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toBeUndefined();
      });

      it("should return filtered results with correct pagination", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        const mockFilteredData = [
          {
            id: "1",
            JobTitle: { label: "Full Stack Developer" },
            Company: { label: "Amazon" },
          },
        ];
        (prisma.job.findMany as any).mockResolvedValue(mockFilteredData);
        (prisma.job.count as any).mockResolvedValue(1);

        const result = await getJobsList(1, 10, undefined, "Amazon");

        expect(result).toEqual({
          success: true,
          data: mockFilteredData,
          total: 1,
          timeZone: expect.any(String),
        });
      });

      it("should combine job type filter with search", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, "PT", "Developer");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          jobType: "PT",
          OR: expect.any(Array),
        });
      });
    });

    describe("company filter", () => {
      it("should filter by company value when companyValue is provided", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, undefined, "google");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          Company: { value: "google" },
        });
      });

      it("should filter by applied when appliedOnly is true", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, undefined, "google", true);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          Company: { value: "google" },
          applied: true,
        });
      });

      it("should exclude Company from search OR when companyValue is set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "Developer", "google");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toEqual([
          { JobTitle: { label: { contains: "Developer" } } },
          { Location: { label: { contains: "Developer" } } },
          { JobSource: { label: { contains: "Developer" } } },
          { description: { contains: "Developer" } },
        ]);
        expect(findManyCall.where.OR).not.toContainEqual({
          Company: { label: { contains: "Developer" } },
        });
      });

      it("should include Company in search OR when companyValue is not set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "Developer");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          Company: { label: { contains: "Developer" } },
        });
      });

      it("should combine company filter with the ever-applied filter", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, "applied", undefined, "google", true);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          Company: { value: "google" },
          applied: true,
        });
        // "applied" filter means ever-applied — not a Status.value match.
        expect(findManyCall.where.Status).toBeUndefined();
      });

      it("should not add Company or applied when params are undefined", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.Company).toBeUndefined();
        expect(findManyCall.where.applied).toBeUndefined();
      });
    });

    describe("title filter", () => {
      it("should filter by title value when titleValue is provided", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          undefined,
          "full stack developer",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          JobTitle: { value: "full stack developer" },
        });
      });

      it("should combine title filter with applied filter", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          true,
          "full stack developer",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          JobTitle: { value: "full stack developer" },
          applied: true,
        });
      });

      it("should exclude JobTitle from search OR when titleValue is set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          "React",
          undefined,
          undefined,
          "full stack developer",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).not.toContainEqual({
          JobTitle: { label: { contains: "React" } },
        });
      });

      it("should include JobTitle in search OR when titleValue is not set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "React");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          JobTitle: { label: { contains: "React" } },
        });
      });

      it("should not add JobTitle when titleValue is undefined", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.JobTitle).toBeUndefined();
      });
    });

    describe("location filter", () => {
      it("should filter by location value when locationValue is provided", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "remote",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          Location: { value: "remote" },
        });
      });

      it("should combine location filter with applied filter", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          "remote",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          Location: { value: "remote" },
          applied: true,
        });
      });

      it("should exclude Location from search OR when locationValue is set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          "React",
          undefined,
          undefined,
          undefined,
          "remote",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).not.toContainEqual({
          Location: { label: { contains: "React" } },
        });
      });

      it("should include Location in search OR when locationValue is not set", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10, undefined, "React");

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.OR).toContainEqual({
          Location: { label: { contains: "React" } },
        });
      });

      it("should not add Location when locationValue is undefined", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.Location).toBeUndefined();
      });
    });

    describe("source filter", () => {
      it("should filter by source value when sourceValue is provided", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "indeed",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          JobSource: { value: "indeed" },
        });
      });

      it("should combine source filter with applied filter", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(
          1,
          10,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          "indeed",
        );

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          userId: mockUser.id,
          JobSource: { value: "indeed" },
          applied: true,
        });
      });

      it("should not add JobSource when sourceValue is undefined", async () => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.findMany as any).mockResolvedValue([]);
        (prisma.job.count as any).mockResolvedValue(0);

        await getJobsList(1, 10);

        const findManyCall = (prisma.job.findMany as any).mock.calls[0][0];
        expect(findManyCall.where.JobSource).toBeUndefined();
      });
    });
  });
  describe("getJobDetails", () => {
    it("should throw error when jobId is not provided", async () => {
      await expect(getJobDetails("")).resolves.toStrictEqual({
        success: false,
        message: "Please provide job id",
      });
    });
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(getJobDetails("job123")).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
  });
  it("should return job details on successful query", async () => {
    (getCurrentUser as any).mockResolvedValue(mockUser);
    const mockJob = await getMockJobDetails("2");
    (prisma.job.findUnique as any).mockResolvedValue(mockJob);

    const result = await getJobDetails("2");

    expect(result).toStrictEqual({
      job: mockJob,
      success: true,
      timeZone: expect.any(String),
    });
    expect(prisma.job.findUnique).toHaveBeenCalledWith({
      where: {
        id: "2",
        userId: "user-id",
      },
      include: {
        JobSource: true,
        JobTitle: true,
        Company: true,
        CoverLetter: true,
        Status: true,
        Location: true,
        Resume: {
          include: {
            File: true,
          },
        },
        tags: true,
        contactLinks: {
          include: {
            Role: true,
            Contact: {
              select: {
                id: true,
                name: true,
                title: true,
                email: true,
                phone: true,
                linkedinUrl: true,
                Company: { select: { id: true, label: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  });

  it("should handle unexpected errors", async () => {
    (getCurrentUser as any).mockResolvedValue({ id: "user123" });

    (prisma.job.findUnique as any).mockRejectedValue(
      new Error("Unexpected error"),
    );

    await expect(getJobDetails("job123")).resolves.toStrictEqual({
      success: false,
      message: "Unexpected error",
    });
  });
  it("should throw error when user is not authenticated", async () => {
    (getCurrentUser as any).mockResolvedValue(null);

    await expect(getJobDetails("job123")).resolves.toStrictEqual({
      success: false,
      message: "Not authenticated",
    });
  });
  describe("createLocation", () => {
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(createLocation("location-name")).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
    it("should throw error when location name is not provided or empty", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      await expect(createLocation(" ")).resolves.toStrictEqual({
        success: false,
        message: "Please provide location name",
      });
    });
    it("should create with valid input", async () => {
      const label = "New Location";
      const mockLocation = {
        label: "New Location",
        value: "new location",
        createdBy: mockUser.id,
      };
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(null);
      (prisma.location.create as any).mockResolvedValue(mockLocation);

      const result = await createLocation(label);

      expect(prisma.location.create).toHaveBeenCalledTimes(1);
      expect(prisma.location.create).toHaveBeenCalledWith({
        data: mockLocation,
      });
      expect(result).toStrictEqual({
        data: {
          ...mockLocation,
        },
        success: true,
      });
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(null);
      (prisma.location.create as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(createLocation("location-name")).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
    it("should canonicalize the value (not just lowercase) for matching", async () => {
      // Regression guard: value computation was switched from
      // label.trim().toLowerCase() to canonicalizeEntityValue(), which also
      // folds diacritics and comma separators. A plain-ASCII label wouldn't
      // catch a revert to the old behavior.
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.location.findFirst as any).mockResolvedValue(null);
      (prisma.location.create as any).mockImplementation(({ data }: any) =>
        Promise.resolve(data),
      );

      const result = await createLocation("São Paulo, Brazil");

      expect(prisma.location.findFirst).toHaveBeenCalledWith({
        where: { value: "sao paulo brazil", createdBy: mockUser.id },
      });
      expect(result.data.value).toBe("sao paulo brazil");
    });
  });
  describe("createJobSource", () => {
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(createJobSource("source-name")).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
    it("should throw error when job source name is not provided or empty", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      await expect(createJobSource(" ")).resolves.toStrictEqual({
        success: false,
        message: "Please provide job source name",
      });
    });
    it("should create with valid input", async () => {
      const label = "New Source";
      const mockJobSource = {
        label: "New Source",
        value: "new source",
        createdBy: mockUser.id,
      };
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findFirst as any).mockResolvedValue(null);
      (prisma.jobSource.create as any).mockResolvedValue(mockJobSource);

      const result = await createJobSource(label);

      expect(prisma.jobSource.create).toHaveBeenCalledTimes(1);
      expect(prisma.jobSource.create).toHaveBeenCalledWith({
        data: mockJobSource,
      });
      expect(result).toStrictEqual({
        data: mockJobSource,
        success: true,
      });
    });
    it("should reuse an existing job source instead of creating a duplicate", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const existing = { label: "Indeed", value: "indeed", createdBy: mockUser.id };
      (prisma.jobSource.findFirst as any).mockResolvedValue(existing);

      const result = await createJobSource("Indeed");

      expect(prisma.jobSource.create).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ data: existing, success: true });
    });
    it("maps a Chinese default channel name onto the seeded source value", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const existing = {
        label: "Shixiseng",
        value: "shixiseng",
        createdBy: mockUser.id,
      };
      (prisma.jobSource.findFirst as any).mockResolvedValue(existing);

      const result = await createJobSource("实习僧");

      expect(prisma.jobSource.findFirst).toHaveBeenCalledWith({
        where: { value: "shixiseng", createdBy: mockUser.id },
      });
      expect(prisma.jobSource.create).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ data: existing, success: true });
    });
    it("creates a custom source with the trimmed user label", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findFirst as any).mockResolvedValue(null);
      (prisma.jobSource.create as any).mockImplementation(({ data }: any) =>
        Promise.resolve(data),
      );

      const result = await createJobSource("  学校就业群  ");

      expect(prisma.jobSource.create).toHaveBeenCalledWith({
        data: {
          label: "学校就业群",
          value: "学校就业群",
          createdBy: mockUser.id,
        },
      });
      expect(result.success).toBe(true);
    });
    it("rejects a job source name that is too long", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const result = await createJobSource("x".repeat(81));
      expect(result).toStrictEqual({
        success: false,
        message: "Job source name is too long",
      });
      expect(prisma.jobSource.create).not.toHaveBeenCalled();
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobSource.findFirst as any).mockResolvedValue(null);
      (prisma.jobSource.create as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(createJobSource("source-name")).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
  });
  describe("addJob", () => {
    it("should create a new job successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      const result = await addJob(jobData);

      expect(result).toStrictEqual({ data: jobData, success: true });
      expect(prisma.job.create).toHaveBeenCalledTimes(1);
      expect(prisma.job.create).toHaveBeenCalledWith({
        data: {
          jobTitleId: jobData.title,
          companyId: jobData.company,
          locationId: jobData.location,
          statusId: jobData.status,
          jobSourceId: jobData.source,
          salaryRange: jobData.salaryRange,
          createdAt: jobData.createdAt,
          dueDate: jobData.dueDate,
          appliedDate: jobData.dateApplied,
          description: jobData.jobDescription,
          jobType: jobData.type,
          userId: mockUser.id,
          jobUrl: jobData.jobUrl,
          applied: jobData.applied,
          resumeId: null,
        },
      });
    });
    it("should handle undefined values for optional fields", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      const result = await addJob({
        ...jobData,
        jobUrl: undefined,
        dateApplied: undefined,
      });

      expect(prisma.job.create).toHaveBeenCalledTimes(1);
      expect(prisma.job.create).toHaveBeenCalledWith({
        data: {
          jobTitleId: jobData.title,
          companyId: jobData.company,
          locationId: jobData.location,
          statusId: jobData.status,
          jobSourceId: jobData.source,
          salaryRange: jobData.salaryRange,
          createdAt: jobData.createdAt,
          dueDate: jobData.dueDate,
          // applied=true without an explicit date stamps the first
          // application timestamp at save time.
          appliedDate: expect.any(Date),
          description: jobData.jobDescription,
          jobType: jobData.type,
          userId: mockUser.id,
          applied: jobData.applied,
          resumeId: null,
        },
      });
      expect(result).toEqual({ data: jobData, success: true });
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      (prisma.job.create as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(addJob(jobData)).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(addJob(jobData)).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
    it("counts each referenced id against the caller", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      await addJob({
        ...jobData,
        resume: "resume-id",
        coverLetter: "letter-id",
        tags: ["tag-1", "tag-1"],
      });

      const db = prisma as any;
      const owned = { createdBy: mockUser.id };
      const inProfile = { profile: { userId: mockUser.id } };
      expect(db.jobTitle.count).toHaveBeenCalledWith({
        where: { id: "job-title-id", ...owned },
      });
      expect(db.company.count).toHaveBeenCalledWith({
        where: { id: "company-id", ...owned },
      });
      expect(db.location.count).toHaveBeenCalledWith({
        where: { id: "location-id", ...owned },
      });
      expect(db.jobSource.count).toHaveBeenCalledWith({
        where: { id: "source-id", ...owned },
      });
      expect(db.resume.count).toHaveBeenCalledWith({
        where: { id: "resume-id", ...inProfile },
      });
      expect(db.coverLetter.count).toHaveBeenCalledWith({
        where: { id: "letter-id", ...inProfile },
      });
      expect(db.tag.count).toHaveBeenCalledWith({
        where: { id: { in: ["tag-1"] }, ...owned },
      });
      expect(prisma.job.create).toHaveBeenCalledTimes(1);
    });
    it.each([
      ["company", {}, "Company not found"],
      ["resume", { resume: "resume-id" }, "Resume not found"],
      ["coverLetter", { coverLetter: "letter-id" }, "Cover letter not found"],
    ])("rejects another user's %s", async (model, overrides, message) => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma as any)[model].count.mockResolvedValue(0);

      const result = await addJob({ ...jobData, ...overrides });

      expect(result).toStrictEqual({ success: false, message });
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
    it("rejects a tag list that includes another user's tag", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      const result = await addJob({ ...jobData, tags: ["tag-1", "tag-2"] });

      expect(result).toStrictEqual({ success: false, message: "Tag not found" });
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
    it("skips the check for a resume that was not picked", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      await addJob(jobData);

      expect((prisma as any).resume.count).not.toHaveBeenCalled();
      expect((prisma as any).tag.count).not.toHaveBeenCalled();
    });
    it("normalizes empty optional foreign keys on create", async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(mockUser as never);
      vi.mocked(prisma.job.create).mockResolvedValue(jobData as never);
      await addJob({ ...jobData, location: " ", source: "", resume: "", coverLetter: " " });
      expect(prisma.job.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        locationId: null, jobSourceId: null, resumeId: null, coverLetterId: null,
      }) }));
    });

    it("persists an internship job type", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      await addJob({ ...jobData, type: "INTERNSHIP" });

      expect(prisma.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobType: "INTERNSHIP" }),
        }),
      );
    });
    it("stores free-text salary exactly", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.create as any).mockResolvedValue(jobData);

      await addJob({ ...jobData, salaryRange: "200-250元/天" });

      expect(prisma.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ salaryRange: "200-250元/天" }),
        }),
      );
    });
    it("rejects a missing job status before create", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.jobStatus.findUnique as any).mockResolvedValue(null);

      const result = await addJob(jobData);

      expect(result).toStrictEqual({
        success: false,
        message: "Job status not found",
      });
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
    it("does not treat a non-user foreign-key failure as an invalid session", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const fkError = Object.assign(new Error("Foreign key constraint failed"), {
        code: "P2003",
        meta: { field_name: "Job_statusId_fkey" },
      });
      (prisma.job.create as any).mockRejectedValue(fkError);

      const result = await addJob(jobData);

      expect(result.success).toBe(false);
      expect(result.message).not.toMatch(/session appears invalid|当前会话无效/i);
      expect(result.message).not.toMatch(/P2003|fkey|constraint/i);
    });
    it("keeps a user-row foreign-key failure as a session message", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const fkError = Object.assign(new Error("Foreign key constraint failed"), {
        code: "P2003",
        meta: { field_name: "Job_userId_fkey" },
      });
      (prisma.job.create as any).mockRejectedValue(fkError);

      const result = await addJob(jobData);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/session|会话/i);
      expect(result.message).not.toMatch(/P2003|fkey|constraint/i);
    });
  });
  describe("updateJob", () => {
    const currentRefs = {
      jobTitleId: "job-title-id",
      companyId: "company-id",
      locationId: "location-id",
      jobSourceId: "source-id",
      resumeId: null,
      coverLetterId: null,
      applied: false,
      appliedDate: null as Date | null,
      tags: [{ id: "tag-1" }],
    };
    beforeEach(() => {
      (prisma.job as any).findFirst.mockResolvedValue(currentRefs);
    });
    it("clears optional foreign keys with empty values on update", async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(mockUser as never);
      vi.mocked(prisma.job.update).mockResolvedValue(jobData as never);
      await updateJob({ ...jobData, location: " ", source: "", resume: "", coverLetter: " " });
      expect(prisma.job.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        locationId: null, jobSourceId: null, resumeId: null, coverLetterId: null,
      }) }));
    });

    it("does not re-check ids the job already holds", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma as any).jobSource.count.mockResolvedValue(0);
      (prisma.job.update as any).mockResolvedValue(jobData);

      const result = await updateJob({ ...jobData, tags: ["tag-1"] });

      expect(result.success).toBe(true);
      expect((prisma.job as any).findFirst.mock.calls[0][0].where).toEqual({
        id: "job-id",
        userId: mockUser.id,
      });
      expect((prisma as any).jobSource.count).not.toHaveBeenCalled();
      expect((prisma as any).company.count).not.toHaveBeenCalled();
      expect((prisma as any).tag.count).not.toHaveBeenCalled();
    });
    it("rejects a newly attached company the caller does not own", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma as any).company.count.mockResolvedValue(0);

      const result = await updateJob({ ...jobData, company: "other-company" });

      expect(result).toStrictEqual({
        success: false,
        message: "Company not found",
      });
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
    it.each([
      ["resume", { resume: "resume-id" }, "Resume not found"],
      ["coverLetter", { coverLetter: "letter-id" }, "Cover letter not found"],
    ])("rejects another user's %s", async (model, overrides, message) => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma as any)[model].count.mockResolvedValue(0);

      const result = await updateJob({ ...jobData, ...overrides });

      expect(result).toStrictEqual({ success: false, message });
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
    it("checks only the tags being added", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma as any).tag.count.mockResolvedValue(0);

      const result = await updateJob({ ...jobData, tags: ["tag-1", "tag-2"] });

      expect((prisma as any).tag.count).toHaveBeenCalledWith({
        where: { id: { in: ["tag-2"] }, createdBy: mockUser.id },
      });
      expect(result).toStrictEqual({ success: false, message: "Tag not found" });
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
    it("reports a job the caller does not own", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job as any).findFirst.mockResolvedValue(null);

      const result = await updateJob(jobData);

      expect(result).toStrictEqual({ success: false, message: "Job not found" });
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
    it("should update a job successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);

      const result = await updateJob(jobData);

      expect(result).toStrictEqual({ data: jobData, success: true });
      expect(prisma.job.update).toHaveBeenCalledTimes(1);
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      (prisma.job.update as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(updateJob(jobData)).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(updateJob(jobData)).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });

    it("should return an error if the id is not provided or no user privileges", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      await expect(
        updateJob({ ...jobData, id: undefined }),
      ).resolves.toStrictEqual({
        success: false,
        message: "Job id is required",
      });
    });

    it("never writes createdAt on update", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);

      await updateJob(jobData);

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.createdAt).toBeUndefined();
    });

    it("keeps applied=true even when the edit payload sends applied=false", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const firstAppliedAt = new Date("2024-01-15T10:00:00.000Z");
      (prisma.job.findFirst as any).mockResolvedValue({
        ...currentRefs,
        applied: true,
        appliedDate: firstAppliedAt,
      });
      (prisma.job.update as any).mockResolvedValue(jobData);

      // `applied` is an irreversible historical fact: an ordinary edit cannot
      // turn it back to false.
      await updateJob({ ...jobData, applied: false, dateApplied: undefined });

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.applied).toBe(true);
      expect(updateData.appliedDate).toBe(firstAppliedAt);
    });

    it("preserves the first appliedDate instead of rewriting it on later edits", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const firstAppliedAt = new Date("2024-01-15T10:00:00.000Z");
      (prisma.job.findFirst as any).mockResolvedValue({
        ...currentRefs,
        applied: true,
        appliedDate: firstAppliedAt,
      });
      (prisma.job.update as any).mockResolvedValue(jobData);

      // The form sends a new dateApplied (e.g. today) — the stored first
      // application timestamp must win.
      await updateJob({ ...jobData, applied: true, dateApplied: new Date() });

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.appliedDate).toBe(firstAppliedAt);
    });

    it("backfills appliedDate when an already-applied job has none", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.findFirst as any).mockResolvedValue({
        ...currentRefs,
        applied: true,
        appliedDate: null,
      });
      (prisma.job.update as any).mockResolvedValue(jobData);

      const formDate = new Date("2024-02-01");
      await updateJob({ ...jobData, applied: true, dateApplied: formDate });

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.applied).toBe(true);
      expect(updateData.appliedDate).toBe(formDate);
    });

    it("sets appliedDate once when a not-applied job is first marked applied", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);

      await updateJob({ ...jobData, applied: true, dateApplied: undefined });

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.applied).toBe(true);
      expect(updateData.appliedDate).toEqual(expect.any(Date));
    });

    it("clears appliedDate only while the job was never applied", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);

      await updateJob({ ...jobData, applied: false, dateApplied: undefined });

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.applied).toBe(false);
      expect(updateData.appliedDate).toBeNull();
    });
  });
  describe("updateJobStatus", () => {
    const jobData = {
      id: "job-id",
      title: "job-title-id",
      company: "company-id",
      location: "location-id",
      type: "FT",
      status: {
        id: "status-id",
        label: "Applied",
        value: "applied",
      },
      source: "source-id",
      salaryRange: "$50,000 - $70,000",
      createdAt: expect.any(Date),
      dueDate: new Date("2023-01-01"),
      dateApplied: new Date("2022-12-31"),
      jobDescription: "Job description",
      jobUrl: "https://example.com/job",
      applied: true,
      userId: mockUser.id,
    };
    it("should update a job status successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);

      const result = await updateJobStatus(jobData.id, jobData.status);

      expect(result).toStrictEqual({ job: jobData, success: true });
      expect(prisma.job.update).toHaveBeenCalledTimes(1);
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: {
          id: jobData.id,
          userId: mockUser.id,
        },
        data: {
          statusId: jobData.status.id,
          applied: true,
          appliedDate: expect.any(Date),
        },
      });
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      (prisma.job.update as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(
        updateJobStatus(jobData.id, jobData.status),
      ).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
    it("should throw error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(
        updateJobStatus(jobData.id, jobData.status),
      ).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
    it("should set applied without appliedDate for interview in LEGACY_ONLY", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue(jobData);
      const interviewStatus = {
        id: "interview-status-id",
        label: "Interview",
        value: "interview",
      };

      const result = await updateJobStatus(jobData.id, interviewStatus);

      expect(result).toStrictEqual({ job: jobData, success: true });
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: {
          id: jobData.id,
          userId: mockUser.id,
        },
        data: {
          statusId: interviewStatus.id,
          applied: true,
        },
      });
    });
    it("preserves the first appliedDate when re-selecting the applied stage", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      const firstAppliedAt = new Date("2024-01-15T10:00:00.000Z");
      (prisma.job.findFirst as any).mockResolvedValue({
        appliedDate: firstAppliedAt,
      });
      (prisma.job.update as any).mockResolvedValue(jobData);

      await updateJobStatus(jobData.id, jobData.status); // status.value = "applied"

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: {
          id: jobData.id,
          userId: mockUser.id,
        },
        data: {
          statusId: jobData.status.id,
          applied: true,
          appliedDate: firstAppliedAt,
        },
      });
    });
    it("only stamps appliedDate when none exists yet", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.findFirst as any).mockResolvedValue({ appliedDate: null });
      (prisma.job.update as any).mockResolvedValue(jobData);

      await updateJobStatus(jobData.id, jobData.status);

      const updateData = (prisma.job.update as any).mock.calls[0][0].data;
      expect(updateData.applied).toBe(true);
      expect(updateData.appliedDate).toEqual(expect.any(Date));
    });
    it.each(["rejected", "offer", "offer-accepted", "offer-declined"])(
      "does not clear applied or appliedDate when moving to %s",
      async (statusValue) => {
        (getCurrentUser as any).mockResolvedValue(mockUser);
        (prisma.job.update as any).mockResolvedValue(jobData);
        const target = { id: "target-id", label: statusValue, value: statusValue };

        await updateJobStatus(jobData.id, target);

        // Moving between pipeline stages only changes the stage; the
        // application history flag and its first timestamp are untouched.
        const updateData = (prisma.job.update as any).mock.calls[0][0].data;
        expect(updateData).toStrictEqual({ statusId: target.id });
      },
    );
  });
  describe("deleteJobById", () => {
    it("should return error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      await expect(deleteJobById("job-id")).resolves.toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
    });
    it("should delete a job successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.delete as any).mockResolvedValue(jobData);

      const result = await deleteJobById("job-id");

      expect(result).toStrictEqual({ res: jobData, success: true });
      expect(prisma.job.delete).toHaveBeenCalledTimes(1);
      expect(prisma.job.delete).toHaveBeenCalledWith({
        where: {
          id: "job-id",
          userId: mockUser.id,
        },
      });
    });
    it("should handle unexpected errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);

      (prisma.job.delete as any).mockRejectedValue(
        new Error("Unexpected error"),
      );

      await expect(deleteJobById("job-id")).resolves.toStrictEqual({
        success: false,
        message: "Unexpected error",
      });
    });
  });
  describe("saveJobMatchResult", () => {
    it("should return error when user is not authenticated", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await saveJobMatchResult(
        "job-id",
        85,
        '{"summary":"test"}',
      );

      expect(result).toStrictEqual({
        success: false,
        message: "Not authenticated",
      });
      expect(prisma.job.update).not.toHaveBeenCalled();
    });

    it("should save match score and data successfully", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockResolvedValue({});

      const matchData = JSON.stringify({
        matchScore: 85,
        summary: "Good match",
        resumeId: "resume-1",
        resumeTitle: "My Resume",
        matchedAt: "2026-03-29T00:00:00.000Z",
      });

      const result = await saveJobMatchResult("job-id", 85, matchData);

      expect(result).toStrictEqual({ success: true });
      expect(prisma.job.update).toHaveBeenCalledTimes(1);
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: "job-id", userId: mockUser.id },
        data: { matchScore: 85, matchData },
      });
    });

    it("should handle database errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.job.update as any).mockRejectedValue(
        new Error("Record not found"),
      );

      const result = await saveJobMatchResult("job-id", 75, "{}");

      expect(result).toStrictEqual({
        success: false,
        message: "Record not found",
      });
    });
  });
});
