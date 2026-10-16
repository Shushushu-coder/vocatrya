import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import { Briefcase } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import NavLink from "@/components/NavLink";
import { SidebarProvider } from "@/context/SidebarContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_CONSTANTS } from "@/lib/constants";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/dashboard"),
}));

const testUser = { id: "1", name: "Test User", email: "test@example.com" };

const renderSidebar = () =>
  render(
    <SidebarProvider initialExpanded>
      <Sidebar user={testUser} signOutAction={() => {}} />
    </SidebarProvider>
  );

describe("NavLink - active state", () => {
  const renderNavLink = (route: string, pathname: string) =>
    render(
      <TooltipProvider>
        <NavLink
          label="Jobs"
          Icon={Briefcase}
          route={route}
          pathname={pathname}
          expanded
        />
      </TooltipProvider>
    );

  it("marks the link active on an exact route match", () => {
    renderNavLink("/dashboard/myjobs", "/dashboard/myjobs");

    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
  });

  it("marks the link active on a nested route", () => {
    renderNavLink("/dashboard/myjobs", "/dashboard/myjobs/job-123");

    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
  });

  // "/dashboard" is a prefix of every other route, so it must not match them.
  it("does not mark the dashboard link active on other pages", () => {
    renderNavLink("/dashboard", "/dashboard/myjobs");

    expect(screen.getByRole("link")).not.toHaveAttribute("aria-current");
  });

  it("does not match a route that is only a string prefix", () => {
    renderNavLink("/dashboard/job", "/dashboard/jobs");

    expect(screen.getByRole("link")).not.toHaveAttribute("aria-current");
  });
});

describe("NavLink - label rendering", () => {
  const renderNavLink = (expanded: boolean) =>
    render(
      <TooltipProvider>
        <NavLink
          label="Jobs"
          Icon={Briefcase}
          route="/dashboard/myjobs"
          pathname="/dashboard"
          expanded={expanded}
        />
      </TooltipProvider>
    );

  it("shows a visible label when expanded", () => {
    renderNavLink(true);

    expect(screen.getByText("Jobs")).not.toHaveClass("sr-only");
  });

  // The icon sits in a fixed-width lead box, so the label can stay in
  // flow and just fade out instead of needing sr-only positioning.
  it("fades the label out visually when collapsed", () => {
    renderNavLink(false);

    expect(screen.getByText("Jobs")).toHaveClass("opacity-0");
  });

  it("keeps an accessible name in both states", () => {
    const { unmount } = renderNavLink(false);
    expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
    unmount();

    renderNavLink(true);
    expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
  });
});

describe("Sidebar", () => {
  beforeEach(() => {
    document.cookie = `${APP_CONSTANTS.SIDEBAR_STORAGE_KEY}=; path=/; max-age=0`;
    (usePathname as any).mockReturnValue("/dashboard");
  });

  it("renders a link for each nav item", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute(
      "href",
      "/dashboard/myjobs"
    );
  });

  it("exposes help, settings, and the account menu in the footer", async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByText(testUser.email)).toBeInTheDocument();

    // Settings is a real route entry in the footer, not a nested menu item.
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings"
    );

    // Help opens the existing support dialog rather than a dead link.
    await user.click(screen.getByRole("button", { name: "Help & feedback" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(
      await screen.findByRole("menuitem", { name: "Logout" })
    ).toBeInTheDocument();
  });

  it("marks the current page with aria-current", () => {
    (usePathname as any).mockReturnValue("/dashboard/tasks");

    renderSidebar();

    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      screen.getByRole("link", { name: "Dashboard" })
    ).not.toHaveAttribute("aria-current");
  });

  it("uses the static logo to collapse and expand with mouse and keyboard", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const sidebar = within(screen.getByRole("complementary"));
    const logo = sidebar.getByRole("button", { name: "Collapse sidebar" });
    expect(logo.querySelector("svg")).toHaveAttribute("data-animated", "false");
    await user.click(logo);
    expect(logo).toHaveAttribute("aria-expanded", "false");
    expect(logo).toHaveAccessibleName("Expand sidebar");
    expect(document.cookie).toContain(`${APP_CONSTANTS.SIDEBAR_STORAGE_KEY}=false`);
    logo.focus();
    await user.keyboard("{Enter}");
    expect(logo).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(logo).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Sidebar edge resize handle", () => {
  const handle = () => screen.getByTestId("sidebar-resize-handle");

  beforeEach(() => {
    document.cookie = `${APP_CONSTANTS.SIDEBAR_STORAGE_KEY}=; path=/; max-age=0`;
    document.cookie = `${APP_CONSTANTS.SIDEBAR_WIDTH_STORAGE_KEY}=; path=/; max-age=0`;
    (usePathname as any).mockReturnValue("/dashboard");
  });

  it("collapses when dragged below the threshold and re-expands from the rail", async () => {
    renderSidebar();
    const aside = screen.getByRole("complementary");
    expect(aside).toHaveStyle({ width: "224px" });

    // Dragging the edge left past the collapse threshold snaps to the rail.
    fireEvent.mouseDown(handle(), { clientX: 224 });
    fireEvent.mouseMove(document, { clientX: 60 });
    fireEvent.mouseUp(document);
    expect(aside).toHaveStyle({ width: "56px" });

    // From the collapsed rail, dragging right past the threshold re-expands.
    fireEvent.mouseDown(handle(), { clientX: 56 });
    fireEvent.mouseMove(document, { clientX: 256 });
    fireEvent.mouseUp(document);
    expect(aside).toHaveStyle({ width: "256px" });
  });

  it("resizes with ArrowLeft/ArrowRight and collapses at the threshold", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const aside = screen.getByRole("complementary");

    handle().focus();
    await user.keyboard("{ArrowLeft}");
    expect(aside).toHaveStyle({ width: "208px" });

    for (let i = 0; i < 8; i++) await user.keyboard("{ArrowLeft}");
    expect(aside).toHaveStyle({ width: "56px" });

    await user.keyboard("{ArrowRight}");
    expect(aside).toHaveStyle({ width: "224px" });
  });

  it("persists the width as a cookie after a keyboard resize", async () => {
    const user = userEvent.setup();
    renderSidebar();

    handle().focus();
    await user.keyboard("{ArrowLeft}");

    expect(document.cookie).toContain(
      `${APP_CONSTANTS.SIDEBAR_WIDTH_STORAGE_KEY}=208`
    );
  });

  it("double-clicking the edge toggles the rail", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const aside = screen.getByRole("complementary");

    await user.dblClick(handle());
    expect(aside).toHaveStyle({ width: "56px" });
    await user.dblClick(handle());
    expect(aside).toHaveStyle({ width: "224px" });
  });
});
