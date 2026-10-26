import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import {
  CAREER_PROFILE_TAB_IDS,
  normalizeTabVisibility,
} from "@/components/career/application-profile/careerProfileTabs";

vi.mock("@/actions/applicationProfile.actions", () => ({
  getApplicationCandidateProfile: vi.fn().mockResolvedValue({
    success: true,
    data: { fullName: "Lin Mu", email: "lin@example.com" },
  }),
  listApplicationMaterials: vi.fn().mockResolvedValue({
    success: true,
    data: [
      {
        id: "m-award",
        type: "AWARD",
        title: "National Scholarship",
        notes: null,
        awardDetail: { issuer: "MOE" },
        evidence: [],
      },
      {
        id: "m-intern",
        type: "INTERNSHIP",
        title: "Summer Intern",
        notes: null,
        internshipDetail: { organizationName: "Acme", roleTitle: "Dev" },
        evidence: [],
      },
    ],
  }),
  updateApplicationCandidateProfile: vi.fn(),
  getApplicationProjection: vi.fn(),
  createApplicationMaterial: vi.fn(),
  updateApplicationMaterial: vi.fn(),
  archiveApplicationMaterial: vi.fn(),
  addApplicationMaterialEvidence: vi.fn(),
  getEmergencyContactOverview: vi.fn().mockResolvedValue({
    success: true,
    data: { hasData: false, maskedName: null, relation: null, maskedPhone: null, updatedAt: null },
  }),
  revealEmergencyContact: vi.fn(),
  copyEmergencyContactField: vi.fn(),
  updateEmergencyContact: vi.fn(),
  getLocalDbPathDisplay: vi.fn().mockResolvedValue({
    success: true,
    data: { kind: "local-file", path: "/tmp/test.db" },
  }),
}));

const tabVisibilityStore = {
  current: normalizeTabVisibility(undefined),
};

vi.mock("@/actions/careerProfileTabs.actions", () => ({
  getCareerProfileTabVisibility: vi.fn(async () => ({
    success: true,
    data: tabVisibilityStore.current,
  })),
  setCareerProfileTabVisible: vi.fn(
    async ({ tabId, visible }: { tabId: string; visible: boolean }) => {
      tabVisibilityStore.current = {
        ...tabVisibilityStore.current,
        [tabId]: visible,
      };
      return { success: true, data: tabVisibilityStore.current };
    },
  ),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

import { setCareerProfileTabVisible } from "@/actions/careerProfileTabs.actions";
import { listApplicationMaterials } from "@/actions/applicationProfile.actions";

const mockedSetVisible = setCareerProfileTabVisible as unknown as ReturnType<
  typeof vi.fn
>;

// Unwrapped useI18n falls back to English messages.
const EN_LABELS: Record<string, string> = {
  personal: "Personal info",
  education: "Education",
  internship: "Internships",
  project: "Projects",
  awards: "Awards",
  other: "Other",
  application: "Application materials",
};

describe("ApplicationProfileWorkspace seven tabs", () => {
  beforeEach(() => {
    tabVisibilityStore.current = normalizeTabVisibility(undefined);
  });

  it("renders the seven contract tabs and no global job-intent tab", async () => {
    render(<ApplicationProfileWorkspace />);
    for (const id of CAREER_PROFILE_TAB_IDS) {
      await waitFor(() =>
        expect(screen.getByTestId(`career-profile-tab-${id}`)).toBeVisible(),
      );
      expect(screen.getByTestId(`career-profile-tab-${id}`).textContent).toBe(
        EN_LABELS[id],
      );
    }
    expect(document.body.textContent).not.toContain("Job intent");
    expect(document.body.textContent).not.toContain("Target roles");
  });

  it("restores persisted hidden tabs on load", async () => {
    tabVisibilityStore.current = {
      ...normalizeTabVisibility(undefined),
      awards: false,
    };
    render(<ApplicationProfileWorkspace />);
    await waitFor(() =>
      expect(screen.getByTestId("career-profile-tab-personal")).toBeVisible(),
    );
    expect(
      screen.queryByTestId("career-profile-tab-awards"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("career-profile-tab-other")).toBeVisible();
  });

  it("blocks overlapping visibility saves so the last two tabs cannot both be hidden", async () => {
    tabVisibilityStore.current = {
      personal: true, education: false, internship: false, project: false,
      awards: true, other: false, application: false,
    };
    let finishSave!: (value: unknown) => void;
    mockedSetVisible.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
    render(<ApplicationProfileWorkspace />);
    await waitFor(() => expect(screen.queryByTestId("career-profile-tab-education")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Manage tabs" }));
    fireEvent.click(await screen.findByTestId("career-profile-tab-switch-awards"));
    const personalSwitch = screen.getByTestId("career-profile-tab-switch-personal");
    expect(personalSwitch).toBeDisabled();
    fireEvent.click(personalSwitch);
    expect(mockedSetVisible).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave({ success: true, data: { ...tabVisibilityStore.current, awards: false } });
    });
    expect(personalSwitch).toBeDisabled();
    expect(screen.getByTestId("career-profile-tab-switch-awards")).not.toBeDisabled();
    expect(screen.getByTestId("career-profile-tab-personal")).toBeVisible();
  });

  it("hides and re-shows a tab through the manager, persisting each toggle and keeping records", async () => {
    render(<ApplicationProfileWorkspace />);
    await waitFor(() =>
      expect(screen.getByTestId("career-profile-tab-awards")).toBeVisible(),
    );
    const initialMaterialCalls = (
      listApplicationMaterials as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Manage tabs" }));
    const awardsSwitch = await screen.findByTestId(
      "career-profile-tab-switch-awards",
    );
    fireEvent.click(awardsSwitch);

    await waitFor(() =>
      expect(mockedSetVisible).toHaveBeenCalledWith({
        tabId: "awards",
        visible: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("career-profile-tab-awards"),
      ).not.toBeInTheDocument(),
    );
    // Hiding a tab never touches stored records: no reload was needed and
    // the list action was not called again for the toggle.
    expect(
      (listApplicationMaterials as unknown as ReturnType<typeof vi.fn>).mock
        .calls.length,
    ).toBe(initialMaterialCalls);

    // Re-show from the same (still open) manager.
    const hiddenSwitch = await screen.findByTestId(
      "career-profile-tab-switch-awards",
    );
    fireEvent.click(hiddenSwitch);
    await waitFor(() =>
      expect(mockedSetVisible).toHaveBeenCalledWith({
        tabId: "awards",
        visible: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("career-profile-tab-awards")).toBeVisible(),
    );

    // Close the manager before switching tabs, as a user would.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // The record is still there once the tab is visible again. Radix tab
    // triggers activate on mousedown, not click.
    fireEvent.mouseDown(screen.getByTestId("career-profile-tab-awards"));
    await waitFor(() =>
      expect(screen.getByText("National Scholarship")).toBeVisible(),
    );
  });
});
