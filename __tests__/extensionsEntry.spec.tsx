// EXT-INTERVIEW-WEB + unified extension-tools entry: nav registration and
// desktop-hiding of the retired practice entry, the three-card list with
// real routes, the interview URL contract (unified config, https-only, no
// guesses), and the desktop compat guidance that replaces the built-in
// practice UI inside the Electron shell.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import ExtensionsPage from "@/app/dashboard/extensions/page";
import InterviewLayout from "@/app/dashboard/interview/layout";
import {
  getInterviewPracticeUrl,
  INTERVIEW_PRACTICE_URL_ENV,
} from "@/lib/extensions/interviewPractice";
import { SIDEBAR_LINKS } from "@/lib/constants";
import Header, { getSidebarNavLabel } from "@/components/Header";
import NavLink from "@/components/NavLink";
import { TooltipProvider } from "@/components/ui/tooltip";
import JourneySection from "@/components/dashboard/JourneySection";
import { MessagesSquare } from "lucide-react";
import { getNotionExtensionState } from "@/lib/extensions/notion/service";
import { getAutoApplyExtensionStatus } from "@/lib/extensions/autoApply/status";

vi.mock("@/utils/user.utils", () => ({ getCurrentUser: async () => ({ id: "extensions-user" }) }));
vi.mock("@/lib/extensions/autoApply/status", () => ({ getAutoApplyExtensionStatus: vi.fn(async () => ({ available: true, connections: { active: 0 } })) }));
vi.mock("@/lib/extensions/notion/service", () => ({ getNotionExtensionState: vi.fn(async () => ({ status: "DISCONNECTED" })) }));

vi.mock("@/i18n/server", () => ({
  getServerI18n: async () => ({
    t: (key: string) => key,
    formatDate: () => "",
    locale: "en",
  }),
}));

// JourneySection/Header are client components on the client i18n provider.
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/GlobalActions", () => ({
  CreateMenu: () => null,
}));
vi.mock("@/context/CareerSurfacesContext", () => ({
  useCareerSurfaces: () => ({
    freshNativeFull: false,
    jobMutationsEnabled: true,
    resumeV1Enabled: true,
    legacyResumeMutationsEnabled: true,
  }),
}));
vi.mock("@/i18n", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/i18n")>();
  return {
    ...mod,
    useI18n: () => ({
      locale: "en",
      t: (key: string) => key,
      formatDate: () => "",
      formatMonthYear: () => "",
      formatDateTime: () => "",
      formatNumber: () => "",
    }),
  };
});

describe("getInterviewPracticeUrl", () => {
  it("returns null when unset, blank, malformed, non-HTTPS, or credentialed", () => {
    expect(getInterviewPracticeUrl({})).toBeNull();
    for (const raw of [
      "",
      "   ",
      "not-a-url",
      "http://practice.example.com",
      "ftp://practice.example.com",
      "javascript:alert(1)",
      "https://user:pass@practice.example.com",
    ]) {
      expect(
        getInterviewPracticeUrl({ [INTERVIEW_PRACTICE_URL_ENV]: raw }),
      ).toBeNull();
    }
  });

  it("returns the configured https address unchanged", () => {
    expect(
      getInterviewPracticeUrl({
        [INTERVIEW_PRACTICE_URL_ENV]: " https://practice.example.com/app ",
      }),
    ).toBe("https://practice.example.com/app");
  });
});

