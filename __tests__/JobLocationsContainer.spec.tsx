import JobLocationsContainer from "@/components/admin/JobLocationsContainer";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getJobLocationsList } from "@/actions/jobLocation.actions";

vi.mock("@/actions/jobLocation.actions", () => ({
  getJobLocationsList: vi.fn(),
  deleteJobLocationById: vi.fn(),
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

describe("JobLocationsContainer", () => {
  const mockLocations = [
    { id: "1", label: "Remote", value: "remote", createdBy: "user-1" },
    { id: "2", label: "New York", value: "new-york", createdBy: "user-1" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    intersectionCallback = undefined;
  });

  it("should load and display job locations on mount", async () => {
    (getJobLocationsList as any).mockResolvedValue({
      data: mockLocations,
      total: 2,
    });

    render(<JobLocationsContainer />);

    await waitFor(() => {
      expect(screen.getByText("Remote")).toBeInTheDocument();
      expect(screen.getByText("New York")).toBeInTheDocument();
    });

    expect(getJobLocationsList).toHaveBeenCalledWith(1, 25, "applied");
  });

  describe("Infinite Scroll", () => {
    it("should load and append more job locations when sentinel becomes visible", async () => {
      (getJobLocationsList as any)
        .mockResolvedValueOnce({ data: mockLocations, total: 4 })
        .mockResolvedValueOnce({
          data: [
            { id: "3", label: "Austin", value: "austin", createdBy: "user-1" },
          ],
          total: 4,
        });

      render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getJobLocationsList).toHaveBeenCalledWith(2, 25, "applied");
        expect(screen.getByText("Austin")).toBeInTheDocument();
        expect(screen.getByText("Remote")).toBeInTheDocument();
      });
    });

    it("should not fetch more job locations once all are loaded", async () => {
      (getJobLocationsList as any).mockResolvedValue({
        data: mockLocations,
        total: 2,
      });

      render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      expect(getJobLocationsList).toHaveBeenCalledTimes(1);
    });

    it("stops auto-retrying through the sentinel after a load-more failure", async () => {
      (getJobLocationsList as any)
        .mockResolvedValueOnce({ data: mockLocations, total: 4 })
        .mockResolvedValueOnce({ success: false, message: "failed" });

      render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
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
      // Existing rows stay visible behind the error banner.
      expect(screen.getByText("Remote")).toBeInTheDocument();

      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      expect(getJobLocationsList).toHaveBeenCalledTimes(2);
    });
  });

  describe("Error state", () => {
    it("shows an error banner instead of an empty list when the action fails", async () => {
      (getJobLocationsList as any).mockResolvedValue({
        success: false,
        message: "Career jobs are unavailable (migration-in-progress)",
      });

      render(<JobLocationsContainer />);

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
      expect(screen.queryByText("Remote")).not.toBeInTheDocument();
    });

    it("shows the error banner when the action rejects or returns nothing", async () => {
      (getJobLocationsList as any).mockResolvedValue(undefined);
      const { unmount } = render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
      unmount();

      (getJobLocationsList as any).mockRejectedValue(new Error("network down"));
      render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
    });

    it("recovers through the explicit Retry action", async () => {
      const user = userEvent.setup({ delay: null });
      (getJobLocationsList as any)
        .mockResolvedValueOnce({ success: false, message: "blocked" })
        .mockResolvedValueOnce({ data: mockLocations, total: 2 });

      render(<JobLocationsContainer />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
        expect(
          screen.queryByText("Failed to load the list."),
        ).not.toBeInTheDocument();
      });
      expect(getJobLocationsList).toHaveBeenCalledTimes(2);
      expect(getJobLocationsList).toHaveBeenLastCalledWith(1, 25, "applied");
    });
  });
});
