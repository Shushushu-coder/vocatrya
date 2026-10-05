import React from "react";
import JobDetails from "@/components/myjobs/JobDetails";
import { JobResponse, Tag } from "@/models/job.model";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getApplicationTimeline,
  getSubmittedResumeBindings,
} from "@/actions/application.actions";

// The active tab lives in the URL, so a click only calls router.replace —
// what the user sees next comes from the re-render with the new params.
const router = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
let searchParams = new URLSearchParams();
const onTab = (tab: string) => {
  searchParams = new URLSearchParams(`tab=${tab}`);
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
  usePathname: () => "/dashboard/myjobs/job-1",
}));

const chat = {
  open: vi.fn(),
  startNewConversation: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  approvalPending: false,
};

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
    data: [
      {
        id: "var-1",
        name: "Campus",
        versions: [
          { id: "ver-draft", versionNumber: 2, status: "DRAFT" },
          { id: "ver-a", versionNumber: 1, status: "SUBMITTED" },
        ],
      },
    ],
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

const baseProps = {
  jobStatuses: [],
  companies: [],
  titles: [],
  locations: [],
  sources: [],
  tags: [],
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
  Status: { id: "s1", label: "Applied", value: "applied" },
  Location: { id: "l1", label: "Remote", value: "remote", createdBy: "user-1" },
  JobSource: {
    id: "src1",
    label: "LinkedIn",
    value: "linkedin",
    createdBy: "user-1",
  },
  jobType: "FT",
  createdAt: new Date("2025-01-01"),
  appliedDate: new Date("2025-01-15"),
  dueDate: new Date("2099-12-31"), // far future — not expired
  salaryRange: "100,000 - 110,000",
  description: "<p>Job description</p>",
  jobUrl: "",
  applied: true,
  tags: [],
  ...overrides,
});

describe("JobDetails – skill badges", () => {
  it("renders skill badges for all tags on the job", () => {
    const tags: Tag[] = [
      { id: "tag-1", label: "React", value: "react", createdBy: "user-1" },
      {
        id: "tag-2",
        label: "TypeScript",
        value: "typescript",
        createdBy: "user-1",
      },
      { id: "tag-3", label: "Node.js", value: "node.js", createdBy: "user-1" },
    ];
    render(<JobDetails {...baseProps} job={makeJob({ tags })} />);

    expect(screen.getByText("React")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Node.js")).toBeInTheDocument();
  });

  it("renders no tag badges when the job has no tags", () => {
    render(<JobDetails {...baseProps} job={makeJob({ tags: [] })} />);

    // Verify tag area is simply absent; badges for these labels shouldn't exist
    expect(screen.queryByText("React")).not.toBeInTheDocument();
    expect(screen.queryByText("TypeScript")).not.toBeInTheDocument();
  });

  it("renders no tag badges when tags property is undefined", () => {
    const job = makeJob();
    delete job.tags;
    render(<JobDetails {...baseProps} job={job} />);

    // Should render without crashing and show no skill badges
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();
  });

  it("renders a single skill badge correctly", () => {
    const tags: Tag[] = [
      { id: "tag-1", label: "GraphQL", value: "graphql", createdBy: "user-1" },
    ];
    render(<JobDetails {...baseProps} job={makeJob({ tags })} />);

    expect(screen.getByText("GraphQL")).toBeInTheDocument();
  });

  it("renders each tag label exactly once", () => {
    const tags: Tag[] = [
      { id: "tag-1", label: "React", value: "react", createdBy: "user-1" },
      { id: "tag-2", label: "Vue", value: "vue", createdBy: "user-1" },
    ];
    render(<JobDetails {...baseProps} job={makeJob({ tags })} />);

    // getAllByText returns an array; each label should appear exactly once in the badge area
    expect(screen.getAllByText("React")).toHaveLength(1);
    expect(screen.getAllByText("Vue")).toHaveLength(1);
  });
});

describe("JobDetails – campus recruitment fields", () => {
  it("shows cohort, batch, and application deadline in A+B mode when present", () => {
    render(
      <JobDetails
        {...baseProps}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
        job={makeJob({
          recruitmentCohort: "2027届",
          recruitmentBatch: "秋招",
          dueDate: new Date("2099-12-31"),
        })}
      />,
    );
    expect(screen.getByText("Recruitment cohort")).toBeInTheDocument();
    expect(screen.getByText("2027届")).toBeInTheDocument();
    expect(screen.getByText("Recruitment batch")).toBeInTheDocument();
    expect(screen.getByText("秋招")).toBeInTheDocument();
    expect(screen.getByText("Application deadline")).toBeInTheDocument();
  });

  it("hides empty campus fields and does not show them in legacy mode", () => {
    const { rerender } = render(
      <JobDetails
        {...baseProps}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
        job={makeJob({
          recruitmentCohort: null,
          recruitmentBatch: null,
          dueDate: null,
        })}
      />,
    );
    expect(screen.queryByText("Recruitment cohort")).not.toBeInTheDocument();
    expect(screen.queryByText("Recruitment batch")).not.toBeInTheDocument();
    expect(screen.queryByText("Application deadline")).not.toBeInTheDocument();

    rerender(
      <JobDetails
        {...baseProps}
        job={makeJob({
          recruitmentCohort: "2027届",
          recruitmentBatch: "秋招",
        })}
      />,
    );
    expect(screen.queryByText("Recruitment cohort")).not.toBeInTheDocument();
    expect(screen.queryByText("秋招")).not.toBeInTheDocument();
  });
});

describe("JobDetails – salary range", () => {
  it("renders the salary range in the summary card", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByText(/100,000 - 110,000/)).toBeInTheDocument();
  });

  it("renders a free-text salary verbatim", () => {
    render(
      <JobDetails {...baseProps} job={makeJob({ salaryRange: "$190k – $220k" })} />
    );

    expect(screen.getByText(/\$190k – \$220k/)).toBeInTheDocument();
  });

  it("renders no salary segment when the job has none", () => {
    const { container } = render(
      <JobDetails {...baseProps} job={makeJob({ salaryRange: null })} />
    );

    expect(container.textContent).not.toContain("100,000 - 110,000");
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();
  });
});