describe("extensions navigation", () => {
  it("registers a persistent nav entry with a mapped label", () => {
    const item = SIDEBAR_LINKS.find(
      (entry) => entry.route === "/dashboard/extensions",
    );
    expect(item).toBeTruthy();
    expect(
      getSidebarNavLabel("/dashboard/extensions", "Extensions", (k) => k),
    ).toBe("nav.extensions");
  });

  it("keeps the interview entry in web nav but flags it desktop-hidden", () => {
    const item = SIDEBAR_LINKS.find(
      (entry) => entry.route === "/dashboard/interview",
    );
    expect(item).toBeTruthy();
    expect(item?.desktopHidden).toBe(true);
  });

  it("passes the desktop-hidden gate through the sidebar link", () => {
    render(
      <TooltipProvider>
        <NavLink
          label="Interview"
          Icon={MessagesSquare}
          route="/dashboard/interview"
          pathname="/dashboard"
          expanded
          className="desktop-hidden"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("link", { name: "Interview" })).toHaveClass(
      "desktop-hidden",
    );
  });

  it("highlights the extensions nav entry on its routes", () => {
    render(
      <TooltipProvider>
        <NavLink
          label="Extensions"
          Icon={MessagesSquare}
          route="/dashboard/extensions"
          pathname="/dashboard/extensions/auto-apply"
          expanded
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("link", { name: "Extensions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("carries the same desktop gate into the mobile sheet navigation", async () => {
    render(<Header />);
    await userEvent.click(
      screen.getByRole("button", { name: "nav.toggleMenu" }),
    );
    const interview = screen.getByRole("link", { name: "nav.interview" });
    expect(interview).toHaveAttribute("href", "/dashboard/interview");
    expect(interview).toHaveClass("desktop-hidden");
    const extensions = screen.getByRole("link", { name: "nav.extensions" });
    expect(extensions).toHaveAttribute("href", "/dashboard/extensions");
    expect(extensions).not.toHaveClass("desktop-hidden");
  });
});

describe("JourneySection desktop gating", () => {
  it("keeps the practice entry routed but marks it desktop-hidden", () => {
    render(<JourneySection jobsAbRead />);
    const practice = screen.getByTestId("journey-entry-review-practice");
    expect(practice).toHaveAttribute("href", "/dashboard/interview");
    expect(practice).toHaveClass("desktop-hidden");
    expect(
      screen.getByTestId("journey-entry-review-reflection"),
    ).not.toHaveClass("desktop-hidden");
  });
});

describe("extensions page", () => {
  const saved = process.env[INTERVIEW_PRACTICE_URL_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[INTERVIEW_PRACTICE_URL_ENV];
    else process.env[INTERVIEW_PRACTICE_URL_ENV] = saved;
  });

  it("renders the three equal-width tool cards with real detail routes", async () => {
    delete process.env[INTERVIEW_PRACTICE_URL_ENV];
    render(await ExtensionsPage());
    expect(
      screen.getByRole("heading", { name: "extensions.title" }),
    ).toBeInTheDocument();
    for (const id of [
      "extensions-card-auto-apply",
      "extensions-card-notion",
      "extensions-card-interview",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // Equal-width tracks that wrap instead of overflowing on narrow widths.
    expect(screen.getByTestId("extensions-list")).toHaveClass(
      "grid-cols-1",
      "@md/main:grid-cols-2",
      "@3xl/main:grid-cols-3",
    );
    expect(
      screen.getByRole("link", { name: "extensions.autoApply.cta" }),
    ).toHaveAttribute("href", "/dashboard/extensions/auto-apply");
    expect(
      screen.getByRole("link", { name: "extensions.notion.cta" }),
    ).toHaveAttribute("href", "/dashboard/extensions/notion");
  });

  it("marks interview practice unavailable without a configured URL — no jump", async () => {
    delete process.env[INTERVIEW_PRACTICE_URL_ENV];
    render(await ExtensionsPage());
    expect(
      screen.getByTestId("extensions-interview-status"),
    ).toHaveTextContent("extensions.interview.unavailable");
    expect(
      screen.getByTestId("extensions-interview-cta"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: /extensions\.interview\.cta/ }),
    ).toBeNull();
  });

  it("uses real connected status and manages an existing Notion connection", async () => {
    vi.mocked(getNotionExtensionState).mockResolvedValueOnce({ status: "CONNECTED" } as never);
    render(await ExtensionsPage());
    expect(screen.getByTestId("extensions-notion-status")).toHaveTextContent("Connected");
    expect(screen.getByTestId("extensions-notion-cta")).toHaveTextContent("extensions.notion.manageCta");
    expect(screen.getByTestId("extensions-auto-apply-status")).toHaveTextContent("extensions.autoApply.available");
  });

  it("shows status failures without breaking the other tools", async () => {
    vi.mocked(getNotionExtensionState).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getAutoApplyExtensionStatus).mockResolvedValueOnce({ available: false } as never);
    render(await ExtensionsPage());
    expect(screen.getByTestId("extensions-notion-status")).toHaveTextContent("extensions.notion.statusError");
    expect(screen.getByTestId("extensions-auto-apply-status")).toHaveTextContent("extensions.autoApply.unavailable");
  });

  it("opens the configured HTTPS address in a safe new tab / external browser", async () => {
    process.env[INTERVIEW_PRACTICE_URL_ENV] = "https://practice.example.com/app";
    render(await ExtensionsPage());
    const cta = screen.getByRole("link", {
      name: /extensions\.interview\.cta/,
    });
    expect(cta).toHaveAttribute("href", "https://practice.example.com/app");
    expect(cta).toHaveAttribute("target", "_blank");
    expect(cta).toHaveAttribute(
      "rel",
      expect.stringContaining("noopener"),
    );
    expect(cta).toHaveAttribute(
      "rel",
      expect.stringContaining("noreferrer"),
    );
    expect(
      screen.getByTestId("extensions-interview-status"),
    ).toHaveTextContent("extensions.interview.ready");
  });

  it("rejects a non-HTTPS configured value the same as unset", async () => {
    process.env[INTERVIEW_PRACTICE_URL_ENV] = "http://practice.example.com";
    render(await ExtensionsPage());
    expect(
      screen.getByTestId("extensions-interview-status"),
    ).toHaveTextContent("extensions.interview.unavailable");
    expect(
      screen.getByTestId("extensions-interview-cta"),
    ).toBeDisabled();
  });
});

describe("interview routes on the desktop shell", () => {
  it("swaps the practice surface for guidance toward the extensions area", async () => {
    render(
      await InterviewLayout({
        children: <div data-testid="practice-child" />,
      }),
    );
    // Both variants render; the data-desktop CSS gate picks one per host —
    // the notice only inside Electron, the practice surface only on the web.
    expect(screen.getByTestId("interview-moved-notice")).toHaveClass(
      "desktop-only",
    );
    expect(screen.getByTestId("interview-practice-surface")).toHaveClass(
      "desktop-hidden",
    );
    expect(screen.getByTestId("practice-child")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "extensions.interviewMovedCta" }),
    ).toHaveAttribute("href", "/dashboard/extensions");
  });
});
