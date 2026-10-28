import {
  getActivityTypeList,
  updateActivityType,
  deleteActivityTypeById,
} from "@/actions/activity.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    activityType: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    task: {
      count: vi.fn(),
    },
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

describe("Activity Type Actions", () => {
  const mockUser = { id: "user-id" };

  const mockActivityTypes = [
    {
      id: "at-1",
      label: "Learning",
      value: "learning",
      _count: { Tasks: 2 },
    },
    {
      id: "at-2",
      label: "Job Search",
      value: "job-search",
      _count: { Tasks: 5 },
    },
    {
      id: "at-3",
      label: "Networking",
      value: "networking",
      _count: { Tasks: 0 },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getActivityTypeList", () => {
    it("should return paginated activity types sorted by task count", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.count as any).mockResolvedValue(3);
      (prisma.activityType.findMany as any).mockResolvedValue(
        mockActivityTypes,
      );

      const result = await getActivityTypeList(1, 10);

      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(3);
      expect(result.data[0].id).toBe("at-2");
      expect(result.data[0]._count.Tasks).toBe(5);
      expect(result.data[1].id).toBe("at-1");
      expect(result.data[2].id).toBe("at-3");
      expect(prisma.activityType.findMany).toHaveBeenCalledWith({
        where: { createdBy: mockUser.id },
        select: {
          id: true,
          label: true,
          value: true,
          _count: { select: { Tasks: true } },
        },
      });
    });

    it("should handle pagination correctly for page 2", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.count as any).mockResolvedValue(3);
      (prisma.activityType.findMany as any).mockResolvedValue(
        mockActivityTypes,
      );

      const result = await getActivityTypeList(2, 2);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("at-3");
    });

    it("should return empty data when page exceeds total", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.count as any).mockResolvedValue(3);
      (prisma.activityType.findMany as any).mockResolvedValue(
        mockActivityTypes,
      );

      const result = await getActivityTypeList(5, 10);

      expect(result.data).toHaveLength(0);
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await getActivityTypeList(1, 10);

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.activityType.findMany).not.toHaveBeenCalled();
    });

    it("should handle database errors", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.count as any).mockRejectedValue(
        new Error("DB error"),
      );

      const result = await getActivityTypeList(1, 10);

      expect(result).toEqual({ success: false, message: "DB error" });
    });
  });

  describe("updateActivityType", () => {
    const existing = {
      id: "at-1",
      label: "Learning",
      value: "learning",
      createdBy: "user-id",
    };

    it("should rename the label and keep the trim-lowercase key rule", async () => {
      // The create path keys rows with label.trim().toLowerCase() (not the
      // shared canonicalizer), so the update must keep that same rule.
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.findFirst as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      const updated = { ...existing, label: "Deep Work", value: "deep work" };
      (prisma.activityType.update as any).mockResolvedValue(updated);

      const result = await updateActivityType("at-1", " Deep Work ");

      expect(result).toEqual({ success: true, data: updated });
      expect(prisma.activityType.findFirst).toHaveBeenNthCalledWith(2, {
        where: { value: "deep work", createdBy: mockUser.id },
      });
      expect(prisma.activityType.update).toHaveBeenCalledWith({
        where: { id: "at-1", createdBy: mockUser.id },
        data: { label: "Deep Work", value: "deep work" },
      });
    });

    it("should keep the stored value when the label is unchanged", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.findFirst as any).mockResolvedValue(existing);
      (prisma.activityType.update as any).mockResolvedValue(existing);

      const result = await updateActivityType("at-1", "Learning");

      expect(result.success).toBe(true);
      expect(prisma.activityType.findFirst).toHaveBeenCalledTimes(1);
    });

    it("should reject a rename that collides with another row's value", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.findFirst as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ id: "at-2", value: "networking" });

      const result = await updateActivityType("at-1", "Networking");

      expect(result).toEqual({
        success: false,
        message: "Activity type already exists!",
      });
      expect(prisma.activityType.update).not.toHaveBeenCalled();
    });

    it("should return error when the row does not belong to the user", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.findFirst as any).mockResolvedValue(null);

      const result = await updateActivityType("at-1", "Networking");

      expect(result).toEqual({
        success: false,
        message: "Activity type not found",
      });
      expect(prisma.activityType.update).not.toHaveBeenCalled();
    });

    it("should return error for an empty label", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.activityType.findFirst as any).mockResolvedValue(existing);

      const result = await updateActivityType("at-1", "   ");

      expect(result).toEqual({
        success: false,
        message: "Activity type label cannot be empty.",
      });
      expect(prisma.activityType.update).not.toHaveBeenCalled();
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await updateActivityType("at-1", "Networking");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.activityType.update).not.toHaveBeenCalled();
    });
  });

  describe("deleteActivityTypeById", () => {
    it("should delete an activity type with no linked records", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.task.count as any).mockResolvedValue(0);
      const mockDeleted = {
        id: "at-3",
        label: "Networking",
        value: "networking",
      };
      (prisma.activityType.delete as any).mockResolvedValue(mockDeleted);

      const result = await deleteActivityTypeById("at-3");

      expect(result).toEqual({ res: mockDeleted, success: true });
      expect(prisma.activityType.delete).toHaveBeenCalledWith({
        where: { id: "at-3", createdBy: mockUser.id },
      });
    });

    it("should return error when linked to tasks", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.task.count as any).mockResolvedValue(3);

      const result = await deleteActivityTypeById("at-1");

      expect(result).toEqual({
        success: false,
        message:
          "Activity type cannot be deleted because it is linked to 3 task(s).",
      });
      expect(prisma.activityType.delete).not.toHaveBeenCalled();
    });

    it("should return error for unauthenticated user", async () => {
      (getCurrentUser as any).mockResolvedValue(null);

      const result = await deleteActivityTypeById("at-1");

      expect(result).toEqual({ success: false, message: "Not authenticated" });
      expect(prisma.task.count).not.toHaveBeenCalled();
      expect(prisma.activityType.delete).not.toHaveBeenCalled();
    });

    it("should handle database errors during deletion", async () => {
      (getCurrentUser as any).mockResolvedValue(mockUser);
      (prisma.task.count as any).mockResolvedValue(0);
      (prisma.activityType.delete as any).mockRejectedValue(
        new Error("DB error"),
      );

      const result = await deleteActivityTypeById("at-1");

      expect(result).toEqual({ success: false, message: "DB error" });
    });
  });
});
