import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@/i18n";
import { ResumeVariantList } from "@/components/career/resume-variant/ResumeVariantList";
import { ResumeVariantWorkspace } from "@/components/career/resume-variant/ResumeVariantWorkspace";
import { SubmitResumePicker } from "@/components/career/resume-variant/SubmitResumePicker";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import {
  getResumeVariant,
  getResumeVariantVersion,
  listResumeCareerMaterials,
  listResumeVariants,
  listResumeVariantVersions,
  listSubmittableResumeVersions,
  cloneResumeVersionAsDraft,
  freezeResumeVersion,
} from "@/actions/resumeVariant.actions";
import { getApplicationTimeline } from "@/actions/application.actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/resumeVariant.actions", () => ({
  archiveResumeVariant: vi.fn(),
  cloneResumeVersionAsDraft: vi.fn(),
  createResumeExpression: vi.fn(),
  createResumeSection: vi.fn(),
  createResumeSectionItem: vi.fn(),
  createResumeVariant: vi.fn(),
  deleteResumeExpression: vi.fn(),
  deleteResumeSection: vi.fn(),
  deleteResumeSectionItem: vi.fn(),
  freezeResumeVersion: vi.fn(),
  getResumeVariant: vi.fn(),
  getResumeVariantVersion: vi.fn(),
  listResumeCareerMaterials: vi.fn(),
  listResumeVariants: vi.fn(),
  listResumeVariantVersions: vi.fn(),
  listSubmittableResumeVersions: vi.fn(),
  renameResumeVariant: vi.fn(),
  reorderResumeExpressions: vi.fn(),
  reorderResumeSectionItems: vi.fn(),
  reorderResumeSections: vi.fn(),
  replaceResumeExpressionEvidence: vi.fn(),
  updateResumeExpression: vi.fn(),
  updateResumeHeaderSnapshot: vi.fn(),
  updateResumeSection: vi.fn(),
}));

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn(),
  getSubmittedResumeBindings: vi.fn(),
  createApplicationProcessStep: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
  deleteApplicationProcessStep: vi.fn(),
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
  submitAttemptResumeVersion: vi.fn(),
}));

const listVariants = vi.mocked(listResumeVariants);
const getVariant = vi.mocked(getResumeVariant);
const listVersions = vi.mocked(listResumeVariantVersions);
const getVersion = vi.mocked(getResumeVariantVersion);
const listMaterials = vi.mocked(listResumeCareerMaterials);
const listSubmittable = vi.mocked(listSubmittableResumeVersions);
const freezeVersion = vi.mocked(freezeResumeVersion);
const cloneDraft = vi.mocked(cloneResumeVersionAsDraft);
const getTimeline = vi.mocked(getApplicationTimeline);

function draftGraph(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-1",
    status: "DRAFT",
    headerSnapshot: null,
    resumeVariant: { id: "var-1", name: "Campus", archivedAt: null },
    submittedAttempts: [],
    sections: [],
    ...overrides,
  };
}

