import { JobSummaryCard } from "@/components/myjobs/job-details/JobSummaryCard";
import { JobResponse, JobStatus } from "@/models/job.model";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@/i18n/context";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock("@/components/profile/DownloadFileButton", () => ({
  DownloadFileButton: () => null,
}));

vi.mock("@/components/CircularScore", () => ({
  CircularScore: ({ score }: { score: number }) => <div>{score}%</div>,
}));

const appliedStatus: JobStatus = {
  id: "s1",
  label: "Applied",
  value: "applied",
};

const makeJob = (overrides: Partial<JobResponse> = {}): JobResponse => ({
  id: "job-1",
  userId: "user-1",
  JobTitle: {
    id: "t1",
    label: "Frontend Developer",
    value: "frontend developer",
    createdBy: "user-1",
  },
  Company: {
    id: "c1",
    label: "Acme Corp",
    value: "acme corp",
    createdBy: "user-1",
  },
  Status: appliedStatus,
  Location: { id: "l1", label: "Remote", value: "remote", createdBy: "user-1" },
  JobSource: {
    id: "src1",
    label: "Referral Group",
    value: "referral group",
    createdBy: "",
  },
  jobType: "FT",
  createdAt: new Date("2025-01-01"),
  appliedDate: new Date("2025-01-15"),
  dueDate: null,
  salaryRange: null,
  description: "<p>Job description</p>",
  jobUrl: "",
  applied: true,
  tags: [],
  ...overrides,
});

describe("JobSummaryCard – job source display", () => {
  it("localizes a preset source label in zh-CN", () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <JobSummaryCard
          job={makeJob()}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("内推群")).toBeInTheDocument();
    expect(screen.queryByText("Referral Group")).not.toBeInTheDocument();
  });

  it("localizes a preset source label in en", () => {
    render(
      <I18nProvider initialLocale="en">
        <JobSummaryCard
          job={makeJob()}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Referral Group")).toBeInTheDocument();
  });

  it("keeps a user-created custom source verbatim in both locales", () => {
    const customSource = {
      id: "src-custom",
      label: "学校就业群",
      value: "学校就业群",
      createdBy: "user-1",
    };
    render(
      <I18nProvider initialLocale="zh-CN">
        <JobSummaryCard
          job={makeJob({ JobSource: customSource })}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("学校就业群")).toBeInTheDocument();
  });

  it("renders a dash when the job has no source", () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <JobSummaryCard
          job={makeJob({ JobSource: null })}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("求职渠道")).toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });
});

describe("JobSummaryCard – createdVia badge", () => {
  it("does not decorate manual entries with a meaningless USER badge", () => {
    render(
      <I18nProvider initialLocale="en">
        <JobSummaryCard
          job={makeJob({ createdVia: "USER" })}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.queryByText(/via USER/i)).not.toBeInTheDocument();
  });

  it("still shows a provenance badge for non-manual origins", () => {
    render(
      <I18nProvider initialLocale="en">
        <JobSummaryCard
          job={makeJob({ createdVia: "chat" })}
          currentStatus={appliedStatus}
          matchData={null}
          showMatchScore={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("via chat")).toBeInTheDocument();
  });
});
