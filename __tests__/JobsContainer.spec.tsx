import JobsContainer from "@/components/myjobs/JobsContainer";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getJobsList,
  getJobDetails,
  deleteJobById,
  updateJobStatus,
  addJob,
} from "@/actions/job.actions";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

vi.mock("next-auth", () => {
  const mockAuth = vi.fn();
  const mockSignIn = vi.fn();
  const mockSignOut = vi.fn();
  const mockHandlers = { GET: vi.fn(), POST: vi.fn() };

  return {
    __esModule: true,
    default: vi.fn(() => ({
      auth: mockAuth,
      handlers: mockHandlers,
      signIn: mockSignIn,
      signOut: mockSignOut,
    })),
    auth: mockAuth,
    signIn: mockSignIn,
    signOut: mockSignOut,
    handlers: mockHandlers,
  };
});

vi.mock("next-auth/providers/credentials", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    id: "credentials",
    name: "Credentials",
    type: "credentials",
  })),
}));

vi.mock("@/actions/job.actions", () => ({
  getJobsList: vi.fn(),
  getJobDetails: vi.fn(),
  deleteJobById: vi.fn(),
  updateJobStatus: vi.fn(),
  addJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
  redirect: vi.fn(),
}));

// useAgentChat throws outside the provider, which this spec does not mount.
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ jobWrites: 0 }),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let intersectionCallback: IntersectionObserverCallback;
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

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

