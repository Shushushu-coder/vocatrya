import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { toastError } from "@/lib/toast";

const SENTINEL = "SENSITIVE_COPY_SENTINEL";

vi.mock("@/actions/applicationProfile.actions", () => ({
  getApplicationCandidateProfile: vi.fn().mockResolvedValue({
    success: true,
    data: {
      fullName: "Lin Mu",
      email: "lin@example.com",
      phone: "13800138000",
      idNumber: "SENSITIVE_COPY_SENTINEL",
      emergencyContactPhone: "SENSITIVE_COPY_SENTINEL",
    },
  }),
  listApplicationMaterials: vi.fn().mockResolvedValue({
    success: true,
    data: [
      {
        id: "m-edu",
        type: "EDUCATION",
        title: "Fudan University",
        educationDetail: { institution: "Fudan", degree: "本科" },
        evidence: [],
      },
      {
        id: "m-intern",
        type: "INTERNSHIP",
        title: "Summer Intern",
        internshipDetail: { organizationName: "Acme", roleTitle: "Dev" },
        evidence: [],
      },
      {
        id: "m-legacy-job",
        type: "EMPLOYMENT",
        title: "Legacy Job",
        employmentDetail: { organizationName: "LegacyCo", roleTitle: "Ops" },
        evidence: [],
      },
      {
        id: "m-skill",
        type: "SKILL",
        title: "Python",
        skillDetail: { skillName: "Python", proficiency: "熟练" },
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
  getCareerProfileTabVisibility: vi
    .fn()
    .mockResolvedValue({ success: true, data: null }),
  setCareerProfileTabVisible: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const writeTextMock = () =>
  navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

function mockClipboard(impl?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: vi
        .fn()
        .mockImplementation(impl ?? (() => Promise.resolve())),
    },
    configurable: true,
  });
}

async function activateTab(testId: string) {
  // Radix tab triggers activate on mousedown, not click.
  fireEvent.mouseDown(await screen.findByTestId(testId));
}

describe("ApplicationProfileWorkspace tiered copy", () => {
  beforeEach(() => {
    mockClipboard();
  });

  it("copies the personal-info group as labeled lines, sensitive keys excluded", async () => {
    render(<ApplicationProfileWorkspace />);
    const button = await screen.findByTestId("personal-copy-group");
    fireEvent.click(button);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = writeTextMock().mock.calls[0][0] as string;
    expect(text).toContain("姓名：Lin Mu");
    expect(text).toContain("邮箱：lin@example.com");
    expect(text).toContain("电话：13800138000");
    // Whitelisted by construction: fields the profile payload carries but the
    // group copy must never emit (证件号、紧急联系人).
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("idNumber");
    expect(text).not.toContain("emergencyContact");
  });

  it("copies the read-only employment section inside the internship tab", async () => {
    render(<ApplicationProfileWorkspace />);
    await screen.findByTestId("personal-copy-group");
    await activateTab("career-profile-tab-internship");
    const button = await screen.findByTestId("readonly-copy-section");
    fireEvent.click(button);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = writeTextMock().mock.calls[0][0] as string;
    expect(text).toContain("Legacy Job");
    expect(text).toContain("LegacyCo");
    expect(text).not.toContain("Summer Intern");
  });

  it("copies the whole internship tab including read-only employment", async () => {
    render(<ApplicationProfileWorkspace />);
    await screen.findByTestId("personal-copy-group");
    await activateTab("career-profile-tab-internship");
    fireEvent.click(await screen.findByTestId("copy-tab-internship"));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = writeTextMock().mock.calls.at(-1)![0] as string;
    expect(text).toContain("Summer Intern");
    expect(text).toContain("Legacy Job");
    expect(text).not.toContain("Fudan University");
    expect(text).not.toContain(SENTINEL);
  });

  it("copies the full projection by default and honors deselected sections", async () => {
    render(<ApplicationProfileWorkspace />);
    await screen.findByTestId("personal-copy-group");
    await activateTab("career-profile-tab-application");

    const copySelected = await screen.findByTestId("projection-copy-selected");
    fireEvent.click(copySelected);
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    let text = writeTextMock().mock.calls.at(-1)![0] as string;
    expect(text).toContain("基本资料");
    expect(text).toContain("教育经历");
    expect(text).toContain("经历素材");
    expect(text).toContain("技能证书");
    expect(text).toContain("Lin Mu");
    expect(text).toContain("Fudan University");
    expect(text).toContain("Summer Intern");
    expect(text).toContain("Python");
    expect(text).not.toContain(SENTINEL);

    writeTextMock().mockClear();
    fireEvent.click(screen.getByTestId("projection-select-education"));
    fireEvent.click(screen.getByTestId("projection-copy-selected"));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    text = writeTextMock().mock.calls.at(-1)![0] as string;
    expect(text).toContain("基本资料");
    expect(text).toContain("技能证书");
    expect(text).toContain("Summer Intern");
    expect(text).not.toContain("教育经历");
    expect(text).not.toContain("Fudan University");
  });

  it("select-none disables the copy until a section is re-selected", async () => {
    render(<ApplicationProfileWorkspace />);
    await screen.findByTestId("personal-copy-group");
    await activateTab("career-profile-tab-application");

    const toggle = await screen.findByTestId("projection-select-toggle");
    expect(toggle.textContent).toBe("Select none");
    fireEvent.click(toggle);
    const copySelected = screen.getByTestId("projection-copy-selected");
    await waitFor(() => expect(copySelected).toBeDisabled());
    expect(toggle.textContent).toBe("Select all");

    fireEvent.click(screen.getByTestId("projection-select-skills"));
    await waitFor(() =>
      expect(
        screen.getByTestId("projection-copy-selected"),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("projection-copy-selected"));
    await waitFor(() => expect(writeTextMock()).toHaveBeenCalled());
    const text = writeTextMock().mock.calls.at(-1)![0] as string;
    expect(text).toContain("技能证书");
    expect(text).toContain("Python");
    expect(text).not.toContain("基本资料");
    expect(text).not.toContain("教育经历");
  });

  it("surfaces a real error toast when the clipboard write fails", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<ApplicationProfileWorkspace />);
    const button = await screen.findByTestId("personal-copy-group");
    fireEvent.click(button);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(writeTextMock()).toHaveBeenCalled();
  });
});
