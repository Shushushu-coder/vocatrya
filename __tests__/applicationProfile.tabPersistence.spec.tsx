import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { normalizeTabVisibility } from "@/components/career/application-profile/careerProfileTabs";

const INTERNSHIP_ITEM = {
  id: "m-1",
  type: "INTERNSHIP",
  title: "旧实习",
  notes: null,
  evidence: [],
  startDate: null,
  endDate: null,
  isCurrent: false,
  internshipDetail: { organizationName: "旧公司", roleTitle: "旧角色" },
};

vi.mock("@/actions/applicationProfile.actions", () => ({
  getApplicationCandidateProfile: vi.fn(async () => ({
    success: true,
    data: {},
  })),
  updateApplicationCandidateProfile: vi.fn(),
  listApplicationMaterials: vi.fn(),
  getApplicationProjection: vi.fn(),
  createApplicationMaterial: vi.fn(),
  updateApplicationMaterial: vi.fn(),
  archiveApplicationMaterial: vi.fn(),
  addApplicationMaterialEvidence: vi.fn(),
  getEmergencyContactOverview: vi.fn().mockResolvedValue({
    success: true,
    data: {
      hasData: false,
      maskedName: null,
      relation: null,
      maskedPhone: null,
      updatedAt: null,
    },
  }),
  revealEmergencyContact: vi.fn(),
  copyEmergencyContactField: vi.fn(),
  updateEmergencyContact: vi.fn(),
  getLocalDbPathDisplay: vi.fn().mockResolvedValue({
    success: true,
    data: { kind: "local-file", path: "/tmp/test.db" },
  }),
}));

vi.mock("@/actions/careerProfileTabs.actions", () => ({
  getCareerProfileTabVisibility: vi.fn(async () => ({
    success: true,
    data: normalizeTabVisibility(undefined),
  })),
  setCareerProfileTabVisible: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

import {
  listApplicationMaterials,
  updateApplicationMaterial,
} from "@/actions/applicationProfile.actions";
import { toastError } from "@/lib/toast";

type MockFn = ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function internshipPanel() {
  return within(screen.getByTestId("record-panel-internship"));
}

async function openInternshipTab() {
  render(<ApplicationProfileWorkspace />);
  fireEvent.click(screen.getByTestId("career-profile-tab-internship"));
  await waitFor(() =>
    expect(internshipPanel().getByText("旧实习")).toBeTruthy(),
  );
}

async function startEditingItem() {
  fireEvent.click(internshipPanel().getByText("Edit"));
  await waitFor(() =>
    expect(
      (internshipPanel().getByDisplayValue("旧实习") as HTMLInputElement).value,
    ).toBe("旧实习"),
  );
  fireEvent.change(internshipPanel().getByDisplayValue("旧实习"), {
    target: { value: "新实习" },
  });
}

describe("application profile record tabs keep edit state mounted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listApplicationMaterials as unknown as MockFn).mockResolvedValue({
      success: true,
      data: [INTERNSHIP_ITEM],
    });
  });

  it("failed material save survives a tab round-trip and the retry persists", async () => {
    (updateApplicationMaterial as unknown as MockFn)
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValue({ success: true });
    await openInternshipTab();
    await startEditingItem();

    fireEvent.click(internshipPanel().getByText("Save"));
    await waitFor(() => expect(updateApplicationMaterial).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("career-profile-tab-personal"));
    fireEvent.click(screen.getByTestId("career-profile-tab-internship"));

    // Draft, edit session (Cancel only renders while editing) and the failure
    // affordance are still there after the round-trip.
    expect(
      (internshipPanel().getByDisplayValue("新实习") as HTMLInputElement).value,
    ).toBe("新实习");
    expect(internshipPanel().getByText("Cancel")).toBeTruthy();

    fireEvent.click(internshipPanel().getByText("Save"));
    await waitFor(() =>
      expect(updateApplicationMaterial).toHaveBeenCalledTimes(2),
    );
    expect(updateApplicationMaterial).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "m-1", title: "新实习" }),
    );
    await waitFor(() =>
      expect(internshipPanel().queryByDisplayValue("新实习")).toBeNull(),
    );
  });

  it("an in-flight save cannot fork a second queue across tab switches", async () => {
    const pending = deferred<{ success: boolean }>();
    (updateApplicationMaterial as unknown as MockFn).mockReturnValueOnce(
      pending.promise,
    );
    await openInternshipTab();
    await startEditingItem();

    fireEvent.click(internshipPanel().getByText("Save"));
    await waitFor(() =>
      expect(internshipPanel().getByText("Saving...")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("career-profile-tab-personal"));
    fireEvent.click(screen.getByTestId("career-profile-tab-internship"));

    const savingButton = internshipPanel().getByText("Saving...");
    expect((savingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(savingButton);
    expect(updateApplicationMaterial).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    await waitFor(() =>
      expect(internshipPanel().queryByDisplayValue("新实习")).toBeNull(),
    );
    expect(updateApplicationMaterial).toHaveBeenCalledTimes(1);
  });
});
