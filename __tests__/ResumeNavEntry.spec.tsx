// UI-RC-RESUME-NAV: the resume variants entry moved out of settings into the
// primary navigation, ordered directly before Jobs, sharing the desktop
// sidebar and the narrow-screen sheet. It keeps the resume_v1 capability
// gate (hidden, not disabled) and owns its route prefix so the parent
// profile link no longer double-highlights on resume routes.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";
import { SIDEBAR_LINKS } from "@/lib/constants";
import Header, { getSidebarNavLabel } from "@/components/Header";
import NavLink from "@/components/NavLink";
import Sidebar from "@/components/Sidebar";
import { SidebarProvider } from "@/context/SidebarContext";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/dashboard"),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    approvalPending: false,
  }),
}));

const testUser = { id: "1", name: "Test User", email: "test@example.com" };

const renderSidebar = (pathname = "/dashboard", resumeV1Enabled = true) => {
  (usePathname as any).mockReturnValue(pathname);
  return render(
    <CareerSurfacesProvider
      freshNativeFull={false}
      resumeV1Enabled={resumeV1Enabled}
    >
      <SidebarProvider initialExpanded>
        <Sidebar user={testUser} signOutAction={() => {}} />
      </SidebarProvider>
    </CareerSurfacesProvider>,
  );
};

describe("resume variants primary nav entry", () => {
  it("sits directly before Jobs in the shared link list", () => {
    const routes = SIDEBAR_LINKS.map((item) => item.route);
    const resumesIndex = routes.indexOf("/dashboard/profile/resumes");
    const jobsIndex = routes.indexOf("/dashboard/myjobs");
    expect(resumesIndex).toBeGreaterThan(-1);
    expect(jobsIndex).toBe(resumesIndex + 1);
  });

  it("maps its route to the resume variants title, not the profile label", () => {
    expect(
      getSidebarNavLabel(
        "/dashboard/profile/resumes",
        "Resume Variants",
        (key) => key,
      ),
    ).toBe("resumeVariants.title");
  });

  it("still maps the bare profile route to the profile label", () => {
    expect(
      getSidebarNavLabel("/dashboard/profile", "Profile", (key) => key),
    ).toBe("nav.profile");
  });
});

describe("resume variants in the desktop sidebar", () => {
  beforeEach(() => {
    (usePathname as any).mockReturnValue("/dashboard");
  });

  it("renders the entry when the resume capability is on", () => {
    renderSidebar();
    expect(
      screen.getByRole("link", { name: "Resume Variants" }),
    ).toHaveAttribute("href", "/dashboard/profile/resumes");
  });

  it("hides the entry when the resume capability is off", () => {
    renderSidebar("/dashboard", false);
    expect(
      screen.queryByRole("link", { name: "Resume Variants" }),
    ).not.toBeInTheDocument();
  });

  it("marks only the resume variants link active on resume routes", () => {
    renderSidebar("/dashboard/profile/resumes");
    expect(
      screen.getByRole("link", { name: "Resume Variants" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Application Profile" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("keeps the resume variants link active on a nested variant route", () => {
    renderSidebar("/dashboard/profile/resumes/variant-1");
    expect(
      screen.getByRole("link", { name: "Resume Variants" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Application Profile" }),
    ).not.toHaveAttribute("aria-current");
  });
});

describe("resume variants in the narrow-screen sheet", () => {
  const openSheet = async (resumeV1Enabled = true) => {
    const user = userEvent.setup();
    render(
      <CareerSurfacesProvider
        freshNativeFull={false}
        resumeV1Enabled={resumeV1Enabled}
      >
        <Header />
      </CareerSurfacesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Toggle Menu" }));
  };

  it("shows the entry between Analytics and Jobs", async () => {
    await openSheet();
    const resumes = screen.getByRole("link", { name: "Resume Variants" });
    expect(resumes).toHaveAttribute("href", "/dashboard/profile/resumes");
    const links = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(links.indexOf("/dashboard/profile/resumes")).toBe(
      links.indexOf("/dashboard/myjobs") - 1,
    );
  });

  it("hides the entry when the resume capability is off", async () => {
    await openSheet(false);
    expect(
      screen.queryByRole("link", { name: "Resume Variants" }),
    ).not.toBeInTheDocument();
  });
});

describe("profile link active exclusion", () => {
  const renderProfileLink = (pathname: string) =>
    render(
      <TooltipProvider>
        <NavLink
          label="Profile"
          Icon={UserRound}
          route="/dashboard/profile"
          pathname={pathname}
          expanded
          activeExcludePrefix="/dashboard/profile/resumes"
        />
      </TooltipProvider>,
    );

  it("stays active on the profile page itself", () => {
    renderProfileLink("/dashboard/profile");
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("stays active on other profile subroutes", () => {
    renderProfileLink("/dashboard/profile/application");
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not double-highlight on the excluded resume routes", () => {
    renderProfileLink("/dashboard/profile/resumes");
    expect(
      screen.getByRole("link", { name: "Profile" }),
    ).not.toHaveAttribute("aria-current");
  });
});
