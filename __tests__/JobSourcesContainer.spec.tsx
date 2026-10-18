import JobSourcesContainer from "@/components/admin/JobSourcesContainer";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getJobSourceList } from "@/actions/jobSource.actions";

vi.mock("@/actions/jobSource.actions", () => ({
  getJobSourceList: vi.fn(),
  deleteJobSourceById: vi.fn(),
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

describe("JobSourcesContainer", () => {
  const mockSources = [
    { id: "1", label: "Indeed", value: "indeed", createdBy: "user-1" },
    { id: "2", label: "Linkedin", value: "linkedin", createdBy: "user-1" },
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

  it("should load and display job sources on mount", async () => {
    (getJobSourceList as any).mockResolvedValue({
      data: mockSources,
      total: 2,
    });

    render(<JobSourcesContainer />);

    await waitFor(() => {
      expect(screen.getByText("Indeed")).toBeInTheDocument();
      expect(screen.getByText("Linkedin")).toBeInTheDocument();
    });

    expect(getJobSourceList).toHaveBeenCalledWith(1, 25, "applied", undefined);
  });

  it("loads the next page when the sentinel becomes visible", async () => {
    (getJobSourceList as any)
      .mockResolvedValueOnce({ data: mockSources, total: 4 })
      .mockResolvedValueOnce({
        data: [{ id: "3", label: "Monster", value: "monster", createdBy: "user-1" }],
        total: 4,
      });

    render(<JobSourcesContainer />);

    await waitFor(() => {
      expect(screen.getByText("Indeed")).toBeInTheDocument();
    });

    await act(async () => {
      intersectionCallback!(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(getJobSourceList).toHaveBeenCalledWith(2, 25, "applied", undefined);
      expect(screen.getByText("Monster")).toBeInTheDocument();
      expect(screen.getByText("Indeed")).toBeInTheDocument();
    });
  });

  describe("Search", () => {
    it("debounces search input and re-queries from page 1", async () => {
      (getJobSourceList as any)
        .mockResolvedValueOnce({ data: mockSources, total: 2 })
        .mockResolvedValueOnce({ data: [mockSources[0]], total: 1 });

      render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search sources...");
      await act(async () => {
        await user.type(searchInput, "Ind");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getJobSourceList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          "Ind",
        );
      });
      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
        expect(screen.queryByText("Linkedin")).not.toBeInTheDocument();
      });
    });

    it("preserves the search term when loading the next page", async () => {
      (getJobSourceList as any)
        .mockResolvedValueOnce({ data: mockSources, total: 4 })
        .mockResolvedValueOnce({ data: mockSources, total: 4 })
        .mockResolvedValueOnce({
          data: [
            { id: "3", label: "Indeed UK", value: "indeed-uk", createdBy: "user-1" },
          ],
          total: 4,
        });

      render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search sources...");
      await act(async () => {
        await user.type(searchInput, "Indeed");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getJobSourceList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          "Indeed",
        );
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getJobSourceList).toHaveBeenCalledWith(
          2,
          25,
          "applied",
          "Indeed",
        );
      });
    });
  });

  describe("Error state", () => {
    it("shows an error banner instead of an empty list when the action fails", async () => {
      (getJobSourceList as any).mockResolvedValue({
        success: false,
        message: "Career jobs are unavailable (migration-in-progress)",
      });

      render(<JobSourcesContainer />);

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
      expect(screen.queryByText("Indeed")).not.toBeInTheDocument();
    });

    it("shows the error banner when the action rejects or returns nothing", async () => {
      (getJobSourceList as any).mockResolvedValue(undefined);
      const { unmount } = render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
      unmount();

      (getJobSourceList as any).mockRejectedValue(new Error("network down"));
      render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
    });

    it("stops auto-loading after a failed page and only recovers via Retry", async () => {
      (getJobSourceList as any)
        .mockResolvedValueOnce({ data: mockSources, total: 4 })
        .mockResolvedValueOnce({ success: false, message: "failed" })
        .mockResolvedValueOnce({ data: mockSources, total: 4 });

      render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
      // No automatic re-request: the sentinel is gone while the error is
      // showing, so the failure cannot loop silently.
      expect(getJobSourceList).toHaveBeenCalledTimes(2);
      // Rows already loaded stay visible behind the error banner.
      expect(screen.getByText("Indeed")).toBeInTheDocument();

      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });
      expect(getJobSourceList).toHaveBeenCalledTimes(2);

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() => {
        expect(
          screen.queryByText("Failed to load the list."),
        ).not.toBeInTheDocument();
      });
      expect(getJobSourceList).toHaveBeenCalledTimes(3);
      expect(getJobSourceList).toHaveBeenLastCalledWith(1, 25, "applied", undefined);
    });
  });
});