describe("JobsContainer Search Functionality", () => {
  // Simulate real navigation: push/replace rewrite the params the
  // useSearchParams mock hands out, so a rerender() re-reads the new URL —
  // the same round trip a browser performs after router.push.
  let currentParams = new URLSearchParams();
  const setUrl = (url: string) => {
    const qIndex = url.indexOf("?");
    currentParams = new URLSearchParams(
      qIndex >= 0 ? url.slice(qIndex + 1) : "",
    );
  };
  const mockRouter = {
    push: vi.fn((url: string) => setUrl(url)),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn((url: string) => setUrl(url)),
    prefetch: vi.fn(),
  };

  const mockStatuses = [
    { id: "1", label: "Applied", value: "applied" },
    { id: "2", label: "Interview", value: "interview" },
    { id: "3", label: "Draft", value: "draft" },
    { id: "4", label: "Rejected", value: "rejected" },
  ];

  const mockCompanies = [
    { id: "1", label: "Amazon", value: "amazon", createdBy: "user-1" },
    { id: "2", label: "Google", value: "google", createdBy: "user-1" },
  ];

  const mockTitles = [
    {
      id: "1",
      label: "Full Stack Developer",
      value: "full stack developer",
      createdBy: "user-1",
    },
    {
      id: "2",
      label: "Frontend Developer",
      value: "frontend developer",
      createdBy: "user-1",
    },
  ];

  const mockLocations = [
    { id: "1", label: "Remote", value: "remote", createdBy: "user-1" },
    {
      id: "2",
      label: "San Francisco",
      value: "san francisco",
      createdBy: "user-1",
    },
  ];

  const mockSources = [
    { id: "1", label: "Indeed", value: "indeed", createdBy: "user-1" },
    { id: "2", label: "LinkedIn", value: "linkedin", createdBy: "user-1" },
  ];

  const mockJobs = [
    {
      id: "1",
      userId: "user-1",
      JobTitle: {
        id: "1",
        label: "Full Stack Developer",
        value: "full stack developer",
        createdBy: "user-1",
      },
      Company: {
        id: "1",
        label: "Amazon",
        value: "amazon",
        createdBy: "user-1",
        logoUrl: "",
      },
      Location: {
        id: "1",
        label: "Remote",
        value: "remote",
        createdBy: "user-1",
      },
      Status: { id: "1", label: "Applied", value: "applied" },
      JobSource: { id: "1", label: "Indeed", value: "indeed" },
      jobType: "FT",
      appliedDate: new Date("2024-06-19"),
      dueDate: new Date("2024-06-22"),
    },
    {
      id: "2",
      userId: "user-1",
      JobTitle: {
        id: "2",
        label: "Frontend Developer",
        value: "frontend developer",
        createdBy: "user-1",
      },
      Company: {
        id: "2",
        label: "Google",
        value: "google",
        createdBy: "user-1",
        logoUrl: "",
      },
      Location: {
        id: "2",
        label: "San Francisco",
        value: "san francisco",
        createdBy: "user-1",
      },
      Status: { id: "2", label: "Interview", value: "interview" },
      JobSource: { id: "2", label: "LinkedIn", value: "linkedin" },
      jobType: "FT",
      appliedDate: new Date("2024-06-20"),
      dueDate: new Date("2024-06-25"),
    },
  ];

  const user = userEvent.setup({ delay: null });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    currentParams = new URLSearchParams();
    (useRouter as any).mockReturnValue(mockRouter);
    (usePathname as any).mockReturnValue("/dashboard/myjobs");
    (useSearchParams as any).mockImplementation(() => currentParams);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const jsx = () => (
    <JobsContainer
      statuses={mockStatuses}
      companies={mockCompanies}
      titles={mockTitles}
      locations={mockLocations}
      sources={mockSources}
      tags={[]}
    />
  );

  const renderComponent = () => render(jsx());

  it("continues row numbers when the next page is appended", async () => {
    const firstPage = Array.from({ length: 25 }, (_, i) => ({ ...mockJobs[0], id: `job-${i}` }));
    vi.mocked(getJobsList).mockResolvedValueOnce({ success: true, data: firstPage, total: 26 })
      .mockResolvedValueOnce({ success: true, data: [{ ...mockJobs[1], id: "job-next" }], total: 26 });
    renderComponent();
    await waitFor(() => expect(screen.getAllByTestId("job-row-number")).toHaveLength(25));
    await act(async () => intersectionCallback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    await waitFor(() => expect(screen.getAllByTestId("job-row-number")).toHaveLength(26));
    expect(screen.getAllByTestId("job-row-number")[25]).toHaveTextContent("26");
  });

  it.each(["search=Amazon", "filter=interview"])("reindexes fetched results for %s", async (query) => {
    vi.mocked(getJobsList).mockResolvedValueOnce({ success: true, data: mockJobs, total: 2 })
      .mockResolvedValueOnce({ success: true, data: [mockJobs[1]], total: 1 });
    const { rerender } = renderComponent();
    await waitFor(() => expect(screen.getAllByTestId("job-row-number")).toHaveLength(2));
    currentParams = new URLSearchParams(query);
    rerender(jsx());
    await waitFor(() => expect(screen.getAllByTestId("job-row-number")).toHaveLength(1));
    expect(screen.getByTestId("job-row-number")).toHaveTextContent("1");
  });

  describe("Search Input", () => {
    it("should render search input with placeholder", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search jobs..."),
        ).toBeInTheDocument();
      });
    });

    it("should update search input value when typing", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search jobs..."),
        ).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");

      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      expect(searchInput).toHaveValue("Amazon");
    });

    it("should debounce search input for 300ms", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");

      await act(async () => {
        await user.type(searchInput, "A");
      });

      // Should not have called getJobsList yet (debounce not elapsed)
      expect(getJobsList).toHaveBeenCalledTimes(1);

      // Advance timer by 300ms to trigger debounce → URL is updated via
      // replace (no history spam), then the list refetches from the new URL.
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(mockRouter.replace).toHaveBeenCalledWith(
        "/dashboard/myjobs?search=A",
        { scroll: false },
      );
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(2);
      });
    });

    it("should call getJobsList with search term after debounce", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");

      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Amazon", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });

    it("should not trigger search on initial mount with empty search", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      // Initial call should not have search parameter
      expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "custom");
    });

    it("should trigger search when clearing search term after searching", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");

      // Type to trigger search
      await act(async () => {
        await user.type(searchInput, "Test");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Test", undefined, undefined, undefined, undefined, undefined, "custom");
      });

      // Clear the search input → the search param is removed from the URL
      await act(async () => {
        await user.clear(searchInput);
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(mockRouter.replace).toHaveBeenLastCalledWith("/dashboard/myjobs", {
        scroll: false,
      });
      rerender(jsx());

      // Should call with undefined when cleared after having searched
      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Search with Filters", () => {
    it("should combine search with status filter", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search jobs..."),
        ).toBeInTheDocument();
      });

      // Type in search
      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "Developer");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });

      // Now change filter — the status selection lands in the URL
      const filterTrigger = screen.getByTestId("job-filter-select");
      await act(async () => {
        await user.click(filterTrigger);
      });

      const appliedOption = screen.getByRole("option", { name: "Applied" });
      await act(async () => {
        await user.click(appliedOption);
      });

      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?search=Developer&filter=applied",
        { scroll: false },
      );
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, "applied", "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });

    it("should preserve search when changing filter", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      // Type in search
      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Amazon", undefined, undefined, undefined, undefined, undefined, "custom");
      });

      // Change filter
      const filterTrigger = screen.getByTestId("job-filter-select");
      await act(async () => {
        await user.click(filterTrigger);
      });

      const interviewOption = screen.getByRole("option", { name: "Interview" });
      await act(async () => {
        await user.click(interviewOption);
      });
      rerender(jsx());

      // Search term should still be present
      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, "interview", "Amazon", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });

    it("should clear filter but preserve search when selecting None filter", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      // First type in search
      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "Developer");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      // Set a filter
      const filterTrigger = screen.getByTestId("job-filter-select");
      await act(async () => {
        await user.click(filterTrigger);
      });

      const appliedOption = screen.getByRole("option", { name: "Applied" });
      await act(async () => {
        await user.click(appliedOption);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, "applied", "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });

      // Now clear filter by selecting None
      await act(async () => {
        await user.click(filterTrigger);
      });

      const noneOption = screen.getByRole("option", {
        name: "All (Except Dismissed)",
      });
      await act(async () => {
        await user.click(noneOption);
      });
      expect(mockRouter.push).toHaveBeenLastCalledWith(
        "/dashboard/myjobs?search=Developer",
        { scroll: false },
      );
      rerender(jsx());

      // Filter should be cleared but search preserved
      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Search Results Display", () => {
    it("should display filtered jobs after search", async () => {
      const amazonJob = [mockJobs[0]];

      (getJobsList as any)
        .mockResolvedValueOnce({
          success: true,
          data: mockJobs,
          total: 2,
        })
        .mockResolvedValueOnce({
          success: true,
          data: amazonJob,
          total: 1,
        });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
        expect(screen.getByText("Google")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });
    });

    it("should show loading state during search", async () => {
      let resolvePromise: (value: any) => void;
      const searchPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      (getJobsList as any)
        .mockResolvedValueOnce({
          success: true,
          data: mockJobs,
          total: 2,
        })
        .mockReturnValueOnce(searchPromise);

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "test");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      // Should show loading indicator
      await waitFor(() => {
        expect(screen.getByTestId("loader")).toBeInTheDocument();
      });

      // Resolve the search
      await act(async () => {
        resolvePromise!({
          success: true,
          data: [],
          total: 0,
        });
      });
    });
  });

  describe("Infinite Scroll with Search", () => {
    it("should preserve search term when loading more via scroll", async () => {
      (getJobsList as any)
        .mockResolvedValueOnce({
          success: true,
          data: mockJobs,
          total: 50,
        })
        .mockResolvedValueOnce({
          success: true,
          data: mockJobs,
          total: 50,
        })
        .mockResolvedValueOnce({
          success: true,
          data: [
            {
              id: "3",
              userId: "user-1",
              JobTitle: {
                id: "3",
                label: "Backend Developer",
                value: "backend developer",
                createdBy: "user-1",
              },
              Company: {
                id: "3",
                label: "Meta",
                value: "meta",
                createdBy: "user-1",
                logoUrl: "",
              },
              Location: {
                id: "3",
                label: "New York",
                value: "new york",
                createdBy: "user-1",
              },
              Status: { id: "1", label: "Applied", value: "applied" },
              JobSource: { id: "1", label: "Indeed", value: "indeed" },
              jobType: "FT",
              appliedDate: new Date("2024-06-21"),
              dueDate: new Date("2024-06-26"),
            },
          ],
          total: 50,
        });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      // Type search
      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "Developer");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      // Wait for the search fetch to fully resolve before scrolling — the
      // infinite-scroll guard ignores intersections while a load is running.
      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });
      await waitFor(() => {
        expect(screen.getByText(/of 50\s+jobs/)).toBeInTheDocument();
      });

      // Simulate sentinel becoming visible. The observer's closure is rebuilt
      // after each load; fire inside waitFor so a stale callback is retried
      // rather than relying on a single shot landing after React flushes.
      await waitFor(() => {
        intersectionCallback(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
        expect(getJobsList).toHaveBeenCalledWith(2, 25, undefined, "Developer", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle search error gracefully", async () => {
      (getJobsList as any)
        .mockResolvedValueOnce({
          success: true,
          data: mockJobs,
          total: 2,
        })
        .mockResolvedValueOnce({
          success: false,
          message: "Search failed",
        });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search jobs...");
      await act(async () => {
        await user.type(searchInput, "test");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, "test", undefined, undefined, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Company Filter from URL", () => {
    it("should pass company filter to getJobsList when URL has company param", async () => {
      setUrl("/dashboard/myjobs?company=google&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, "google", true, undefined, undefined, undefined, "custom");
      });
    });

    it("should show company badge when company param is present", async () => {
      setUrl("/dashboard/myjobs?company=google&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Google")).toBeInTheDocument();
      });
    });

    it("should clear company filter when badge is clicked", async () => {
      setUrl("/dashboard/myjobs?company=google&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Google")).toBeInTheDocument();
      });

      const badges = screen.getAllByText("Google");
      const badge = badges[0].closest("button")!;
      await act(async () => {
        await user.click(badge);
      });

      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?applied=true",
        { scroll: false },
      );
    });

    it("should not show company badge when no company param", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledTimes(1);
      });

      const googleButtons = screen.queryAllByRole("button").filter(
        (btn) => btn.textContent?.includes("Google"),
      );
      expect(googleButtons).toHaveLength(0);
    });

    it("should combine company filter with status filter", async () => {
      setUrl("/dashboard/myjobs?company=google&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, "google", true, undefined, undefined, undefined, "custom");
      });

      const filterTrigger = screen.getByTestId("job-filter-select");
      await act(async () => {
        await user.click(filterTrigger);
      });

      const appliedOption = screen.getByRole("option", { name: "Applied" });
      await act(async () => {
        await user.click(appliedOption);
      });

      // Selecting the option writes `filter=applied` into the URL while the
      // other params are preserved.
      expect(mockRouter.push).toHaveBeenLastCalledWith(
        "/dashboard/myjobs?company=google&applied=true&filter=applied",
        { scroll: false },
      );
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, "applied", undefined, "google", true, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Title Filter from URL", () => {
    it("should pass title filter to getJobsList when URL has title param", async () => {
      setUrl("/dashboard/myjobs?title=full+stack+developer&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined, true, "full stack developer", undefined, undefined, "custom");
      });
    });

    it("should show title badge when title param is present", async () => {
      setUrl("/dashboard/myjobs?title=full+stack+developer&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Full Stack Developer")).toBeInTheDocument();
      });
    });

    it("should clear title filter when badge is clicked", async () => {
      setUrl("/dashboard/myjobs?title=full+stack+developer&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Full Stack Developer")).toBeInTheDocument();
      });

      const badges = screen.getAllByText("Full Stack Developer");
      const badge = badges[0].closest("button")!;
      await act(async () => {
        await user.click(badge);
      });

      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?applied=true",
        { scroll: false },
      );
    });
  });

  describe("Location Filter from URL", () => {
    it("should pass location filter to getJobsList when URL has location param", async () => {
      setUrl("/dashboard/myjobs?location=remote&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined, true, undefined, "remote", undefined, "custom");
      });
    });

    it("should show location badge when location param is present", async () => {
      setUrl("/dashboard/myjobs?location=remote&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
      });
    });

    it("should clear location filter when badge is clicked", async () => {
      setUrl("/dashboard/myjobs?location=remote&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Remote")).toBeInTheDocument();
      });

      const badges = screen.getAllByText("Remote");
      const badge = badges[0].closest("button")!;
      await act(async () => {
        await user.click(badge);
      });

      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?applied=true",
        { scroll: false },
      );
    });
  });

  describe("Source Filter from URL", () => {
    it("should pass source filter to getJobsList when URL has source param", async () => {
      setUrl("/dashboard/myjobs?source=indeed&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined, true, undefined, undefined, "indeed", "custom");
      });
    });

    it("should show source badge when source param is present", async () => {
      setUrl("/dashboard/myjobs?source=indeed&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });
    });

    it("should clear source filter when badge is clicked", async () => {
      setUrl("/dashboard/myjobs?source=indeed&applied=true");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Indeed")).toBeInTheDocument();
      });

      const badges = screen.getAllByText("Indeed");
      const badge = badges[0].closest("button")!;
      await act(async () => {
        await user.click(badge);
      });

      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?applied=true",
        { scroll: false },
      );
    });
  });

  describe("add-job query param", () => {
    it("should open the Add Job dialog when add-job=true is in the URL", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });
      setUrl("/dashboard/myjobs?add-job=true");

      render(
        <JobsContainer
          statuses={mockStatuses}
          companies={mockCompanies}
          titles={mockTitles}
          locations={mockLocations}
          sources={mockSources}
          tags={[]}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("add-job-dialog-title")).toBeInTheDocument();
      });
    });

    it("should not open the Add Job dialog when add-job param is absent", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.queryByTestId("add-job-dialog-title")).not.toBeInTheDocument();
      });
    });
  });

  describe("URL as source of truth", () => {
    it("restores status filter and search term from the URL on mount", async () => {
      setUrl("/dashboard/myjobs?filter=interview&search=Amazon");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(
          1, 25, "interview", "Amazon",
          undefined, undefined, undefined, undefined, undefined, "custom");
      });
      // The search input mirrors the URL.
      expect(screen.getByPlaceholderText("Search jobs...")).toHaveValue(
        "Amazon",
      );
    });

    it("shows the Applied chip for an applied=true deep link and clears only itself", async () => {
      setUrl("/dashboard/myjobs?applied=true&company=google");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      const { rerender } = renderComponent();

      const appliedBadge = await screen.findByTestId("applied-filter-badge");
      await act(async () => {
        await user.click(appliedBadge);
      });

      // Only the applied param is removed — company stays.
      expect(mockRouter.push).toHaveBeenCalledWith(
        "/dashboard/myjobs?company=google",
        { scroll: false },
      );
      rerender(jsx());

      await waitFor(() => {
        expect(getJobsList).toHaveBeenCalledWith(
          1, 25, undefined, undefined, "google",
          undefined, undefined, undefined, undefined, "custom");
      });
    });
  });

  describe("Empty states", () => {
    it("shows the true empty state when the user has no jobs at all", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("No jobs yet")).toBeInTheDocument();
      });
      expect(
        screen.getByText(
          "Add jobs manually or let the Vocatrya assistant extract postings for you.",
        ),
      ).toBeInTheDocument();
      // The add-job affordance stays available.
      expect(screen.getByTestId("add-job-btn")).toBeInTheDocument();
    });

    it("shows the no-results state when filters produce zero rows", async () => {
      setUrl("/dashboard/myjobs?search=nonexistent");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      renderComponent();

      await waitFor(() => {
        expect(
          screen.getByText("No jobs match the current filters."),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("No jobs yet")).not.toBeInTheDocument();
    });

    it("clears all filters when clicking Clear filters in the no-results state", async () => {
      setUrl("/dashboard/myjobs?search=nonexistent&filter=applied");
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: [],
        total: 0,
      });

      renderComponent();

      const clearBtn = await screen.findByRole("button", {
        name: "Clear filters",
      });
      await act(async () => {
        await user.click(clearBtn);
      });

      expect(mockRouter.push).toHaveBeenCalledWith("/dashboard/myjobs", {
        scroll: false,
      });
    });
  });

  describe("view mode toggle", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("renders the table by default and switches to cards on toggle", async () => {
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() =>
        expect(screen.getByRole("table")).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId("jobs-view-cards-btn"));

      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(localStorage.getItem("jobs-view-mode")).toBe('"cards"');
    });

    it("restores the persisted card view on mount", async () => {
      localStorage.setItem("jobs-view-mode", '"cards"');
      (getJobsList as any).mockResolvedValue({
        success: true,
        data: mockJobs,
        total: 2,
      });

      renderComponent();

      await waitFor(() =>
        expect(screen.getByTestId("jobs-view-cards-btn")).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });
  });
});

