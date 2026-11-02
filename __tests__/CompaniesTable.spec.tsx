import CompaniesTable from "@/components/admin/CompaniesTable";
import { render, screen } from "@testing-library/react";

vi.mock("@/actions/company.actions", () => ({
  deleteCompanyById: vi.fn(),
  setCompanyWatched: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const company = {
  id: "co1",
  label: "ByteDance",
  value: "bytedance",
  logoUrl: "",
  watched: false,
  watchedAt: null,
  atsToken: null,
  atsProvider: null,
  atsHost: null,
  _count: { jobsTotal: 3, jobsApplied: 2, jobsRejected: 1, contacts: 4 },
} as any;

function renderTable(scope?: "mine" | "watchlist") {
  return render(
    <CompaniesTable
      companies={[company]}
      reloadCompanies={vi.fn()}
      editCompany={vi.fn()}
      scope={scope}
    />,
  );
}

describe("CompaniesTable", () => {
  // Narrow numeric columns would otherwise wrap a multi-character CJK header
  // one character per line; the header must stay on a single line.
  it.each(["Total Jobs", "Jobs Applied", "Rejected", "Contacts"])(
    "keeps the %s count header on one line",
    (name) => {
      renderTable("mine");
      expect(screen.getByRole("columnheader", { name })).toHaveClass(
        "whitespace-nowrap",
      );
    },
  );

  it.each(["Board", "Jobs"])(
    "keeps the watchlist %s header on one line",
    (name) => {
      renderTable("watchlist");
      expect(screen.getByRole("columnheader", { name })).toHaveClass(
        "whitespace-nowrap",
      );
    },
  );
});