describe("Resume Variant V1 product polish UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMaterials.mockResolvedValue({ success: true, data: [] });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("explains what/why/next on the variant list empty state", async () => {
    listVariants.mockResolvedValue({ success: true, data: [] });
    render(<ResumeVariantList />);

    const empty = await screen.findByTestId("resume-variant-empty-state");
    expect(empty).toHaveTextContent(
      "Resume versions let you build different resumes from your career materials",
    );
    expect(empty).toHaveTextContent("Create a resume");
    expect(empty).toHaveTextContent("Add sections and career materials");
    expect(empty).toHaveTextContent("Edit resume wording");
    expect(empty).toHaveTextContent("Preview and freeze a version");
    expect(
      within(empty).getByRole("button", { name: "Create resume" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Complete application profile" }),
    ).toHaveAttribute("href", "/dashboard/profile/application");
    expect(screen.getByTestId("resume-variant-name-input")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create resume" })).toHaveLength(2);
    expect(empty.textContent).not.toMatch(/import|legacy|sync existing resume/i);
  });

  it("focuses the existing create name input from the empty-state CTA", async () => {
    listVariants.mockResolvedValue({ success: true, data: [] });
    render(<ResumeVariantList />);
    const empty = await screen.findByTestId("resume-variant-empty-state");
    await userEvent.click(within(empty).getByRole("button", { name: "Create resume" }));
    expect(screen.getByTestId("resume-variant-name-input")).toHaveFocus();
  });

  it("uses freeze confirmation copy instead of permanent-delete wording", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-1" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({ success: true, data: draftGraph() });

    render(<ResumeVariantWorkspace variantId="var-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Freeze version" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Freeze this version?")).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/read-only/i);
    expect(dialog.textContent).toMatch(/new draft/i);
    expect(dialog.textContent).toMatch(/not deleted/i);
    expect(dialog.textContent).not.toMatch(/permanently delete/i);
    expect(dialog.textContent).not.toMatch(/removed from the system/i);
    const confirm = within(dialog).getByRole("button", { name: "Freeze version" });
    expect(confirm.className).toContain("bg-primary");
    expect(confirm.className).not.toContain("bg-destructive");
    expect(freezeVersion).not.toHaveBeenCalled();
  });

  it("preselects a historical version without cloning or jumping to current draft", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-2" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "SUBMITTED", currentVersion: false },
        { id: "ver-2", versionNumber: 2, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({
      success: true,
      data: draftGraph({
        id: "ver-1",
        status: "SUBMITTED",
        submittedAttempts: [{ id: "att-1" }],
      }),
    });

    render(
      <ResumeVariantWorkspace variantId="var-1" initialVersionId="ver-1" />,
    );
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /v1\s+·\s+Submitted/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(getVersion).toHaveBeenCalledWith("ver-1"),
    );
    expect(getVersion).not.toHaveBeenCalledWith("ver-2");
    expect(cloneDraft).not.toHaveBeenCalled();
  });

  it("fails closed when the requested version id is missing from the loaded variant list", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-1" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({ success: true, data: draftGraph() });

    render(
      <ResumeVariantWorkspace variantId="var-1" initialVersionId="ver-other" />,
    );
    // Fail closed: an explicitly requested but unlisted version must surface
    // the safe not-found state instead of silently opening the current version.
    expect(await screen.findByText("Resume variant not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to resume variants" })).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes",
    );
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("opens the current version when no initial version is requested", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-2" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "FROZEN", currentVersion: false },
        { id: "ver-2", versionNumber: 2, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({
      success: true,
      data: draftGraph({ id: "ver-2", status: "DRAFT" }),
    });

    render(<ResumeVariantWorkspace variantId="var-1" />);
    await waitFor(() => expect(getVersion).toHaveBeenCalledWith("ver-2"));
    expect(getVersion).not.toHaveBeenCalledWith("ver-1");
    expect(await screen.findByRole("button", { name: "Freeze version" })).toBeInTheDocument();
  });

  it("does not expose literal UNLINKED in the workspace UI", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-1" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({
      success: true,
      data: draftGraph({
        sections: [
          {
            id: "sec-1",
            title: "Experience",
            systemKind: null,
            sortOrder: 0,
            items: [
              {
                id: "item-1",
                itemKind: "MANUAL",
                careerMaterialItemId: null,
                sortOrder: 0,
                careerMaterialItem: null,
                expressions: [
                  {
                    id: "exp-1",
                    kind: "BULLET",
                    content: "Shipped a campus tool",
                    sortOrder: 0,
                    evidenceStatus: "UNLINKED",
                    evidenceLinks: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    render(<ResumeVariantWorkspace variantId="var-1" />);
    expect(await screen.findByText("Shipped a campus tool")).toBeInTheDocument();
    expect(screen.getByText(/Not linked to supporting facts/)).toBeInTheDocument();
    expect(screen.getByText(/Add resume wording/)).toBeInTheDocument();
    expect(screen.queryByText("UNLINKED")).not.toBeInTheDocument();
  });

  it("shows productized UNLINKED copy in zh-CN", async () => {
    getVariant.mockResolvedValue({
      success: true,
      data: { name: "Campus", currentVersionId: "ver-1" },
    });
    listVersions.mockResolvedValue({
      success: true,
      data: [
        { id: "ver-1", versionNumber: 1, status: "DRAFT", currentVersion: true },
      ],
    });
    getVersion.mockResolvedValue({
      success: true,
      data: draftGraph({
        sections: [
          {
            id: "sec-1",
            title: "经历",
            systemKind: null,
            sortOrder: 0,
            items: [
              {
                id: "item-1",
                itemKind: "MANUAL",
                careerMaterialItemId: null,
                sortOrder: 0,
                careerMaterialItem: null,
                expressions: [
                  {
                    id: "exp-1",
                    kind: "BULLET",
                    content: "完成校园工具",
                    sortOrder: 0,
                    evidenceStatus: "UNLINKED",
                    evidenceLinks: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    render(
      <I18nProvider initialLocale="zh-CN">
        <ResumeVariantWorkspace variantId="var-1" />
      </I18nProvider>,
    );
    expect(await screen.findByText("完成校园工具")).toBeInTheDocument();
    expect(screen.getByText(/未关联事实依据/)).toBeInTheDocument();
    expect(screen.queryByText("UNLINKED")).not.toBeInTheDocument();
  });

  it("warns only when the selected submit version is DRAFT", async () => {
    listSubmittable.mockResolvedValue({
      success: true,
      data: [
        {
          id: "var-1",
          name: "Campus",
          versions: [
            { id: "ver-draft", versionNumber: 2, status: "DRAFT" },
            { id: "ver-frozen", versionNumber: 1, status: "FROZEN" },
            { id: "ver-submitted", versionNumber: 3, status: "SUBMITTED" },
          ],
        },
      ],
    });
    render(<SubmitResumePicker attemptId="att-1" locked={false} onBound={vi.fn()} />);
    await userEvent.selectOptions(
      await screen.findByLabelText("Choose resume"),
      "var-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Choose version"), "ver-draft");
    expect(screen.getByTestId("submit-draft-lock-warning")).toHaveTextContent(
      "Submitting this draft will lock it",
    );

    await userEvent.selectOptions(screen.getByLabelText("Choose version"), "ver-frozen");
    expect(screen.queryByTestId("submit-draft-lock-warning")).not.toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByLabelText("Choose version"),
      "ver-submitted",
    );
    expect(screen.queryByTestId("submit-draft-lock-warning")).not.toBeInTheDocument();
  });

  it("replaces empty selects with a create-resume path when no variants exist", async () => {
    listSubmittable.mockResolvedValue({ success: true, data: [] });
    render(<SubmitResumePicker attemptId="att-1" locked={false} onBound={vi.fn()} />);
    const empty = await screen.findByTestId("submit-resume-picker-empty");
    expect(empty).toHaveTextContent(
      "You don't have a resume version available to submit yet.",
    );
    expect(
      screen.getByRole("link", { name: "Create a resume" }),
    ).toHaveAttribute("href", "/dashboard/profile/resumes");
    expect(screen.queryByLabelText("Choose resume")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose version")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit-resume-picker")).not.toBeInTheDocument();
  });

  it("shows an open-resume path when the selected variant has no versions", async () => {
    listSubmittable.mockResolvedValue({
      success: true,
      data: [{ id: "var-1", name: "Campus", versions: [] }],
    });
    render(<SubmitResumePicker attemptId="att-1" locked={false} onBound={vi.fn()} />);
    await userEvent.selectOptions(
      await screen.findByLabelText("Choose resume"),
      "var-1",
    );
    expect(
      await screen.findByTestId("submit-resume-picker-no-versions"),
    ).toHaveTextContent("This resume has no version available to submit yet.");
    expect(screen.getByRole("link", { name: "Open resume" })).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1",
    );
    expect(screen.queryByLabelText("Choose version")).not.toBeInTheDocument();
  });

  it("keeps the archived historical timeline link pointing at the submitted version", async () => {
    const data: ApplicationTimelineDTO = {
      opportunityId: "job-1",
      attempts: [
        {
          id: "att-1",
          submittedAt: "2024-01-01T00:00:00.000Z",
          createdAt: "2024-01-01T00:00:00.000Z",
          currentStageCategory: "SUBMITTED",
          outcome: "ACTIVE",
          transferredFromAttemptId: null,
          transferredFrom: null,
          submittedResume: {
            id: "ver-sub",
            title: "Campus",
            versionNumber: 1,
            resumeVariantId: "var-archived",
            resumeVariantVersionId: "ver-sub",
          },
          steps: [],
        },
      ],
    };
    getTimeline.mockResolvedValue({ success: true, data });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    const link = await screen.findByTestId("view-submitted-resume-version");
    expect(link).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-archived?version=ver-sub",
    );
  });
});
