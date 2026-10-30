import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { normalizeTabVisibility } from "@/components/career/application-profile/careerProfileTabs";

const profileStore = {
  current: {
    fullName: "Lin Mu",
    email: "lin@example.com",
  } as Record<string, string | null>,
};

vi.mock("@/actions/applicationProfile.actions", () => ({
  getApplicationCandidateProfile: vi.fn(async () => ({
    success: true,
    data: { ...profileStore.current },
  })),
  updateApplicationCandidateProfile: vi.fn(
    async (input: Record<string, string | null>) => {
      Object.assign(profileStore.current, input);
      return { success: true, data: { ...profileStore.current } };
    },
  ),
  listApplicationMaterials: vi.fn().mockResolvedValue({
    success: true,
    data: [],
  }),
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

import { updateApplicationCandidateProfile } from "@/actions/applicationProfile.actions";

const mockedUpdate = updateApplicationCandidateProfile as unknown as ReturnType<
  typeof vi.fn
>;

function fieldInput(key: string) {
  return screen.getByTestId(`profile-field-${key}-input`);
}

function fieldStatus(key: string) {
  return screen.getByTestId(`profile-field-${key}-status`);
}

async function renderWorkspace() {
  render(<ApplicationProfileWorkspace />);
  await waitFor(() => expect(fieldInput("fullName")).toHaveValue("Lin Mu"));
}

describe("ApplicationProfileWorkspace per-field autosave", () => {
  beforeEach(() => {
    profileStore.current = {
      fullName: "Lin Mu",
      email: "lin@example.com",
    };
    mockedUpdate.mockImplementation(
      async (input: Record<string, string | null>) => {
        Object.assign(profileStore.current, input);
        return { success: true, data: { ...profileStore.current } };
      },
    );
  });

  it("commits a single field on blur and sends only that key", async () => {
    await renderWorkspace();
    fireEvent.change(fieldInput("fullName"), { target: { value: "Li Bai" } });
    fireEvent.blur(fieldInput("fullName"));

    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ fullName: "Li Bai" }),
    );
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(fieldStatus("fullName").textContent).toContain("Saved"),
    );
    // Sibling fields keep their own values: no group form is submitted.
    expect(fieldInput("email")).toHaveValue("lin@example.com");
  });

  it("clears a filled field to null on blur", async () => {
    await renderWorkspace();
    fireEvent.change(fieldInput("email"), { target: { value: "   " } });
    fireEvent.blur(fieldInput("email"));

    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ email: null }),
    );
    await waitFor(() => expect(fieldInput("email")).toHaveValue(""));
  });

  it("auto-saves after typing stops without requiring blur", async () => {
    await renderWorkspace();
    fireEvent.change(fieldInput("phone"), { target: { value: "13800138000" } });
    await waitFor(
      () => expect(mockedUpdate).toHaveBeenCalledWith({ phone: "13800138000" }),
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(fieldStatus("phone").textContent).toContain("Saved"),
    );
  });

  it("keeps the draft on failure and retries on demand", async () => {
    mockedUpdate.mockImplementationOnce(async () => ({
      success: false,
      message: "WRITE_FAILED",
    }));
    await renderWorkspace();
    fireEvent.change(fieldInput("email"), { target: { value: "draft@example.com" } });
    fireEvent.blur(fieldInput("email"));

    await waitFor(() =>
      expect(fieldStatus("email").textContent).toContain("Save failed"),
    );
    // The rejected draft stays in the input instead of reverting.
    expect(fieldInput("email")).toHaveValue("draft@example.com");
    expect(profileStore.current.email).toBe("lin@example.com");

    fireEvent.click(screen.getByTestId("profile-field-email-retry"));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).toHaveBeenLastCalledWith({ email: "draft@example.com" });
    await waitFor(() =>
      expect(fieldStatus("email").textContent).toContain("Saved"),
    );
  });

  it("retains a failed draft and retry when switching profile tabs", async () => {
    mockedUpdate.mockResolvedValueOnce({ success: false, message: "Failed" });
    await renderWorkspace();
    fireEvent.change(fieldInput("email"), { target: { value: "draft@example.com" } });
    fireEvent.blur(fieldInput("email"));
    await waitFor(() => expect(fieldStatus("email")).toHaveTextContent("Save failed"));

    fireEvent.mouseDown(screen.getByTestId("career-profile-tab-education"), { button: 0, ctrlKey: false });
    expect(fieldInput("email")).not.toBeVisible();
    fireEvent.mouseDown(screen.getByTestId("career-profile-tab-personal"), { button: 0, ctrlKey: false });
    expect(fieldInput("email")).toBeVisible();
    expect(fieldInput("email")).toHaveValue("draft@example.com");
    fireEvent.click(screen.getByTestId("profile-field-email-retry"));
    await waitFor(() => expect(fieldStatus("email")).toHaveTextContent("Saved"));
    expect(profileStore.current.email).toBe("draft@example.com");
  });

  it("keeps focus and waits for IME completion before saving", async () => {
    await renderWorkspace();
    const input = fieldInput("fullName");
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "林" }, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(input).toHaveFocus();
    expect(mockedUpdate).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.blur(input);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ fullName: "林" }));
  });

  it("serializes rapid consecutive commits and lands the final value", async () => {
    let resolveFirst!: (v: unknown) => void;
    mockedUpdate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async (input: Record<string, string | null>) => {
        Object.assign(profileStore.current, input);
        return { success: true, data: { ...profileStore.current } };
      });

    await renderWorkspace();
    fireEvent.change(fieldInput("fullName"), { target: { value: "A" } });
    fireEvent.blur(fieldInput("fullName"));

    // First save is in flight: the saving state is visible, not saved yet.
    await waitFor(() =>
      expect(fieldStatus("fullName").textContent).toContain("Saving"),
    );

    // A second commit while in flight only queues the latest draft.
    fireEvent.change(fieldInput("fullName"), { target: { value: "AB" } });
    fireEvent.blur(fieldInput("fullName"));

    await act(async () => {
      resolveFirst({
        success: true,
        data: { ...profileStore.current, fullName: "A" },
      });
    });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[0][0]).toEqual({ fullName: "A" });
    expect(mockedUpdate.mock.calls[1][0]).toEqual({ fullName: "AB" });
    await waitFor(() =>
      expect(fieldStatus("fullName").textContent).toContain("Saved"),
    );
    expect(fieldInput("fullName")).toHaveValue("AB");
    expect(profileStore.current.fullName).toBe("AB");
  });

  it("does not write when the draft already matches the saved value", async () => {
    await renderWorkspace();
    fireEvent.blur(fieldInput("fullName"));
    fireEvent.change(fieldInput("fullName"), { target: { value: "Lin Mu" } });
    fireEvent.blur(fieldInput("fullName"));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});
