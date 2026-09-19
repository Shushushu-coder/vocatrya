import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationResumeBindingPanel } from "@/components/myjobs/job-details/ApplicationResumeBindingPanel";
import {
  getSubmittedResumeBindings,
  submitAttemptResumeVersion,
} from "@/actions/application.actions";
import { listSubmittableResumeVersions } from "@/actions/resumeVariant.actions";

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/application.actions", () => ({
  getSubmittedResumeBindings: vi.fn(),
  submitAttemptResumeVersion: vi.fn(),
}));

vi.mock("@/actions/resumeVariant.actions", () => ({
  listSubmittableResumeVersions: vi.fn(),
}));

const getBindings = vi.mocked(getSubmittedResumeBindings);
const submitBind = vi.mocked(submitAttemptResumeVersion);
const listSubmittable = vi.mocked(listSubmittableResumeVersions);

function attemptDto(
  overrides: Partial<{
    id: string;
    channelLabel: string;
    createdAt: string;
    submittedAt: string | null;
    submittedResume: {
      id: string;
      title: string;
      versionNumber: number;
      resumeVariantId: string;
      resumeVariantVersionId: string;
    } | null;
  }> = {},
) {
  return {
    id: "att-1",
    channelLabel: "USER",
    createdAt: "2026-01-01T00:00:00.000Z",
    submittedAt: null as string | null,
    submittedResume: null as
      | {
          id: string;
          title: string;
          versionNumber: number;
          resumeVariantId: string;
          resumeVariantVersionId: string;
        }
      | null,
    ...overrides,
  };
}

describe("ApplicationResumeBindingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitBind.mockResolvedValue({ success: true, data: {} as never });
    listSubmittable.mockResolvedValue({
      success: true,
      data: [
        {
          id: "var-1",
          name: "Campus",
          versions: [
            { id: "ver-draft", versionNumber: 2, status: "DRAFT" },
            { id: "ver-frozen", versionNumber: 1, status: "FROZEN" },
          ],
        },
      ],
    });
  });

  it("shows a safe no-attempt state without the bind picker", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: { opportunityId: null, attempts: [] },
    });
    render(<ApplicationResumeBindingPanel jobId="job-1" refreshKey={0} />);

    expect(
      await screen.findByTestId("restricted-submitted-resume-no-attempt"),
    ).toHaveTextContent(
      "This job has no application record that can be bound to a resume.",
    );
    expect(screen.queryByTestId("submit-resume-picker")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("submit-resume-picker-empty"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/create a resume/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/create application/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/migrate/i)).not.toBeInTheDocument();
  });

  it("shows SubmitResumePicker for an owned unbound attempt", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: {
        opportunityId: "job-1",
        attempts: [attemptDto()],
      },
    });
    render(<ApplicationResumeBindingPanel jobId="job-1" refreshKey={0} />);

    expect(await screen.findByTestId("submit-resume-picker")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose resume")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose version")).toBeInTheDocument();
    expect(
      screen.queryByTestId("restricted-submitted-resume-no-attempt"),
    ).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Choose resume"), "var-1");
    await userEvent.selectOptions(
      screen.getByLabelText("Choose version"),
      "ver-draft",
    );
    expect(screen.getByTestId("submit-draft-lock-warning")).toBeInTheDocument();
  });

  it("shows locked history with the exact submitted version link", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: {
        opportunityId: "job-1",
        attempts: [
          attemptDto({
            submittedAt: "2026-01-02T00:00:00.000Z",
            submittedResume: {
              id: "ver-sub",
              title: "Campus",
              versionNumber: 1,
              resumeVariantId: "var-1",
              resumeVariantVersionId: "ver-sub",
            },
          }),
        ],
      },
    });
    render(<ApplicationResumeBindingPanel jobId="job-1" refreshKey={0} />);

    expect(await screen.findByText(/Campus/)).toBeInTheDocument();
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByTestId("view-submitted-resume-version")).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1?version=ver-sub",
    );
    expect(
      screen.getByText(/already has a submitted resume version/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("submit-resume-picker")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /replace|unbind|reselect/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps archived-variant history visible with the exact version link", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: {
        opportunityId: "job-1",
        attempts: [
          attemptDto({
            submittedResume: {
              id: "ver-sub",
              title: "Campus",
              versionNumber: 1,
              resumeVariantId: "var-archived",
              resumeVariantVersionId: "ver-sub",
            },
          }),
        ],
      },
    });
    render(<ApplicationResumeBindingPanel jobId="job-1" refreshKey={0} />);

    const link = await screen.findByTestId("view-submitted-resume-version");
    expect(link).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-archived?version=ver-sub",
    );
    expect(screen.getByText(/Campus/)).toBeInTheDocument();
  });

  it("loads bindings with the legacy job id, not an opportunity id", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: {
        opportunityId: "opp-987",
        attempts: [attemptDto({ id: "att-a", channelLabel: "Campus" })],
      },
    });
    render(
      <ApplicationResumeBindingPanel jobId="legacy-job-123" refreshKey={0} />,
    );
    expect(
      await screen.findByTestId("restricted-submitted-resume-attempt"),
    ).toHaveAttribute("data-attempt-id", "att-a");
    expect(getBindings).toHaveBeenCalledWith("legacy-job-123");
    expect(getBindings).not.toHaveBeenCalledWith("opp-987");
  });

  it("renders each owned attempt with independent history and picker state", async () => {
    getBindings.mockResolvedValue({
      success: true,
      data: {
        opportunityId: "opp-987",
        attempts: [
          attemptDto({
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
          }),
          attemptDto({
            id: "att-b",
            channelLabel: "Referral",
            createdAt: "2026-02-01T00:00:00.000Z",
            submittedResume: null,
          }),
        ],
      },
    });
    render(
      <ApplicationResumeBindingPanel jobId="legacy-job-123" refreshKey={0} />,
    );

    const cards = await screen.findAllByTestId(
      "restricted-submitted-resume-attempt",
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute("data-attempt-id", "att-a");
    expect(cards[1]).toHaveAttribute("data-attempt-id", "att-b");
    expect(within(cards[0]).getByText(/Version 1/)).toBeInTheDocument();
    expect(
      within(cards[0]).getByTestId("view-submitted-resume-version"),
    ).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1?version=ver-a",
    );
    expect(
      within(cards[0]).getByText(/already has a submitted resume version/i),
    ).toBeInTheDocument();
    expect(
      within(cards[0]).queryByTestId("submit-resume-picker"),
    ).not.toBeInTheDocument();
    expect(
      within(cards[1]).getByTestId("submit-resume-picker"),
    ).toBeInTheDocument();
    expect(
      within(cards[1]).queryByTestId("view-submitted-resume-version"),
    ).not.toBeInTheDocument();

    await userEvent.selectOptions(
      within(cards[1]).getByLabelText("Choose resume"),
      "var-1",
    );
    await userEvent.selectOptions(
      within(cards[1]).getByLabelText("Choose version"),
      "ver-draft",
    );
    await userEvent.click(
      within(cards[1]).getByRole("button", { name: "Bind this version" }),
    );
    expect(submitBind).toHaveBeenCalledWith({
      attemptId: "att-b",
      submittedResumeVersionId: "ver-draft",
    });
    expect(submitBind).not.toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "att-a" }),
    );
  });
});
