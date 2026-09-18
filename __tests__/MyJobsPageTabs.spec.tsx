import { render, screen } from "@testing-library/react";
import { MyJobsPageTabs } from "@/components/myjobs/MyJobsPageTabs";

const router = { replace: vi.fn() };
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
  usePathname: () => "/dashboard/myjobs",
}));

vi.mock("@/components/myjobs/JobsContainer", () => ({
  default: () => <div data-testid="jobs-container" />,
}));

vi.mock("@/components/myjobs/UpcomingContainer", () => ({
  UpcomingContainer: () => <div data-testid="upcoming-container" />,
}));

const props = {
  statuses: [],
  companies: [],
  titles: [],
  locations: [],
  sources: [],
  tags: [],
};

describe("MyJobsPageTabs", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
  });

  it("does not show Upcoming in LEGACY_ONLY", () => {
    render(<MyJobsPageTabs {...props} careerRuntimeMode="LEGACY_ONLY" />);
    expect(screen.queryByRole("tab", { name: "Upcoming" })).not.toBeInTheDocument();
    expect(screen.getByTestId("jobs-container")).toBeInTheDocument();
  });

  it("shows Upcoming next to Jobs in A+B mode", () => {
    render(<MyJobsPageTabs {...props} careerRuntimeMode="AB_ENABLED" />);
    expect(screen.getByRole("tab", { name: "Jobs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Upcoming" })).toBeInTheDocument();
  });
});
