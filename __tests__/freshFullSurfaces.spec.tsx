import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";

// ---------------------------------------------------------------------------
// Mocks shared by several renders
// ---------------------------------------------------------------------------

let searchParams = new URLSearchParams("");
const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/dashboard"),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams,
}));

import { usePathname } from "next/navigation";

const chat = {
  open: vi.fn(),
  startNewConversation: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  seedExchange: vi.fn(),
  approvalPending: false,
  busy: false,
  preflight: { checked: true, ok: true },
  context: { version: 1, items: [] as Array<Record<string, string>> },
  requestAddContext: vi.fn(),
};

vi.mock("@/components/agent/empty-state-motion", () => ({
  mountEmptyStateMotion: () => ({ dispose: vi.fn(), setState: vi.fn() }),
}));

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));

vi.mock("@/components/myjobs/NotesSection", () => ({
  NotesSection: () => <div data-testid="notes-section" />,
}));

vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: () => null,
}));

vi.mock("@/components/automations/MatchDetails", () => ({
  MatchDetails: () => <div data-testid="match-details" />,
}));

vi.mock("@/components/profile/DownloadFileButton", () => ({
  DownloadFileButton: () => null,
}));

vi.mock("@/actions/contact.actions", () => ({
  getAllContacts: vi.fn().mockResolvedValue([]),
  getJobContacts: vi.fn().mockResolvedValue([]),
  addJobContact: vi.fn(),
  removeJobContact: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
}));

vi.mock("@/actions/contactRole.actions", () => ({
  getAllContactRoles: vi.fn().mockResolvedValue([]),
  createContactRole: vi.fn(),
}));

vi.mock("@/components/CircularScore", () => ({
  CircularScore: ({ score }: { score: number }) => (
    <div data-testid="circular-score">{score}%</div>
  ),
}));

vi.mock("@/actions/resumeVariant.actions", () => ({
  listSubmittableResumeVersions: vi.fn().mockResolvedValue({
    success: true,
    data: [],
  }),
}));

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn().mockResolvedValue({
    success: true,
    data: { opportunityId: "job-1", attempts: [] },
  }),
  getSubmittedResumeBindings: vi.fn().mockResolvedValue({
    success: true,
    data: { opportunityId: null, attempts: [] },
  }),
  createApplicationProcessStep: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
  deleteApplicationProcessStep: vi.fn(),
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
  attachAttemptResumeVersion: vi.fn(),
}));

vi.mock("@/actions/company.actions", () => ({
  getCompanyList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getCompanyById: vi.fn(),
  getAllCompanies: vi.fn().mockResolvedValue([]),
  addCompany: vi.fn(),
}));

vi.mock("@/actions/jobtitle.actions", () => ({
  getJobTitleList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createJobTitle: vi.fn(),
  updateJobTitle: vi.fn(),
}));

vi.mock("@/actions/jobLocation.actions", () => ({
  getJobLocationsList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getAllJobLocations: vi.fn().mockResolvedValue([]),
  updateJobLocation: vi.fn(),
}));

vi.mock("@/actions/job.actions", () => ({
  deleteJobById: vi.fn().mockResolvedValue({ success: true }),
  updateJobStatus: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/actions/activity.actions", () => ({
  getActivityTypeList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createActivityType: vi.fn(),
  updateActivityType: vi.fn(),
}));

import Sidebar from "@/components/Sidebar";
import { SidebarProvider } from "@/context/SidebarContext";
import Header from "@/components/Header";
import AdminTabsContainer from "@/components/admin/AdminTabsContainer";
import SettingsSidebar from "@/components/settings/SettingsSidebar";
import { MatchJobButton } from "@/components/myjobs/MatchJobButton";
import JobDetails from "@/components/myjobs/JobDetails";
import { JobStatusBadgeMenu } from "@/components/myjobs/JobStatusBadgeMenu";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";
import type { JobResponse } from "@/models/job.model";

