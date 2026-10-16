import JobSourcesContainer from "@/components/admin/JobSourcesContainer";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getJobSourceList } from "@/actions/jobSource.actions";

vi.mock("@/actions/jobSource.actions", () => ({
  getJobSourceList: vi.fn(),
  deleteJobSourceById: vi.fn(),
}));

describe("JobSourcesContainer", () => {
  const mockSources = [
    { id: "1", label: "Indeed", value: "indeed", createdBy: "user-1" },
    { id: "2", label: "Linkedin", value: "linkedin", createdBy: "user-1" },
  ];

  const user = userEvent.setup({ delay: null });

  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(getJobSourceList).toHaveBeenCalledWith(1, 25, "applied");
  });

  it("loads the next page through the Load More button", async () => {
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
      await user.click(screen.getByRole("button", { name: "Load More" }));
    });

    await waitFor(() => {
      expect(getJobSourceList).toHaveBeenCalledWith(2, 25, "applied");
      expect(screen.getByText("Monster")).toBeInTheDocument();
      expect(screen.getByText("Indeed")).toBeInTheDocument();
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

    it("hides Load More after a failed page and only recovers via Retry", async () => {
      (getJobSourceList as any)
        .mockResolvedValueOnce({ data: mockSources, total: 4 })
        .mockResolvedValueOnce({ success: false, message: "failed" })
        .mockResolvedValueOnce({ data: mockSources, total: 4 });

      render(<JobSourcesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Load More" }));
      });

      await waitFor(() => {
        expect(
          screen.getByText("Failed to load the list."),
        ).toBeInTheDocument();
      });
      // No automatic re-request: the Load More affordance is gone while the
      // error is showing, so the failure cannot loop silently.
      expect(
        screen.queryByRole("button", { name: "Load More" }),
      ).not.toBeInTheDocument();
      expect(getJobSourceList).toHaveBeenCalledTimes(2);
      // Rows already loaded stay visible behind the error banner.
      expect(screen.getByText("Indeed")).toBeInTheDocument();

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() => {
        expect(
          screen.queryByText("Failed to load the list."),
        ).not.toBeInTheDocument();
      });
      expect(getJobSourceList).toHaveBeenCalledTimes(3);
      expect(getJobSourceList).toHaveBeenLastCalledWith(1, 25, "applied");
    });
  });
});
