import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopTitleBar } from "@/components/desktop/DesktopTitleBar";
import { TitleBarActions } from "@/components/desktop/TitleBarActions";
import Header from "@/components/Header";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";

const chat = {
  isOpen: false,
  open: vi.fn(),
  close: vi.fn(),
  approvalPending: false,
};

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chat,
}));

// The Electron preload bridge: present only inside the real desktop shell,
// which is exactly the condition TitleBarActions gates its portals on.
function installDesktopShell() {
  Object.defineProperty(window, "vocatryaWindow", {
    value: { setTheme: vi.fn() },
    configurable: true,
  });
}

afterEach(() => {
  delete (window as { vocatryaWindow?: unknown }).vocatryaWindow;
});

function renderShell(freshNativeFull = false) {
  return render(
    <CareerSurfacesProvider freshNativeFull={freshNativeFull}>
      <DesktopTitleBar />
      <TitleBarActions />
    </CareerSurfacesProvider>
  );
}

// The real dashboard composition: the titlebar mounts at the root layout and
// its slot divs exist in every build, Header carries the web fallback row,
// and TitleBarActions decides whether the portaled copy exists at all.
function renderDashboardChrome() {
  return render(
    <CareerSurfacesProvider freshNativeFull={false}>
      <DesktopTitleBar />
      <TitleBarActions />
      <Header />
    </CareerSurfacesProvider>
  );
}

describe("TitleBarActions", () => {
  it("portals create, upload and assistant actions into the titlebar", async () => {
    installDesktopShell();
    renderShell();
    const titlebar = await screen.findByTestId("desktop-titlebar");

    const leftSlot = document.getElementById("desktop-titlebar-actions-left");
    const rightSlot = document.getElementById(
      "desktop-titlebar-actions-right"
    );
    expect(leftSlot).not.toBeNull();
    expect(rightSlot).not.toBeNull();

    expect(within(titlebar).getByTestId("header-create-menu")).toBeTruthy();
    expect(within(leftSlot!).getByTestId("header-create-menu")).toBeTruthy();
    expect(within(leftSlot!).getByTestId("header-upload")).toHaveAttribute(
      "href",
      "/dashboard/profile"
    );
    // 咨询 Vocatrya sits in the right slot, before the shortcut-help button.
    const assistant = within(rightSlot!).getByRole("button", {
      name: "Open assistant",
    });
    expect(assistant).toBeTruthy();
    expect(
      rightSlot!.compareDocumentPosition(
        screen.getByRole("button", { name: "Keyboard shortcuts" })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the slots empty when no dashboard mount provides actions", () => {
    installDesktopShell();
    render(<DesktopTitleBar />);
    expect(document.getElementById("desktop-titlebar-actions-left")).toBeEmptyDOMElement();
    expect(document.getElementById("desktop-titlebar-actions-right")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("header-create-menu")).toBeNull();
  });

  it("routes upload to the resumes surface under fresh + full", async () => {
    installDesktopShell();
    renderShell(true);
    const leftSlot = document.getElementById("desktop-titlebar-actions-left");
    expect(
      await within(leftSlot!).findByTestId("header-upload")
    ).toHaveAttribute("href", "/dashboard/profile/resumes");
  });

  it("opens the create menu from the titlebar trigger", async () => {
    installDesktopShell();
    const user = userEvent.setup();
    renderShell();
    const leftSlot = document.getElementById("desktop-titlebar-actions-left");
    await user.click(within(leftSlot!).getByTestId("header-create-menu"));
    expect(
      await screen.findByRole("menuitem", { name: "Job" })
    ).toHaveAttribute("href", "/dashboard/myjobs?add-job=true");
    expect(screen.getByRole("menuitem", { name: "Tasks" })).toHaveAttribute(
      "href",
      "/dashboard/tasks?add-task=true"
    );
    expect(
      screen.getByRole("menuitem", { name: "Activities" })
    ).toHaveAttribute("href", "/dashboard/activities?add-activity=true");
    expect(screen.getByRole("menuitem", { name: "Question" })).toHaveAttribute(
      "href",
      "/dashboard/questions?add-question=true"
    );
  });
});

describe("global actions uniqueness per shell", () => {
  it("renders exactly one set of global actions in the web build", async () => {
    renderDashboardChrome();

    // No preload bridge: the portaled copy must not exist, leaving only the
    // in-header fallback. A second match here is the strict-mode violation
    // that broke the dashboard E2E suite.
    expect(await screen.findAllByTestId("header-create-menu")).toHaveLength(1);
    expect(screen.getAllByTestId("header-upload")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Open assistant" })
    ).toHaveLength(1);

    expect(
      document.getElementById("desktop-titlebar-actions-left")
    ).toBeEmptyDOMElement();
    expect(
      document.getElementById("desktop-titlebar-actions-right")
    ).toBeEmptyDOMElement();
  });

  it("keeps the desktop build to one visible set: portals in the titlebar, fallback hidden by CSS", async () => {
    installDesktopShell();
    renderDashboardChrome();

    // The live set is inside the titlebar slots; the in-header copy stays in
    // the .header-global-actions container that html[data-desktop="true"]
    // hides, so the desktop never presents two toolbars.
    const titlebar = await screen.findByTestId("desktop-titlebar");
    expect(within(titlebar).getByTestId("header-create-menu")).toBeTruthy();
    expect(within(titlebar).getByTestId("header-upload")).toBeTruthy();
    expect(
      within(titlebar).getByRole("button", { name: "Open assistant" })
    ).toBeTruthy();

    const fallback = document.querySelector(".header-global-actions");
    expect(fallback).not.toBeNull();
    expect(
      within(fallback as HTMLElement).getByTestId("header-create-menu")
    ).toBeTruthy();
    expect(
      within(fallback as HTMLElement).getByTestId("header-upload")
    ).toBeTruthy();
  });
});
