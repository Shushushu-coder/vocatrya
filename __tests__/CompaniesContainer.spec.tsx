import CompaniesContainer from "@/components/admin/CompaniesContainer";
import { screen, render, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getCompanyList, getCompanyById } from "@/actions/company.actions";
import { searchAtsCompanies } from "@/actions/atsCompany.actions";

const mockPush = vi.fn();
let mockParams = new URLSearchParams("");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/dashboard/admin",
  useSearchParams: () => mockParams,
}));

vi.mock("@/actions/company.actions", () => ({
  getCompanyList: vi.fn(),
  getCompanyById: vi.fn(),
  deleteCompanyById: vi.fn(),
  addCompany: vi.fn(),
  updateCompany: vi.fn(),
  watchBoardCompany: vi.fn(),
  setCompanyWatched: vi.fn(),
  getWatchedBoards: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/actions/atsCompany.actions", () => ({
  searchAtsCompanies: vi.fn().mockResolvedValue({
    companies: [{ name: "Anthropic", token: "anthropic" }],
    hasMore: false,
  }),
  getAtsCompanyCount: vi.fn().mockResolvedValue(1860),
  resolveAtsBoard: vi.fn(),
}));

// A real next/link builds its own IntersectionObserver for prefetching, which
// would replace the sentinel callback captured below
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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

