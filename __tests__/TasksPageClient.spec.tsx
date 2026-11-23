import TasksPageClient from "@/app/dashboard/tasks/TasksPageClient";
import { screen, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getActivityTypesWithTaskCounts,
  getTasksList,
} from "@/actions/task.actions";
import { useRouter, useSearchParams } from "next/navigation";

vi.mock("@/actions/task.actions", () => ({
  getTasksList: vi.fn(),
  getActivityTypesWithTaskCounts: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: vi.fn().mockReturnValue("/dashboard/tasks"),
  useSearchParams: vi.fn().mockReturnValue(new URLSearchParams()),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

document.createRange = () => {
  const range = new Range();

  range.getBoundingClientRect = vi.fn().mockReturnValue({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });

  range.getClientRects = () => {
    return {
      item: () => null,
      length: 0,
      [Symbol.iterator]: vi.fn(),
    };
  };

  return range;
};

describe("TasksPageClient Component", () => {
  const mockActivityTypes = [
    {
      id: "type-1",
      label: "Development",
      value: "development",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "type-2",
      label: "Testing",
      value: "testing",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const mockActivityTypesWithCounts = [
    {
      id: "type-1",
      label: "Development",
      value: "development",
      taskCount: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "type-2",
      label: "Testing",
      value: "testing",
      taskCount: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const user = userEvent.setup({ skipHover: true });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (getTasksList as any).mockResolvedValue({
      success: true,
      data: [],
      total: 0,
    });
    (getActivityTypesWithTaskCounts as any).mockResolvedValue({
      success: true,
      data: mockActivityTypesWithCounts,
      totalTasks: 8,
    });
    (useSearchParams as any).mockReturnValue(new URLSearchParams());
  });

  describe("Rendering", () => {
    it("should render the tag strip and TasksContainer components", () => {
      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      // Check if the in-card tag strip is rendered
      expect(screen.getByText("Categories")).toBeInTheDocument();
      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();

      // Check if container is rendered
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("should display total task count in the tag strip", () => {
      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      expect(screen.getByText("8")).toBeInTheDocument();
    });

    it("should display task counts for each activity type", () => {
      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      expect(screen.getByText("5")).toBeInTheDocument(); // Development count
      expect(screen.getByText("3")).toBeInTheDocument(); // Testing count
    });
  });

  describe("Filter Management", () => {
    it("should start with no filter selected", () => {
      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const allButton = screen.getByRole("button", { name: /All/i });
      expect(allButton).toHaveAttribute("aria-pressed", "true");
    });

    it("should update filter when activity type is clicked in the tag strip", async () => {
      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(developmentButton).toHaveAttribute("aria-pressed", "true");
      });
    });

    it("should reset filter when 'All' is clicked", async () => {
      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      // First click on a filter
      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(developmentButton).toHaveAttribute("aria-pressed", "true");
      });

      // Then click on All
      const allButton = screen.getByRole("button", { name: /All/i });
      await user.click(allButton);

      await waitFor(() => {
        expect(allButton).toHaveAttribute("aria-pressed", "true");
      });
    });

    it("should apply different filters sequentially", async () => {
      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(developmentButton).toHaveAttribute("aria-pressed", "true");
      });

      const testingButton = screen.getByRole("button", { name: /Testing/i });
      await user.click(testingButton);

      await waitFor(() => {
        expect(testingButton).toHaveAttribute("aria-pressed", "true");
      });
    });
  });

  describe("Empty States", () => {
    it("should handle empty activity types list", () => {
      render(
        <TasksPageClient
          activityTypes={[]}
          activityTypesWithCounts={[]}
          totalTasks={0}
        />,
      );

      expect(screen.getByText("Categories")).toBeInTheDocument();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("should show 0 total tasks when no tasks exist", () => {
      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts.map((type) => ({
            ...type,
            taskCount: 0,
          }))}
          totalTasks={0}
        />,
      );

      const zeroElements = screen.queryAllByText("0");
      expect(zeroElements.length).toBeGreaterThan(0);
    });
  });

  describe("Layout", () => {
    it("should render with correct layout structure", () => {
      const { container } = render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      // Check if main container has correct classes
      const mainContainer = container.querySelector(".col-span-3.h-full");
      expect(mainContainer).toBeInTheDocument();
    });

    it("should not render the category sidebar", () => {
      const { container } = render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const sidebar = container.querySelector(".w-48.border-r.py-4");
      expect(sidebar).not.toBeInTheDocument();
    });

    it("should render the tag strip inside the content card", () => {
      const { container } = render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const chips = container.querySelectorAll("[data-chip]");
      // "All" chip plus the two category chips.
      expect(chips.length).toBe(3);
    });
  });

  describe("Filter Synchronization", () => {
    it("should pass filter to TasksContainer", async () => {
      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      // Wait for the filter to be applied
      await waitFor(() => {
        expect(getTasksList).toHaveBeenCalledWith(
          1,
          25,
          "type-1",
          expect.any(Array),
          undefined,
          "none",
        );
      });
    });

    it("should clear filter when All is selected", async () => {
      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      // First select a filter
      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(getTasksList).toHaveBeenCalledWith(
          1,
          25,
          "type-1",
          expect.any(Array),
          undefined,
          "none",
        );
      });

      // Clear mock calls
      (getTasksList as any).mockClear();

      // Then click All
      const allButton = screen.getByRole("button", { name: /All/i });
      await user.click(allButton);

      await waitFor(() => {
        expect(getTasksList).toHaveBeenCalledWith(
          1,
          25,
          undefined,
          expect.any(Array),
          undefined,
          "none",
        );
      });
    });
  });

  describe("Multiple Activity Types", () => {
    it("should render many activity types correctly", () => {
      const manyActivityTypes = [
        {
          id: "1",
          label: "Development",
          value: "development",
          taskCount: 10,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "2",
          label: "Testing",
          value: "testing",
          taskCount: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "3",
          label: "Code Review",
          value: "code-review",
          taskCount: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "4",
          label: "Documentation",
          value: "documentation",
          taskCount: 2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "5",
          label: "Bug Fixing",
          value: "bug-fixing",
          taskCount: 7,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      render(
        <TasksPageClient
          activityTypes={manyActivityTypes}
          activityTypesWithCounts={manyActivityTypes}
          totalTasks={27}
        />,
      );

      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();
      expect(screen.getByText("Code Review")).toBeInTheDocument();
      expect(screen.getByText("Documentation")).toBeInTheDocument();
      expect(screen.getByText("Bug Fixing")).toBeInTheDocument();
      expect(screen.getByText("27")).toBeInTheDocument();
    });

    it("should handle switching between multiple filters", async () => {
      const manyActivityTypes = [
        {
          id: "1",
          label: "Development",
          value: "development",
          taskCount: 10,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "2",
          label: "Testing",
          value: "testing",
          taskCount: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "3",
          label: "Code Review",
          value: "code-review",
          taskCount: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (getTasksList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });
      (getActivityTypesWithTaskCounts as any).mockResolvedValue({
        success: true,
        data: manyActivityTypes,
        totalTasks: 18,
      });

      render(
        <TasksPageClient
          activityTypes={manyActivityTypes}
          activityTypesWithCounts={manyActivityTypes}
          totalTasks={18}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(developmentButton).toHaveAttribute("aria-pressed", "true");
      });

      const testingButton = screen.getByRole("button", { name: /Testing/i });
      await user.click(testingButton);

      await waitFor(() => {
        expect(testingButton).toHaveAttribute("aria-pressed", "true");
      });

      const codeReviewButton = screen.getByRole("button", {
        name: /Code Review/i,
      });
      await user.click(codeReviewButton);

      await waitFor(() => {
        expect(codeReviewButton).toHaveAttribute("aria-pressed", "true");
      });
    });
  });

  describe("URL Persistence", () => {
    it("should initialize the selected filter from the activityType URL param", () => {
      (useSearchParams as any).mockReturnValue(
        new URLSearchParams("activityType=type-1"),
      );

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      expect(developmentButton).toHaveAttribute("aria-pressed", "true");
    });

    it("should write the selected activity type to the URL", async () => {
      const routerMock = (useRouter as any)();

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const developmentButton = screen.getByRole("button", {
        name: /Development/i,
      });
      await user.click(developmentButton);

      await waitFor(() => {
        expect(routerMock.replace).toHaveBeenCalledWith(
          "/dashboard/tasks?activityType=type-1",
          { scroll: false },
        );
      });
    });

    it("should remove the activityType param from the URL when All is clicked", async () => {
      (useSearchParams as any).mockReturnValue(
        new URLSearchParams("activityType=type-1"),
      );
      const routerMock = (useRouter as any)();

      render(
        <TasksPageClient
          activityTypes={mockActivityTypes}
          activityTypesWithCounts={mockActivityTypesWithCounts}
          totalTasks={8}
        />,
      );

      const allButton = screen.getByRole("button", { name: /All/i });
      await user.click(allButton);

      await waitFor(() => {
        expect(routerMock.replace).toHaveBeenCalledWith("/dashboard/tasks", {
          scroll: false,
        });
      });
    });
  });
});
