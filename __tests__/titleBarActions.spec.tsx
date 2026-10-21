import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopTitleBar } from "@/components/desktop/DesktopTitleBar";
import { TitleBarActions } from "@/components/desktop/TitleBarActions";
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

function renderShell(freshNativeFull = false) {
  return render(
    <CareerSurfacesProvider freshNativeFull={freshNativeFull}>
      <DesktopTitleBar />
      <TitleBarActions />
    </CareerSurfacesProvider>
  );
}

describe("TitleBarActions", () => {
  it("portals create, upload and assistant actions into the titlebar", async () => {
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
    render(<DesktopTitleBar />);
    expect(document.getElementById("desktop-titlebar-actions-left")).toBeEmptyDOMElement();
    expect(document.getElementById("desktop-titlebar-actions-right")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("header-create-menu")).toBeNull();
  });

  it("routes upload to the resumes surface under fresh + full", async () => {
    renderShell(true);
    const leftSlot = document.getElementById("desktop-titlebar-actions-left");
    expect(
      await within(leftSlot!).findByTestId("header-upload")
    ).toHaveAttribute("href", "/dashboard/profile/resumes");
  });

  it("opens the create menu from the titlebar trigger", async () => {
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