describe("JobDetails – linked resume", () => {
  it("links to a built resume that has no uploaded file", () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({
          resumeId: "resume-1",
          Resume: { id: "resume-1", title: "Senior Engineer Resume" },
        })}
      />
    );

    expect(
      screen.getByRole("link", { name: /Senior Engineer Resume/ })
    ).toHaveAttribute("href", "/dashboard/profile/resume/resume-1");
  });
});

describe("JobDetails – match data display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.startNewConversation.mockResolvedValue(undefined);
    searchParams = new URLSearchParams();
  });

  // The score sits in the summary card, the analysis behind the AI Match tab.
  it("shows the match analysis on the AI Match tab when the job has matchData", () => {
    onTab("match");
    const matchData = JSON.stringify({
      matchScore: 85,
      summary: "Good match",
    });
    render(<JobDetails {...baseProps} job={makeJob({ matchScore: 85, matchData })} />);

    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByTestId("match-details")).toBeInTheDocument();
  });

  it("shows the empty state on the AI Match tab when the job has no matchData", () => {
    onTab("match");
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByText(/no match analysis yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("match-details")).not.toBeInTheDocument();
  });

  it("shows the saved match score from the job prop", () => {
    onTab("match");
    render(
      <JobDetails
        job={makeJob({
          matchScore: 72,
          matchData: JSON.stringify({
            matchScore: 72,
            recommendation: "good match",
            body: "## Summary",
          }),
        })}
        {...baseProps}
      />,
    );
    expect(screen.getByTestId("circular-score")).toHaveTextContent("72%");
    expect(screen.getByTestId("match-details")).toBeInTheDocument();
  });

  // Automation saves outside the LLM top-K hold only a keyword pre-rank.
  it("treats an un-analyzed automation job as not matched", () => {
    onTab("match");
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({
          matchScore: 28,
          matchData: JSON.stringify({ prerankScore: 0.29, analyzed: false }),
        })}
      />,
    );

    expect(screen.queryByTestId("circular-score")).not.toBeInTheDocument();
    expect(screen.getByText("Not matched")).toBeInTheDocument();
    expect(screen.getByText(/no match analysis yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("match-details")).not.toBeInTheDocument();
  });
});

