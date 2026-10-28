// Settings host shell: five nav groups with twelve entries, `general` as the
// default page, owner components mounted per section, honest unavailable
// states for pages whose components have not landed, and the legacy MCP /
// Interview compat surfaces kept reachable in their new homes.
import * as React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "@/app/dashboard/settings/page";
import SettingsDrawer from "@/components/settings/SettingsDrawer";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";

vi.mock("@/components/admin/AdminTabsContainer", () => ({
  default: () => <div data-testid="dictionary-settings" />,
}));

vi.mock("@/components/career/resume-variant/ResumeVariantList", () => ({
  ResumeVariantList: () => <div data-testid="resume-variants-settings" />,
}));

vi.mock("@/components/settings/GeneralSettings", () => ({
  default: () => <div data-testid="general-settings" />,
}));
vi.mock("@/components/settings/ManagedAiCard", () => ({
  default: () => <div data-testid="managed-ai-card" />,
}));
vi.mock("@/components/settings/AiConnectionsCard", () => ({
  default: () => <div data-testid="ai-connections-card" />,
}));
vi.mock("@/components/settings/ByokConnectionsCard", () => ({
  default: () => <div data-testid="byok-connections-card" />,
}));
vi.mock("@/components/settings/AiAssignmentsCard", () => ({
  default: () => <div data-testid="ai-assignments-card" />,
}));
vi.mock("@/components/settings/InterviewAiSettings", () => ({
  default: () => <div data-testid="interview-ai-settings" />,
}));
vi.mock("@/components/settings/DataSettings", () => ({
  default: () => <div data-testid="data-settings" />,
}));
vi.mock("@/components/settings/DisplaySettings", () => ({
  default: () => <div data-testid="display-settings" />,
}));
vi.mock("@/components/settings/McpAccessSettings", () => ({
  default: () => <div data-testid="mcp-settings" />,
}));
vi.mock("@/components/settings/NotificationsSettings", () => ({
  default: () => <div data-testid="notifications-settings" />,
}));
vi.mock("@/components/settings/ShortcutsSettings", () => ({
  default: () => <div data-testid="shortcuts-settings" />,
}));
vi.mock("@/components/settings/AudioSettings", () => ({
  default: () => <div data-testid="audio-settings" />,
}));
vi.mock("@/components/settings/InputPreferencesSettings", () => ({
  default: () => <div data-testid="input-preferences-settings" />,
}));
vi.mock("@/components/settings/AboutSettings", () => ({
  default: () => <div data-testid="about-settings" />,
}));

const NAV = "settings-nav";
const EXPECTED_SECTION_ORDER = [
  "General",
  "Notifications",
  "Appearance",
  "AI Services",
  "AI Assignments",
  "Shortcuts",
  "Audio",
  "Input Preferences",
  "Bulk Edit",
  "Resume Variants",
  "Data & Privacy",
  "About",
];

function navButtons() {
  return within(screen.getByTestId(NAV)).getAllByRole("button");
}

