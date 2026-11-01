import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Header from "@/components/Header";
import { masterPaths, opticalPaths } from "@/components/brand/geometry";

vi.mock("next/navigation", () => ({
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

describe("Header mobile brand entry", () => {
  it("shows the static 20px Optical mark inside the mobile sheet", async () => {
    render(<Header />);

    await userEvent.click(
      screen.getByRole("button", { name: "Toggle Menu" }),
    );

    // The brand link keeps its localized accessible name and 40px circle.
    const brandLink = screen.getByRole("link", { name: "Vocatrya" });
    expect(brandLink).toHaveClass("h-10", "w-10", "rounded-full", "bg-primary");

    const mark = brandLink.querySelector("svg[data-vocatrya-mark]");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("width", "20");
    expect(mark).toHaveAttribute("height", "20");
    expect(mark).toHaveAttribute("data-animated", "false");
    expect(mark).toHaveAttribute("aria-hidden", "true");

    // Optical geometry, not the Master set used at larger sizes.
    const paths = mark!.querySelectorAll("path");
    expect(paths).toHaveLength(opticalPaths.length);
    expect(paths[0]).toHaveAttribute("d", opticalPaths[0]);
    expect(paths[0]).not.toHaveAttribute("d", masterPaths[0]);
  });

  it("keeps the sheet navigation links and accessible names", async () => {
    render(<Header />);

    await userEvent.click(
      screen.getByRole("button", { name: "Toggle Menu" }),
    );

    expect(
      screen.getByRole("link", { name: "Dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
    expect(
      screen.getByRole("link", { name: "Jobs" }),
    ).toHaveAttribute("href", "/dashboard/myjobs");
  });
});