describe("JobDetails – tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.approvalPending = false;
    searchParams = new URLSearchParams();
  });

  // The bar must not shift between jobs, so all five are always present.
  it("renders all five tabs regardless of what the job has", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByRole("tab", { name: /description/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ai match/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cover letter/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /notes/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Contacts" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /timeline/i })).not.toBeInTheDocument();
  });

  it("adds the application timeline tab in A+B mode", () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob()}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );

    expect(screen.getByRole("tab", { name: /timeline/i })).toBeInTheDocument();
  });

  it("shows an honest unbound submitted resume on the timeline", async () => {
    vi.mocked(getApplicationTimeline).mockResolvedValue({
      success: true,
      data: {
        opportunityId: "job-1",
        attempts: [
          {
            id: "att-1",
            submittedAt: "2024-01-01T00:00:00.000Z",
            createdAt: "2024-01-01T00:00:00.000Z",
            currentStageCategory: "INTERVIEW",
            outcome: "ACTIVE",
            transferredFromAttemptId: null,
            transferredFrom: null,
            submittedResume: null,
            steps: [
              {
                id: "step-1",
                category: "INTERVIEW",
                label: "Interview",
                status: "IN_PROGRESS",
                source: "SYSTEM",
                scheduledAt: null,
                deadlineAt: null,
                completedAt: null,
                result: null,
                notes: null,
              },
            ],
          },
        ],
      },
    });
    onTab("timeline");
    render(
      <JobDetails
        {...baseProps}
        job={makeJob()}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );

    expect(
      await screen.findByText("No submitted resume linked"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not linked to the resume version/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("application-process-step")).toBeInTheDocument();
  });

  it("shows TRANSFERRED as a native attempt outcome, not a process step", async () => {
    vi.mocked(getApplicationTimeline).mockResolvedValue({
      success: true,
      data: {
        opportunityId: "job-1",
        attempts: [
          {
            id: "att-2",
            submittedAt: "2024-01-01T00:00:00.000Z",
            createdAt: "2024-01-01T00:00:00.000Z",
            currentStageCategory: "CLOSED",
            outcome: "TRANSFERRED",
            transferredFromAttemptId: "att-1",
            transferredFrom: {
              attemptId: "att-1",
              opportunityId: "job-0",
              title: "软件工程师",
              company: "Tencent",
            },
            submittedResume: null,
            steps: [],
          },
        ],
      },
    });
    onTab("timeline");
    render(
      <JobDetails
        {...baseProps}
        job={makeJob()}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );

    expect(await screen.findByText("Transferred")).toBeInTheDocument();
    expect(
      screen.getByText("Transferred from 软件工程师 at Tencent"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("application-process-step"),
    ).not.toBeInTheDocument();
  });

  it("opens on the Description tab", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByRole("tab", { name: /description/i })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("puts the picked tab in the URL so a refresh lands on it", async () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    await userEvent.click(screen.getByRole("tab", { name: /ai match/i }));
    expect(router.replace).toHaveBeenCalledWith("?tab=match", { scroll: false });
  });

  // It stays mounted on every tab so the ⋮ → Add a Note trigger and the count
  // badge keep working; the panel's own inactive state is what hides it.
  it("keeps the notes section mounted while another tab is showing", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByTestId("notes-section")).toBeInTheDocument();
    expect(
      screen.getByTestId("notes-section").closest("[data-state]"),
    ).toHaveAttribute("data-state", "inactive");
  });

  it("shows the cover letter empty state when the job has no letter", () => {
    onTab("letter");
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByText(/no cover letter yet/i)).toBeInTheDocument();
  });

  it("renders the linked letter on the Cover Letter tab", () => {
    onTab("letter");
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({
          coverLetterId: "cl-1",
          CoverLetter: {
            id: "cl-1",
            title: "Frontend Developer – Acme Corp",
            content: "<p>Dear Hiring Team,</p>",
          },
        })}
      />,
    );

    expect(
      screen.getByText("Frontend Developer – Acme Corp", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no cover letter yet/i)).not.toBeInTheDocument();
  });
});

describe("JobDetails – Match with AI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.startNewConversation.mockResolvedValue(undefined);
    searchParams = new URLSearchParams();
  });

  it("opens the chat and asks for a match when Match with AI is clicked", async () => {
    chat.approvalPending = false;
    render(<JobDetails job={makeJob()} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /match with ai/i }));
    await act(async () => {});
    expect(chat.open).toHaveBeenCalled();
    expect(chat.startNewConversation).toHaveBeenCalled();
    const sent = chat.sendMessage.mock.calls[0][0];
    expect(sent.parts[0].text).toMatch(/match/i);
  });

  // The panel opens first so a failed draft cannot leave the button dead, and
  // the match still goes out. History is not deleted.
  it("still asks for the match when starting a new conversation fails", async () => {
    chat.approvalPending = false;
    chat.startNewConversation.mockRejectedValueOnce(new Error("offline"));
    render(<JobDetails job={makeJob()} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /match with ai/i }));
    await act(async () => {});
    expect(chat.open).toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalled();
  });

  it("asks before starting a new conversation when an approval is pending", async () => {
    chat.approvalPending = true;
    render(<JobDetails job={makeJob()} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /match with ai/i }));
    expect(screen.getByText(/stays in History/i)).toBeInTheDocument();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });
});

