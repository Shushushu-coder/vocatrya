import TagsContainer from "@/components/admin/TagsContainer";
import { screen, render, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getTagList, deleteTagById, updateTag } from "@/actions/tag.actions";

vi.mock("@/actions/tag.actions", () => ({
  getTagList: vi.fn(),
  deleteTagById: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
}));

let intersectionCallback: IntersectionObserverCallback | undefined;
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

describe("TagsContainer Search Functionality", () => {
  const mockTags = [
    {
      id: "1",
      label: "React",
      value: "react",
      createdBy: "user-1",
      _count: { jobs: 1, questions: 0, skills: 0 },
    },
    {
      id: "2",
      label: "Python",
      value: "python",
      createdBy: "user-1",
      _count: { jobs: 0, questions: 1, skills: 0 },
    },
  ];

  const user = userEvent.setup({ delay: null });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intersectionCallback = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Search Input", () => {
    it("should render search input with placeholder", async () => {
      (getTagList as any).mockResolvedValue({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search skills..."),
        ).toBeInTheDocument();
      });
    });

    it("should debounce search input for 300ms", async () => {
      (getTagList as any).mockResolvedValue({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");

      await act(async () => {
        await user.type(searchInput, "P");
      });

      expect(getTagList).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledTimes(2);
      });
    });

    it("should call getTagList with search term after debounce", async () => {
      (getTagList as any).mockResolvedValue({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");

      await act(async () => {
        await user.type(searchInput, "Python");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledWith(1, 25, "Python");
      });
    });

    it("should not trigger search on initial mount with empty search", async () => {
      (getTagList as any).mockResolvedValue({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(getTagList).toHaveBeenCalledTimes(1);
      expect(getTagList).toHaveBeenCalledWith(1, 25, undefined);
    });

    it("should display filtered skills after search", async () => {
      (getTagList as any)
        .mockResolvedValueOnce({ data: mockTags, total: 2 })
        .mockResolvedValueOnce({ data: [mockTags[1]], total: 1 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
        expect(screen.getByText("Python")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");
      await act(async () => {
        await user.type(searchInput, "Python");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(screen.getByText("Python")).toBeInTheDocument();
        expect(screen.queryByText("React")).not.toBeInTheDocument();
      });
    });

    it("should preserve search term when loading more skills", async () => {
      (getTagList as any)
        .mockResolvedValueOnce({ data: mockTags, total: 5 })
        .mockResolvedValueOnce({ data: mockTags, total: 5 })
        .mockResolvedValueOnce({
          data: [
            {
              id: "3",
              label: "TypeScript",
              value: "typescript",
              createdBy: "user-1",
              _count: { jobs: 0, questions: 0, skills: 0 },
            },
          ],
          total: 5,
        });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search skills...");
      await act(async () => {
        await user.type(searchInput, "React");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledWith(1, 25, "React");
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledWith(2, 25, "React");
      });
    });
  });

  describe("Infinite Scroll", () => {
    it("should load and append more skills when sentinel becomes visible", async () => {
      (getTagList as any)
        .mockResolvedValueOnce({ data: mockTags, total: 4 })
        .mockResolvedValueOnce({
          data: [
            {
              id: "3",
              label: "TypeScript",
              value: "typescript",
              createdBy: "user-1",
              _count: { jobs: 0, questions: 0, skills: 0 },
            },
          ],
          total: 4,
        });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getTagList).toHaveBeenCalledWith(2, 25, undefined);
        expect(screen.getByText("TypeScript")).toBeInTheDocument();
        expect(screen.getByText("React")).toBeInTheDocument();
      });
    });

    it("should not fetch more skills once all are loaded", async () => {
      (getTagList as any).mockResolvedValue({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      expect(getTagList).toHaveBeenCalledTimes(1);
    });
  });

  describe("List state", () => {
    it("shows the empty state only after the first load settles", async () => {
      (getTagList as any).mockResolvedValue({ data: [], total: 0 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByTestId("library-empty")).toBeInTheDocument();
      });
    });

    it("shows an error banner instead of an empty list when the read fails", async () => {
      (getTagList as any).mockResolvedValue({
        success: false,
        message: "Career jobs are unavailable (migration-in-progress)",
      });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
        expect(
          screen.getByText(
            "Career jobs are unavailable (migration-in-progress)",
          ),
        ).toBeInTheDocument();
      });
      // A blocked read family is not an empty list.
      expect(screen.queryByTestId("library-empty")).not.toBeInTheDocument();
      expect(screen.queryByText("React")).not.toBeInTheDocument();
    });

    it("recovers through the explicit Retry action", async () => {
      (getTagList as any)
        .mockResolvedValueOnce({ success: false, message: "blocked" })
        .mockResolvedValueOnce({ data: mockTags, total: 2 });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
        expect(
          screen.queryByText("Failed to load the list."),
        ).not.toBeInTheDocument();
      });
      expect(getTagList).toHaveBeenCalledTimes(2);
    });
  });

  describe("Jobs count availability", () => {
    it("renders the unsupported marker instead of a number under A+B", async () => {
      const abTags = [
        {
          id: "1",
          label: "React",
          value: "react",
          createdBy: "user-1",
          _count: { questions: 1, skills: 0 },
        },
      ];
      (getTagList as any).mockResolvedValue({
        data: abTags,
        total: 1,
        jobsCountAvailable: false,
      });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });
      // The jobs column carries availability, not a frozen numeric 0.
      expect(
        screen.getByTestId("tag-jobs-count-unsupported"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Not supported/)).toBeInTheDocument();
    });

    it("shows the real count under the legacy family", async () => {
      (getTagList as any).mockResolvedValue({
        data: mockTags,
        total: 2,
        jobsCountAvailable: true,
      });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId("tag-jobs-count-unsupported"),
      ).not.toBeInTheDocument();
      // React's row has jobs=1 (questions/skills are 0, so "1" is unique
      // inside the row and proves the jobs cell carries a real number).
      const row = screen.getByText("React").closest("tr")!;
      expect(within(row).getByText("1")).toBeInTheDocument();
    });
  });

  describe("Edit", () => {
    it("prefills the edit dialog from the row menu and saves the rename", async () => {
      (getTagList as any).mockResolvedValue({
        data: mockTags,
        total: 2,
        jobsCountAvailable: true,
      });
      (updateTag as any).mockResolvedValue({ success: true, data: {} });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(
          screen.getAllByRole("button", { name: /toggle menu/i })[0],
        );
      });
      await act(async () => {
        await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
      });

      const input = await screen.findByLabelText("Name");
      expect(input).toHaveValue("React");

      await act(async () => {
        await user.clear(input);
        await user.type(input, "React 19");
      });
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Save" }));
      });

      await waitFor(() => {
        expect(updateTag).toHaveBeenCalledWith("1", "React 19");
        expect(getTagList).toHaveBeenCalledTimes(2);
      });
    });

    it("keeps the draft when the rename is rejected", async () => {
      (getTagList as any).mockResolvedValue({
        data: mockTags,
        total: 2,
        jobsCountAvailable: true,
      });
      (updateTag as any).mockResolvedValue({
        success: false,
        message: "Skill tag already exists!",
      });

      render(<TagsContainer />);

      await waitFor(() => {
        expect(screen.getByText("React")).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(
          screen.getAllByRole("button", { name: /toggle menu/i })[0],
        );
      });
      await act(async () => {
        await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
      });

      const input = await screen.findByLabelText("Name");
      await act(async () => {
        await user.clear(input);
        await user.type(input, "Python");
      });
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Save" }));
      });

      await waitFor(() => {
        expect(updateTag).toHaveBeenCalledWith("1", "Python");
      });
      expect(screen.getByLabelText("Name")).toHaveValue("Python");
      expect(getTagList).toHaveBeenCalledTimes(1);
    });
  });
});