describe("Settings page — V1 navigation shell", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/dashboard/settings");
  });

  it("renders twelve sections in five groups", () => {
    render(<Settings />);
    const names = navButtons().map((button) => button.textContent);
    expect(names).toEqual(EXPECTED_SECTION_ORDER);
    for (const group of [
      "Preferences",
      // settings.ai already exists in the locale bundles as "AI Configuration".
      "AI Configuration",
      "Devices & Input",
      "Career Management",
      "Data & Support",
    ]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
  });

  it("opens on the general section by default", async () => {
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId("general-settings")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "General" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("mounts the dictionary under Career Management and preserves its tab when switching sections", async () => {
    window.history.replaceState(null, "", "/dashboard/settings?section=dictionary&tab=skills");
    render(<Settings />);
    expect(await screen.findByTestId("dictionary-settings")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Career Management" })).getByRole("button", { name: "Bulk Edit" })).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    expect(window.location.hash).toBe("#general");
    expect(new URLSearchParams(window.location.search).has("section")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("skills");
    await userEvent.click(screen.getByRole("button", { name: "Bulk Edit" }));
    expect(screen.getByTestId("dictionary-settings")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("section")).toBe("dictionary");
  });

  it("mounts the resume variants list under Career Management when the capability is on", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole("button", { name: "Resume Variants" }));
    expect(screen.getByTestId("resume-variants-settings")).toBeInTheDocument();
  });

  it("shows an honest unavailable state for resume variants when the capability is off", async () => {
    const user = userEvent.setup();
    render(
      <CareerSurfacesProvider freshNativeFull={false} resumeV1Enabled={false}>
        <Settings />
      </CareerSurfacesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Resume Variants" }));
    expect(screen.getByTestId("settings-section-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-variants-settings")).not.toBeInTheDocument();
  });

  it("splits AI connections and business assignments onto different pages", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole("button", { name: "AI Services" }));
    expect(screen.getByTestId("managed-ai-card")).toBeInTheDocument();
    expect(screen.getByTestId("ai-connections-card")).toBeInTheDocument();
    expect(screen.getByTestId("byok-connections-card")).toBeInTheDocument();
    // Connection management and business assignment stay separate concepts:
    // no assignment surface on the services page, no connection cards on the
    // assignments page.
    expect(
      screen.queryByTestId("ai-assignments-card"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("interview-ai-settings"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI Assignments" }));
    expect(screen.getByTestId("ai-assignments-card")).toBeInTheDocument();
    // The legacy interview provider/model entry stays reachable as the compat
    // surface inside the AI business page.
    expect(screen.getByTestId("interview-ai-settings")).toBeInTheDocument();
    expect(
      screen.queryByTestId("ai-connections-card"),
    ).not.toBeInTheDocument();
  });

  it("keeps the legacy MCP surface inside Data & Privacy", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole("button", { name: "Data & Privacy" }));
    expect(screen.getByTestId("data-settings")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-settings")).toBeInTheDocument();
  });

  it("hides the MCP compat surface on fresh-native installs", async () => {
    const user = userEvent.setup();
    render(
      <CareerSurfacesProvider freshNativeFull={true}>
        <Settings />
      </CareerSurfacesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Data & Privacy" }));
    expect(screen.getByTestId("data-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-settings")).not.toBeInTheDocument();
  });

  it.each([
    ["Notifications", "notifications-settings"],
    ["Shortcuts", "shortcuts-settings"],
    ["Audio", "audio-settings"],
    ["Input Preferences", "input-preferences-settings"],
    ["About", "about-settings"],
  ] as const)(
    "the %s entry mounts its delivered owner component",
    async (name, testId) => {
      const user = userEvent.setup();
      render(<Settings />);
      await user.click(screen.getByRole("button", { name }));
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(
        screen.queryByTestId("settings-section-unavailable"),
      ).not.toBeInTheDocument();
      // Nav still works afterwards.
      await user.click(screen.getByRole("button", { name: "General" }));
      await waitFor(() =>
        expect(screen.getByTestId("general-settings")).toBeInTheDocument(),
      );
    },
  );

  it("marks the selected entry with aria-current, not only styling", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    expect(
      screen.getByRole("button", { name: "Appearance" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "General" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("walks the nav with the keyboard in DOM order", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    screen.getByRole("button", { name: "General" }).focus();
    for (const name of EXPECTED_SECTION_ORDER.slice(1)) {
      await user.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
  });

  it("honors a section hash deep link", async () => {
    window.location.hash = "#ai-assignments";
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-assignments-card")).toBeInTheDocument(),
    );
    window.location.hash = "";
  });

  it("honors a ?section= deep link", async () => {
    window.history.replaceState(null, "", "/dashboard/settings?section=audio");
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings-section-audio")).toBeInTheDocument(),
    );
    window.history.replaceState(null, "", "/dashboard/settings");
  });

  it("follows same-document hashchange navigation", async () => {
    render(<Settings />);
    window.location.hash = "#data-privacy";
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("data-settings")).toBeInTheDocument(),
    );
    window.location.hash = "";
  });
});

describe("SettingsDrawer", () => {
  function DrawerHarness({
    dirty,
    onDiscard,
  }: {
    dirty: boolean;
    onDiscard?: () => void;
  }) {
    const [open, setOpen] = React.useState(true);
    return (
      <SettingsDrawer
        open={open}
        onOpenChange={setOpen}
        title="Connection details"
        hasUnsavedChanges={dirty}
        onDiscard={onDiscard}
      >
        <div data-testid="drawer-body" />
      </SettingsDrawer>
    );
  }

  it("renders title and content while open", () => {
    render(<DrawerHarness dirty={false} />);
    expect(screen.getByText("Connection details")).toBeInTheDocument();
    expect(screen.getByTestId("drawer-body")).toBeInTheDocument();
  });

  it("closes directly when there are no unsaved changes", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness dirty={false} />);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("drawer-body")).not.toBeInTheDocument(),
    );
  });

  it("guards Esc and the close button while unsaved changes exist", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    render(<DrawerHarness dirty={true} onDiscard={onDiscard} />);
    await user.keyboard("{Escape}");
    // Drawer stays open and the confirm dialog appears instead of closing.
    expect(screen.getByTestId("drawer-body")).toBeInTheDocument();
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();

    // Keep editing returns to the drawer without discarding.
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Discard unsaved changes?"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("drawer-body")).toBeInTheDocument();
    expect(onDiscard).not.toHaveBeenCalled();

    // Confirming discards and closes.
    await user.keyboard("{Escape}");
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("drawer-body")).not.toBeInTheDocument(),
    );
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("guards the X close button the same way", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness dirty={true} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("drawer-body")).toBeInTheDocument();
  });
});