describe("JobDetails cover letter action", () => {
  beforeEach(() => {
    chat.approvalPending = false;
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
  });

  it("stays enabled when no resume is linked", () => {
    render(<JobDetails {...baseProps} job={makeJob({ resumeId: undefined })} />);
    expect(screen.getByTestId("generate-cover-letter-btn")).toBeEnabled();
  });

  it("disables the action for a title-only description", () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({
          resumeId: "resume-1",
          descriptionCompleteness: "title-only",
        })}
      />,
    );
    expect(screen.getByTestId("generate-cover-letter-btn")).toBeDisabled();
  });

  it("enables the action for a real description", () => {
    render(
      <JobDetails {...baseProps} job={makeJob({ resumeId: "resume-1" })} />,
    );
    expect(screen.getByTestId("generate-cover-letter-btn")).toBeEnabled();
  });

  it("opens the chat and asks for a letter naming the job", async () => {
    render(
      <JobDetails {...baseProps} job={makeJob({ resumeId: "resume-1" })} />,
    );
    await userEvent.click(screen.getByTestId("generate-cover-letter-btn"));
    expect(chat.open).toHaveBeenCalled();
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalled());
    const sent = chat.sendMessage.mock.calls[0][0];
    expect(sent.parts[0].text).toMatch(/cover letter/i);
    expect(sent.parts[0].text).toContain("Frontend Developer");
    expect(sent.parts[0].text).toContain("Acme Corp");
  });

  it("asks before starting a new conversation when an approval is pending", async () => {
    chat.approvalPending = true;
    render(
      <JobDetails {...baseProps} job={makeJob({ resumeId: "resume-1" })} />,
    );
    await userEvent.click(screen.getByTestId("generate-cover-letter-btn"));
    expect(screen.getByText(/stays in History/i)).toBeInTheDocument();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  // Derived from the server prop, not local state: the chat saves the letter
  // server-side and fires router.refresh().
  it("labels the action Regenerate when a letter is already linked", () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({ resumeId: "resume-1", coverLetterId: "cl-1" })}
      />,
    );
    expect(screen.getByTestId("generate-cover-letter-btn")).toHaveTextContent(
      /regenerate/i,
    );
  });
});

describe("JobDetails – auto-match from the jobs list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.approvalPending = false;
    chat.startNewConversation.mockResolvedValue(undefined);
    searchParams = new URLSearchParams();
  });

  it("runs the match and drops the flag when arriving with ?match=1", async () => {
    searchParams = new URLSearchParams("tab=match&match=1");
    render(<JobDetails {...baseProps} job={makeJob()} />);
    await act(async () => {});

    expect(chat.open).toHaveBeenCalled();
    const sent = chat.sendMessage.mock.calls[0][0];
    expect(sent.parts[0].text).toMatch(/match/i);
    expect(router.replace).toHaveBeenCalledWith("?tab=match", { scroll: false });
  });

  it("runs no match when the flag is absent", async () => {
    searchParams = new URLSearchParams("tab=match");
    render(<JobDetails {...baseProps} job={makeJob()} />);
    await act(async () => {});

    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  // The chat refreshes the route once the match is saved; a second run would
  // burn another LLM call and overwrite the result.
  it("runs the match only once across re-renders", async () => {
    searchParams = new URLSearchParams("tab=match&match=1");
    const { rerender } = render(<JobDetails {...baseProps} job={makeJob()} />);
    await act(async () => {});
    rerender(<JobDetails {...baseProps} job={makeJob({ matchScore: 80 })} />);
    await act(async () => {});

    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("asks before starting a new conversation when an approval is pending", async () => {
    chat.approvalPending = true;
    searchParams = new URLSearchParams("tab=match&match=1");
    render(<JobDetails {...baseProps} job={makeJob()} />);
    await act(async () => {});

    expect(screen.getByText(/stays in History/i)).toBeInTheDocument();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });
});

describe("JobDetails – company link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.approvalPending = false;
    searchParams = new URLSearchParams();
  });

  it("links the company in the header to its details page", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(screen.getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
      "href",
      "/dashboard/admin/companies/c1",
    );
  });

  it("keeps the dot-separated subtitle reading the same", () => {
    render(<JobDetails {...baseProps} job={makeJob()} />);

    expect(
      screen.getByRole("link", { name: "Acme Corp" }).parentElement,
    ).toHaveTextContent("Acme Corp · Remote · Full-time");
  });
});

