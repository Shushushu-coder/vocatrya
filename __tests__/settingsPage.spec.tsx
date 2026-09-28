// Settings page convergence: the "AI 服务商" section is centered on the
// AIConnection surface, the legacy generic API provider/model picker and
// the API Keys panel are hidden from the normal settings flow, and no
// legacy "OpenAI API key not configured" style content can appear.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "@/app/dashboard/settings/page";

vi.mock("@/components/settings/AiConnectionsCard", () => ({
  default: () => <div data-testid="ai-connections-card" />,
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

describe("Settings page — AI provider section convergence", () => {
  it("the AI provider section shows connections, assignments and interview only", async () => {
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-connections-card")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ai-assignments-card")).toBeInTheDocument();
    expect(screen.getByTestId("interview-ai-settings")).toBeInTheDocument();
    // The legacy generic provider/model picker is gone from this page.
    expect(
      screen.queryByLabelText(/select ai (service )?provider/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/API key not configured/i),
    ).not.toBeInTheDocument();
  });

  it("the settings navigation no longer exposes a generic API Keys panel", () => {
    render(<Settings />);
    expect(screen.queryByText("API Keys")).not.toBeInTheDocument();
    // Sidebar section buttons that remain.
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("AI Provider")).toBeInTheDocument();
  });

  it("switching to another section replaces the AI connection surface", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-connections-card")).toBeInTheDocument(),
    );
    await user.click(screen.getByText("Appearance"));
    expect(screen.queryByTestId("ai-connections-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("display-settings")).toBeInTheDocument();
  });
});
