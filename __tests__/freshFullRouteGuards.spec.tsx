// Retained URLs must not reopen deferred workflows under trusted fresh +
// full A+B: the server pages redirect before any legacy container mounts.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

const snapshot = vi.fn();

vi.mock("@/actions/career.runtime", () => ({
  getCareerRuntimeSnapshot: () => snapshot(),
}));

vi.mock("@/actions/profile.actions", () => ({
  getResumeList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getResumeById: vi.fn().mockResolvedValue({ data: { id: "resume-1" } }),
  getDefaultResumeId: vi.fn().mockResolvedValue("resume-1"),
}));

vi.mock("@/components/automations/AutomationContainer", () => ({
  AutomationContainer: () => <div data-testid="automation-container" />,
}));

vi.mock("@/components/automations/AutomationDetailContainer", () => ({
  AutomationDetailContainer: () => (
    <div data-testid="automation-detail-container" />
  ),
}));

vi.mock("@/components/profile/ResumeContainer", () => ({
  default: () => <div data-testid="resume-container" />,
}));

import AutomationsPage from "@/app/dashboard/automations/page";
import AutomationDetailPage from "@/app/dashboard/automations/[id]/page";
import ResumePage from "@/app/dashboard/profile/resume/[id]/page";
import { render, screen } from "@testing-library/react";

const FRESH_FULL = {
  mode: "AB_ENABLED",
  rolloutScope: "full",
  origin: "fresh",
  writeFamily: "ab",
};

const LEGACY = {
  mode: "LEGACY_ONLY",
  rolloutScope: "none",
  origin: "legacy",
  writeFamily: "legacy",
};

describe("deferred route guards under fresh + full", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.mockResolvedValue(FRESH_FULL);
  });

  it("redirects /dashboard/automations without mounting the container", async () => {
    await expect(AutomationsPage()).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard",
    );
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("redirects a retained /dashboard/automations/[id] link", async () => {
    await expect(
      AutomationDetailPage({ params: Promise.resolve({ id: "auto-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("redirects the legacy resume editor to the canonical variant list", async () => {
    await expect(
      ResumePage({ params: Promise.resolve({ id: "resume-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard/profile/resumes");
    expect(redirect).toHaveBeenCalledWith("/dashboard/profile/resumes");
  });
});

describe("the same routes outside fresh + full", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.mockResolvedValue(LEGACY);
  });

  it("renders the automations list for legacy users", async () => {
    const element = await AutomationsPage();
    render(element);
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("automation-container")).toBeInTheDocument();
  });

  it("renders automation details for legacy users", async () => {
    const element = await AutomationDetailPage({
      params: Promise.resolve({ id: "auto-1" }),
    });
    render(element);
    expect(redirect).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("automation-detail-container"),
    ).toBeInTheDocument();
  });

  it("renders the legacy resume editor for legacy users", async () => {
    const element = await ResumePage({
      params: Promise.resolve({ id: "resume-1" }),
    });
    render(element);
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("resume-container")).toBeInTheDocument();
  });
});