describe("JobDetails – restricted submitted resume surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.approvalPending = false;
    searchParams = new URLSearchParams();
    vi.mocked(getSubmittedResumeBindings).mockResolvedValue({
      success: true,
      data: { opportunityId: null, attempts: [] },
    });
    vi.mocked(getApplicationTimeline).mockResolvedValue({
      success: true,
      data: { opportunityId: "job-1", attempts: [] },
    });
  });

  it("hides the restricted resume panel and timeline when scope is none", () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob()}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="none"
      />,
    );

    expect(
      screen.queryByTestId("restricted-submitted-resume-panel"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /timeline/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /description/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ai match/i })).toBeInTheDocument();
    expect(getApplicationTimeline).not.toHaveBeenCalled();
    expect(getSubmittedResumeBindings).not.toHaveBeenCalled();
  });

  it("shows the restricted resume panel and hides full A-side surfaces in resume_v1", async () => {
    render(
      <JobDetails
        {...baseProps}
        job={makeJob({
          recruitmentCohort: "2027届",
          recruitmentBatch: "秋招",
        })}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="resume_v1"
      />,
    );

    expect(
      await screen.findByTestId("restricted-submitted-resume-panel"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("restricted-submitted-resume-no-attempt"),
    ).toHaveTextContent(
      "This job has no application record that can be bound to a resume.",
    );
    expect(screen.queryByRole("tab", { name: /timeline/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("application-timeline")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("application-process-step"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("interview-reflection-entry"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Interview reflection")).not.toBeInTheDocument();
    expect(screen.queryByText("Add process step")).not.toBeInTheDocument();
    expect(screen.queryByText("Upcoming")).not.toBeInTheDocument();
    expect(screen.queryByText("Deep Match")).not.toBeInTheDocument();
    expect(screen.queryByText("Fast Screening")).not.toBeInTheDocument();
    expect(screen.queryByText("Recruitment cohort")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /description/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ai match/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cover letter/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /notes/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Contacts" })).toBeInTheDocument();
    expect(getApplicationTimeline).not.toHaveBeenCalled();
    expect(getSubmittedResumeBindings).toHaveBeenCalledWith("job-1");
  });

  it("shows the restricted panel for a legacy job whose mapped opportunity uses a different id", async () => {
    vi.mocked(getSubmittedResumeBindings).mockResolvedValue({
      success: true,
      data: {
        opportunityId: "opp-987",
        attempts: [
          {
            id: "att-a",
            channelLabel: "Campus",
            createdAt: "2026-01-01T00:00:00.000Z",
            submittedAt: "2026-01-02T00:00:00.000Z",
            submittedResume: {
              id: "ver-a",
              title: "Campus",
              versionNumber: 1,
              resumeVariantId: "var-1",
              resumeVariantVersionId: "ver-a",
            },
          },
          {
            id: "att-b",
            channelLabel: "Referral",
            createdAt: "2026-02-01T00:00:00.000Z",
            submittedAt: null,
            submittedResume: null,
          },
        ],
      },
    });

    render(
      <JobDetails
        {...baseProps}
        job={makeJob({ id: "legacy-job-123" })}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="resume_v1"
      />,
    );

    expect(
      await screen.findByTestId("restricted-submitted-resume-panel"),
    ).toBeInTheDocument();
    const cards = await screen.findAllByTestId(
      "restricted-submitted-resume-attempt",
    );
    expect(cards).toHaveLength(2);
    expect(screen.getByTestId("view-submitted-resume-version")).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1?version=ver-a",
    );
    expect(await screen.findByTestId("submit-resume-picker")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /timeline/i })).not.toBeInTheDocument();
    expect(getSubmittedResumeBindings).toHaveBeenCalledWith("legacy-job-123");
    expect(getSubmittedResumeBindings).not.toHaveBeenCalledWith("opp-987");
    expect(getApplicationTimeline).not.toHaveBeenCalled();
  });

  it("keeps full Timeline and does not duplicate the restricted panel in full scope", async () => {
    onTab("timeline");
    render(
      <JobDetails
        {...baseProps}
        job={makeJob()}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );

    expect(screen.getByRole("tab", { name: /timeline/i })).toBeInTheDocument();
    expect(
      screen.queryByTestId("restricted-submitted-resume-panel"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("No application timeline yet")).toBeInTheDocument();
    expect(getSubmittedResumeBindings).not.toHaveBeenCalled();
  });
});