const wrap = (node: React.ReactNode, fresh = true, jobMutationsEnabled = true) => (
  <CareerSurfacesProvider freshNativeFull={fresh} jobMutationsEnabled={jobMutationsEnabled} resumeV1Enabled={fresh}>{node}</CareerSurfacesProvider>
);

const testUser = { id: "1", name: "Test User", email: "test@example.com" };

// ---------------------------------------------------------------------------
// Primary navigation
// ---------------------------------------------------------------------------

describe("fresh + full navigation", () => {
  beforeEach(() => {
    (usePathname as any).mockReturnValue("/dashboard");
  });

  const renderSidebar = (fresh: boolean) =>
    render(
      <SidebarProvider initialExpanded>
        {wrap(<Sidebar user={testUser} signOutAction={() => {}} />, fresh)}
      </SidebarProvider>,
    );

  it("hides the Automations entry and keeps supported entries", () => {
    renderSidebar(true);

    expect(
      screen.queryByRole("link", { name: "Automations" }),
    ).not.toBeInTheDocument();
    for (const name of [
      "Dashboard",
      "Analytics",
      "Jobs",
      "Tasks",
      "Activities",
      "Questions",
      "Interview",
      "Application Profile",
    ]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("keeps the Automations entry outside fresh + full", () => {
    renderSidebar(false);
    expect(
      screen.getByRole("link", { name: "Automations" }),
    ).toHaveAttribute("href", "/dashboard/automations");
  });
});

// ---------------------------------------------------------------------------
// Header create menu + upload entry (replaces the removed quick-create card)
// ---------------------------------------------------------------------------

describe("Header global actions", () => {
  beforeEach(() => {
    routerPush.mockClear();
  });

  it("offers the four canonical create flows and never automation", async () => {
    const user = userEvent.setup();
    render(wrap(<Header />));
    await user.click(screen.getByTestId("header-create-menu"));

    const menu = await screen.findByRole("menu");
    for (const name of ["Job", "Tasks", "Activities", "Question"]) {
      expect(within(menu).getByText(name)).toBeInTheDocument();
    }
    expect(within(menu).queryByText("Automation")).not.toBeInTheDocument();
  });

  it("routes upload to the resumes surface under fresh + full", () => {
    render(wrap(<Header />));
    expect(screen.getByTestId("header-upload")).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes?import-resume=true",
    );
  });

  it("routes upload to the profile surface outside fresh + full", () => {
    render(wrap(<Header />, false));
    expect(screen.getByTestId("header-upload")).toHaveAttribute(
      "href",
      "/dashboard/profile?import-resume=true",
    );
  });
});

// ---------------------------------------------------------------------------
// Library tabs
// ---------------------------------------------------------------------------

describe("AdminTabsContainer", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("");
  });

  it("hides the contacts and roles tabs under fresh + full", () => {
    render(wrap(<AdminTabsContainer />));

    expect(screen.queryByRole("tab", { name: "Contacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Companies" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Job Titles" })).toBeInTheDocument();
  });

  it("falls back to companies for a retained ?tab=contacts link", () => {
    searchParams = new URLSearchParams("tab=contacts");
    render(wrap(<AdminTabsContainer />));

    expect(screen.getByRole("tab", { name: "Companies" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.queryByRole("tab", { name: "Contacts" })).not.toBeInTheDocument();
  });

  it("keeps the contacts and roles tabs outside fresh + full", () => {
    render(wrap(<AdminTabsContainer />, false));

    expect(screen.getByRole("tab", { name: "Contacts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Roles" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("SettingsSidebar", () => {
  const NINE_ENTRY_IA = [
    "General",
    "Notifications",
    "Appearance",
    "AI Services",
    "AI Assignments",
    "Shortcuts",
    "Audio",
    "Data & Privacy",
    "About",
  ];

  it("renders the frozen nine-entry IA under fresh + full, without an MCP nav entry", () => {
    render(
      wrap(
        <SettingsSidebar
          activeSection="ai-services"
          onSectionChange={() => {}}
        />,
      ),
    );

    for (const label of NINE_ENTRY_IA) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // MCP is a compat sub-area inside Data & Privacy, never a nav entry.
    expect(screen.queryByText("MCP Access")).not.toBeInTheDocument();
  });

  it("renders the identical IA outside fresh + full (nav is flag-independent)", () => {
    render(
      wrap(
        <SettingsSidebar
          activeSection="ai-services"
          onSectionChange={() => {}}
        />,
        false,
      ),
    );

    for (const label of NINE_ENTRY_IA) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("MCP Access")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// My Jobs
// ---------------------------------------------------------------------------

describe("MatchJobButton", () => {
  it("does not link to automatic matching when job mutations are unavailable", () => {
    render(wrap(<MatchJobButton jobId="job-1" />, false, false));
    expect(screen.queryByRole("link", { name: /match/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /match/i })).toBeDisabled();
  });
  it("renders nothing under fresh + full", () => {
    const { container } = render(wrap(<MatchJobButton jobId="job-1" />));
    expect(container.firstChild).toBeNull();
  });

  it("links to the auto-match route outside fresh + full", () => {
    render(wrap(<MatchJobButton jobId="job-1" />, false));
    expect(
      screen.getByRole("link", { name: /match/i }),
    ).toHaveAttribute("href", "/dashboard/myjobs/job-1?tab=match&match=1");
  });
});

const makeJob = (): JobResponse =>
  ({
    id: "job-1",
    userId: "user-1",
    JobTitle: { id: "t1", label: "Frontend Developer", value: "frontend developer", createdBy: "user-1" },
    Company: { id: "c1", label: "Acme Corp", value: "acme corp", createdBy: "user-1" },
    Status: { id: "s1", label: "Applied", value: "applied" },
    Location: null,
    JobSource: null,
    jobType: "FT",
    createdAt: new Date("2025-01-01"),
    appliedDate: new Date("2025-01-15"),
    salaryRange: "",
    description: "<p>Job description</p>",
    jobUrl: "",
    applied: true,
    tags: [],
  }) as unknown as JobResponse;

const jobDetailsProps = {
  jobStatuses: [],
  companies: [],
  titles: [],
  locations: [],
  sources: [],
  tags: [],
  careerRuntimeMode: "AB_ENABLED",
  abRolloutScope: "full" as const,
};

describe("restricted job surfaces", () => {
  it("disables the shared status picker without invoking a write", async () => {
    const onChange = vi.fn();
    render(wrap(<TooltipProvider><JobStatusBadgeMenu job={makeJob()} jobStatuses={[]}
      onChangeJobStatus={onChange} /></TooltipProvider>, false, false));
    const picker = screen.getByRole("button");
    expect(picker).toBeDisabled();
    await userEvent.click(picker);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables destructive and AI entry points, including a retained auto-match link", async () => {
    searchParams = new URLSearchParams("tab=match&match=1");
    await act(async () => {
      render(wrap(<JobDetails job={makeJob()} {...jobDetailsProps}
        abRolloutScope="resume_v1" />, false, false));
    });
    expect(screen.getByTestId("job-details-delete-btn")).toBeDisabled();
    expect(screen.getByTestId("job-details-edit-btn")).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: "Match with AI" })) expect(button).toBeDisabled();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("job-details-actions-menu-btn"));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
    searchParams = new URLSearchParams("");
  });

  it("shows an accurate restricted-scope notice without affecting writable scopes", () => {
    const { rerender } = render(<CareerRuntimeNotice mode="AB_ENABLED" jobMutationsEnabled={false} />);
    expect(screen.getByText("Job editing is not enabled yet")).toBeInTheDocument();
    rerender(<CareerRuntimeNotice mode="AB_ENABLED" jobMutationsEnabled />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("JobDetails under fresh + full", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("");
  });

  it("hides match, cover letter and contacts tabs but keeps canonical tabs", () => {
    render(
      wrap(
        <JobDetails job={makeJob()} {...jobDetailsProps} />,
      ),
    );

    const tabList = screen.getByRole("tablist");
    expect(
      within(tabList).queryByRole("tab", { name: /match/i }),
    ).not.toBeInTheDocument();
    expect(
      within(tabList).queryByRole("tab", { name: /cover letter/i }),
    ).not.toBeInTheDocument();
    expect(
      within(tabList).queryByRole("tab", { name: /contacts/i }),
    ).not.toBeInTheDocument();

    expect(
      within(tabList).getByRole("tab", { name: "Description" }),
    ).toBeInTheDocument();
    expect(
      within(tabList).getByRole("tab", { name: "Timeline" }),
    ).toBeInTheDocument();
    expect(
      within(tabList).getByRole("tab", { name: /notes/i }),
    ).toBeInTheDocument();
  });

  it("hides the header match and cover letter CTAs", () => {
    render(
      wrap(
        <JobDetails job={makeJob()} {...jobDetailsProps} />,
      ),
    );

    expect(
      screen.queryByRole("button", { name: /match with ai/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("generate-cover-letter-btn"),
    ).not.toBeInTheDocument();
    // Canonical controls survive.
    expect(
      screen.getByTestId("job-details-edit-btn"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("job-details-delete-btn"),
    ).toBeInTheDocument();
  });

  it("lands on the description tab for a retained ?tab=match link", () => {
    searchParams = new URLSearchParams("tab=match");
    render(
      wrap(
        <JobDetails job={makeJob()} {...jobDetailsProps} />,
      ),
    );

    expect(
      screen.getByRole("tab", { name: "Description" }),
    ).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("tab", { name: /match/i })).not.toBeInTheDocument();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("does not auto-fire a match for a retained ?match=1 link", () => {
    searchParams = new URLSearchParams("match=1");
    render(
      wrap(
        <JobDetails job={makeJob()} {...jobDetailsProps} />,
      ),
    );

    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the full tab set and AI CTAs outside fresh + full", () => {
    render(
      wrap(
        <JobDetails job={makeJob()} {...jobDetailsProps} />,
        false,
      ),
    );

    expect(screen.getByRole("tab", { name: "AI Match" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Cover Letter" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /contacts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /match with ai/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Assistant empty state
// ---------------------------------------------------------------------------

describe("AgentChatEmptyState under fresh + full", () => {
  it("suggests adding a job without the legacy posting copy", () => {
    chat.context = { version: 1, items: [] };
    render(wrap(<AgentChatEmptyState />));

    expect(screen.getByText("Add a job")).toBeInTheDocument();
    expect(
      screen.queryByText("Add a job posting"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Choose a job")).toBeInTheDocument();
  });

  it("suggests add_job outside fresh + full", () => {
    chat.context = { version: 1, items: [] };
    render(wrap(<AgentChatEmptyState />, false));

    expect(screen.getByText("Add a job posting")).toBeInTheDocument();
  });

  it("does not suggest matching on a job page, but keeps read prompts", () => {
    chat.context = {
      version: 1,
      items: [
        {
          kind: "job",
          entityId: "job-1",
          labelSnapshot: "AI Product Analyst",
          source: "AUTO",
        },
      ],
    };
    render(wrap(<AgentChatEmptyState />));

    expect(screen.queryByText("Check my match")).not.toBeInTheDocument();
    expect(screen.getByText("Analyze this job")).toBeInTheDocument();
    expect(screen.getByText("Prepare for the interview")).toBeInTheDocument();
  });

  it("suggests matching on a job page outside fresh + full", () => {
    render(wrap(<AgentChatEmptyState />, false));
    expect(screen.getByText("Check my match")).toBeInTheDocument();
  });
});