describe("CompaniesContainer Search Functionality", () => {
  const mockCompanies = [
    {
      id: "1",
      label: "Amazon",
      value: "amazon",
      createdBy: "user-1",
      _count: { contacts: 3 },
    },
    { id: "2", label: "Google", value: "google", createdBy: "user-1" },
  ];

  const user = userEvent.setup({ delay: null });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intersectionCallback = undefined;
    mockParams = new URLSearchParams("");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Search Input", () => {
    it("should render search input with placeholder", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search companies..."),
        ).toBeInTheDocument();
      });
    });

    it("should update search input value when typing", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Search companies..."),
        ).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");

      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      expect(searchInput).toHaveValue("Amazon");
    });

    it("should debounce search input for 300ms", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");

      await act(async () => {
        await user.type(searchInput, "A");
      });

      // Should not have called getCompanyList yet (debounce not elapsed)
      expect(getCompanyList).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledTimes(2);
      });
    });

    it("should call getCompanyList with search term after debounce", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");

      await act(async () => {
        await user.type(searchInput, "Amazon");
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          "Amazon",
          "mine",
        );
      });
    });

    it("should not trigger search on initial mount with empty search", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(getCompanyList).toHaveBeenCalledTimes(1);
      expect(getCompanyList).toHaveBeenCalledWith(
        1,
        25,
        "applied",
        undefined,
        "mine",
      );
    });

    it("should trigger search when clearing search term after searching", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledTimes(1);
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");

      await act(async () => {
        await user.type(searchInput, "Amazon");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          "Amazon",
          "mine",
        );
      });

      await act(async () => {
        await user.clear(searchInput);
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenLastCalledWith(
          1,
          25,
          "applied",
          undefined,
          "mine",
        );
      });
    });

    it("should display filtered companies after search", async () => {
      (getCompanyList as any)
        .mockResolvedValueOnce({ data: mockCompanies, total: 2 })
        .mockResolvedValueOnce({
          data: [mockCompanies[0]],
          total: 1,
        });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
        expect(screen.getByText("Google")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");
      await act(async () => {
        await user.type(searchInput, "Amazon");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
        expect(screen.queryByText("Google")).not.toBeInTheDocument();
      });
    });

    it("should preserve search term when loading more companies", async () => {
      (getCompanyList as any)
        .mockResolvedValueOnce({ data: mockCompanies, total: 5 })
        .mockResolvedValueOnce({ data: mockCompanies, total: 5 })
        .mockResolvedValueOnce({
          data: [{ id: "3", label: "Meta", value: "meta", createdBy: "user-1" }],
          total: 5,
        });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search companies...");
      await act(async () => {
        await user.type(searchInput, "Amazon");
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          "Amazon",
          "mine",
        );
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledWith(
          2,
          25,
          "applied",
          "Amazon",
          "mine",
        );
      });
    });
  });

  describe("Infinite Scroll", () => {
    it("should load and append more companies when sentinel becomes visible", async () => {
      (getCompanyList as any)
        .mockResolvedValueOnce({ data: mockCompanies, total: 4 })
        .mockResolvedValueOnce({
          data: [{ id: "3", label: "Meta", value: "meta", createdBy: "user-1" }],
          total: 4,
        });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback!(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(getCompanyList).toHaveBeenCalledWith(
          2,
          25,
          "applied",
          undefined,
          "mine",
        );
        expect(screen.getByText("Meta")).toBeInTheDocument();
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });
    });

    it("should not fetch more companies once all are loaded", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() => {
        expect(screen.getByText("Amazon")).toBeInTheDocument();
      });

      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });

      expect(getCompanyList).toHaveBeenCalledTimes(1);
    });
  });

  describe("Scope", () => {
    it("reads the scope from the URL and browses the seed instead of the database", async () => {
      mockParams = new URLSearchParams("scope=board:ashby");
      (getCompanyList as any).mockResolvedValue({ data: [], total: 0 });

      render(<CompaniesContainer />);

      expect(await screen.findByText("Anthropic")).toBeInTheDocument();
      expect(searchAtsCompanies).toHaveBeenCalledWith("ashby", "", 0);
      expect(getCompanyList).not.toHaveBeenCalled();
    });

    it("passes the watchlist scope through to getCompanyList", async () => {
      mockParams = new URLSearchParams("scope=watchlist");
      (getCompanyList as any).mockResolvedValue({ data: [], total: 0 });

      render(<CompaniesContainer />);

      await waitFor(() =>
        expect(getCompanyList).toHaveBeenCalledWith(
          1,
          25,
          "applied",
          undefined,
          "watchlist",
        ),
      );
    });
  });
  describe("Contacts count", () => {
    it("shows how many contacts work at each company", async () => {
      (getCompanyList as any).mockResolvedValue({
        data: mockCompanies,
        total: 2,
      });

      render(<CompaniesContainer />);

      await waitFor(() =>
        expect(
          screen.getByRole("columnheader", { name: "Contacts" })
        ).toBeInTheDocument()
      );
      const row = screen.getByRole("row", { name: /Amazon/ });
      expect(within(row).getByText("3")).toBeInTheDocument();
    });
  });
  describe("Details links", () => {
    it("links each company name to its details page", async () => {
      (getCompanyList as any).mockResolvedValue({ data: mockCompanies, total: 2 });

      render(<CompaniesContainer />);

      expect(
        await screen.findByRole("link", { name: "Amazon" }),
      ).toHaveAttribute("href", "/dashboard/admin/companies/1");
    });

    it("carries the watchlist scope into the details link", async () => {
      mockParams = new URLSearchParams("scope=watchlist");
      (getCompanyList as any).mockResolvedValue({ data: mockCompanies, total: 2 });

      render(<CompaniesContainer />);

      expect(
        await screen.findByRole("link", { name: "Amazon" }),
      ).toHaveAttribute("href", "/dashboard/admin/companies/1?scope=watchlist");
    });

    it("offers View details first in the row menu", async () => {
      (getCompanyList as any).mockResolvedValue({ data: mockCompanies, total: 2 });

      render(<CompaniesContainer />);

      const row = await screen.findByRole("row", { name: /Amazon/ });
      await user.click(within(row).getByRole("button", { name: /toggle menu/i }));

      const items = await screen.findAllByRole("menuitem");
      expect(items[0]).toHaveTextContent("View details");
      expect(items[0]).toHaveAttribute("href", "/dashboard/admin/companies/1");
    });
  });

  describe("List error state", () => {
    it("shows the Action's blocked-family message instead of a blank list", async () => {
      // Same payload getCompanyList returns when resolveJobsReadFamily is
      // blocked — before the fix this rendered as a normal empty list.
      (getCompanyList as any).mockResolvedValue({
        success: false,
        message: "Career jobs are unavailable (ab-migration-incomplete)",
      });

      render(<CompaniesContainer />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Failed to load companies");
      expect(alert).toHaveTextContent(
        "Career jobs are unavailable (ab-migration-incomplete)",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("shows the error state for a generic Action failure", async () => {
      (getCompanyList as any).mockResolvedValue({
        success: false,
        message: "Failed to fetch company list. boom",
      });

      render(<CompaniesContainer />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Failed to fetch company list. boom",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("shows the error state when the Action call rejects", async () => {
      (getCompanyList as any).mockRejectedValue(new Error("network down"));

      render(<CompaniesContainer />);

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Failed to load companies",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    });

    it("shows the error state when the Action returns no result", async () => {
      (getCompanyList as any).mockResolvedValue(undefined);

      render(<CompaniesContainer />);

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Failed to load companies",
      );
    });

    it("renders neither the error nor a table for a genuinely empty list", async () => {
      (getCompanyList as any).mockResolvedValue({ data: [], total: 0 });

      render(<CompaniesContainer />);

      await waitFor(() => expect(getCompanyList).toHaveBeenCalledTimes(1));
      await act(async () => {});

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    });

    it("recovers the real list once a retried load succeeds", async () => {
      (getCompanyList as any)
        .mockResolvedValueOnce({
          success: false,
          message: "Career jobs are unavailable (ab-migration-incomplete)",
        })
        .mockResolvedValue({ data: mockCompanies, total: 2 });

      render(<CompaniesContainer />);

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Career jobs are unavailable",
      );

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });
      expect(screen.getByText("Amazon")).toBeInTheDocument();
      expect(screen.getByText("Google")).toBeInTheDocument();
      expect(getCompanyList).toHaveBeenCalledTimes(2);
    });
  });
});