describe("JobsContainer load failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (useRouter as any).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
    (usePathname as any).mockReturnValue("/dashboard/myjobs");
    (useSearchParams as any).mockReturnValue(new URLSearchParams());
  });

  it("shows the action error instead of the empty list", async () => {
    vi.mocked(getJobsList).mockResolvedValue({
      success: false,
      message: "Career jobs are unavailable",
      data: undefined,
      total: 0,
    } as any);

    render(
      <JobsContainer
        statuses={[]}
        companies={[]}
        titles={[]}
        locations={[]}
        sources={[]}
        tags={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("jobs-load-error")).toBeInTheDocument();
    });
    expect(screen.getByText("Couldn't load jobs.")).toBeInTheDocument();
    expect(screen.getByText("Career jobs are unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("jobs-empty-state")).not.toBeInTheDocument();
  });
});

describe("JobsContainer add-job refresh", () => {
  const user = userEvent.setup({ skipHover: true });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (useRouter as any).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
    (usePathname as any).mockReturnValue("/dashboard/myjobs");
    (useSearchParams as any).mockReturnValue(new URLSearchParams());
  });

  it("shows a successfully added row after one list reload", async () => {
    const created = {
      id: "job-new",
      userId: "user-1",
      JobTitle: {
        id: "title-1",
        label: "Refresh Visible Role",
        value: "refresh visible role",
        createdBy: "user-1",
      },
      Company: { id: "company-1", label: "Amazon", value: "amazon", createdBy: "user-1", logoUrl: "" },
      Location: { id: "location-1", label: "Remote", value: "remote", createdBy: "user-1" },
      Status: { id: "new-id", label: "New", value: "new" },
      JobSource: { id: "source-1", label: "Indeed", value: "indeed" },
      jobType: "FT",
    };
    vi.mocked(getJobsList)
      .mockResolvedValueOnce({ success: true, data: [], total: 0 })
      .mockResolvedValue({ success: true, data: [created], total: 1 });
    vi.mocked(addJob).mockResolvedValue({ success: true, data: { id: "job-new" } } as any);

    render(
      <JobsContainer
        statuses={[
          { id: "new-id", label: "New", value: "new" },
          { id: "1", label: "Applied", value: "applied" },
        ]}
        companies={[{ id: "company-1", label: "Amazon", value: "amazon", createdBy: "user-1" }]}
        titles={[
          {
            id: "title-1",
            label: "Refresh Visible Role",
            value: "refresh visible role",
            createdBy: "user-1",
          },
        ]}
        locations={[{ id: "location-1", label: "Remote", value: "remote", createdBy: "user-1" }]}
        sources={[{ id: "source-1", label: "Indeed", value: "indeed", createdBy: "user-1" }]}
        tags={[]}
      />,
    );

    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Refresh Visible Role")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("add-job-btn"));
    await user.click(screen.getByRole("combobox", { name: /job title/i }));
    await user.click(screen.getByRole("option", { name: "Refresh Visible Role" }));
    await user.click(screen.getByRole("combobox", { name: /company/i }));
    await user.click(screen.getByRole("option", { name: "Amazon" }));
    await user.click(screen.getByRole("combobox", { name: /job location/i }));
    await user.click(screen.getByRole("option", { name: "Remote" }));
    await user.click(screen.getByRole("combobox", { name: /job source/i }));
    await user.click(screen.getByRole("option", { name: "Indeed" }));
    const description = screen.getByLabelText("Job Description");
    const paragraph = description.querySelector("div > p");
    if (paragraph) paragraph.textContent = "Some description long enough";

    await user.click(screen.getByTestId("save-job-btn"));

    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Refresh Visible Role")).toBeInTheDocument();
  }, 15000);
});
