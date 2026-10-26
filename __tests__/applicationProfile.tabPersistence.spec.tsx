import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { normalizeTabVisibility } from "@/components/career/application-profile/careerProfileTabs";

const DETAIL_KEY: Record<string, string> = {
  EDUCATION: "educationDetail",
  INTERNSHIP: "internshipDetail",
  PROJECT: "projectDetail",
  SKILL: "skillDetail",
  CERTIFICATION: "certificationDetail",
};

const materialStore = { current: [] as Record<string, unknown>[] };

vi.mock("@/actions/applicationProfile.actions", () => ({
  getApplicationCandidateProfile: vi.fn(async () => ({
    success: true,
    data: {},
  })),
  updateApplicationCandidateProfile: vi.fn(),
  listApplicationMaterials: vi.fn(async () => ({
    success: true,
    data: [...materialStore.current],
  })),
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

import { updateApplicationMaterial } from "@/actions/applicationProfile.actions";

const mockedUpdate = updateApplicationMaterial as unknown as ReturnType<
  typeof vi.fn
>;

function storeUpdate(
  input: { id: string } & Record<string, unknown>,
): { success: boolean; data: Record<string, unknown> | undefined } {
  const { id, detail, ...rest } = input;
  materialStore.current = materialStore.current.map((m) => {
    if (m.id !== id) return m;
    const next = { ...m, ...rest };
    if (detail && typeof detail === "object") {
      const rel = DETAIL_KEY[next.type as string];
      next[rel] = {
        ...((m[rel] as Record<string, unknown>) ?? {}),
        ...detail,
      };
    }
    return next;
  });
  return {
    success: true,
    data: materialStore.current.find((m) => m.id === id),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function field(id: string) {
  return screen.getByTestId(`${id}-input`) as HTMLInputElement;
}

function status(id: string) {
  return screen.getByTestId(`${id}-status`);
}

function internshipItem(): Record<string, unknown> {
  return {
    id: "m-1",
    type: "INTERNSHIP",
    title: "旧实习",
    notes: null,
    startDate: null,
    endDate: null,
    isCurrent: false,
    internshipDetail: { organizationName: "旧公司", roleTitle: "旧角色" },
    evidence: [],
  };
}

async function openInternshipTab() {
  render(<ApplicationProfileWorkspace />);
  fireEvent.click(screen.getByTestId("career-profile-tab-internship"));
  await screen.findByTestId("material-m-1-organizationName-input");
}

async function roundTripTabs() {
  fireEvent.click(screen.getByTestId("career-profile-tab-personal"));
  fireEvent.click(screen.getByTestId("career-profile-tab-internship"));
  await screen.findByTestId("material-m-1-organizationName-input");
}

describe("record tab persistence: autosave state survives tab switches", () => {
  beforeEach(() => {
    materialStore.current = [internshipItem()];
    vi.clearAllMocks();
    mockedUpdate.mockImplementation(async (input) => storeUpdate(input));
  });

  it("failed autosave keeps draft, error status and retry across a tab round-trip", async () => {
    mockedUpdate.mockImplementationOnce(async () => ({ success: false }));
    await openInternshipTab();

    const org = field("material-m-1-organizationName");
    fireEvent.change(org, { target: { value: "新公司" } });
    fireEvent.blur(org);
    await waitFor(() =>
      expect(status("material-m-1-organizationName").textContent).toContain(
        "Save failed",
      ),
    );

    await roundTripTabs();

    expect(field("material-m-1-organizationName")).toHaveValue("新公司");
    expect(status("material-m-1-organizationName").textContent).toContain(
      "Save failed",
    );
    const retry = screen.getByTestId("material-m-1-organizationName-retry");
    expect(retry).toBeTruthy();

    fireEvent.click(retry);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).toHaveBeenLastCalledWith({
      id: "m-1",
      detail: { organizationName: "新公司" },
    });
    await waitFor(() =>
      expect(status("material-m-1-organizationName").textContent).toContain(
        "Saved",
      ),
    );
    expect(
      (materialStore.current[0].internshipDetail as Record<string, unknown>)
        .organizationName,
    ).toBe("新公司");
  });

  it("an in-flight save stays serial across a round-trip and lands the latest draft", async () => {
    const pending = deferred<{ success: boolean; data?: unknown }>();
    mockedUpdate.mockImplementationOnce(() => pending.promise);
    await openInternshipTab();

    const org = field("material-m-1-organizationName");
    fireEvent.change(org, { target: { value: "A公司" } });
    fireEvent.blur(org);
    await waitFor(() =>
      expect(status("material-m-1-organizationName").textContent).toContain(
        "Saving",
      ),
    );
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // Round-trip while the request is still out, then keep editing the same
    // field: the queued commit must stay on the same serialized queue.
    await roundTripTabs();
    fireEvent.change(org, { target: { value: "B公司" } });
    fireEvent.blur(org);

    await act(async () => {
      pending.resolve({ success: true, data: { id: "m-1" } });
      await pending.promise;
    });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[0][0]).toEqual({
      id: "m-1",
      detail: { organizationName: "A公司" },
    });
    expect(mockedUpdate.mock.calls[1][0]).toEqual({
      id: "m-1",
      detail: { organizationName: "B公司" },
    });
    await waitFor(() =>
      expect(status("material-m-1-organizationName").textContent).toContain(
        "Saved",
      ),
    );
    expect(field("material-m-1-organizationName")).toHaveValue("B公司");
    expect(
      (materialStore.current[0].internshipDetail as Record<string, unknown>)
        .organizationName,
    ).toBe("B公司");
  });
});
