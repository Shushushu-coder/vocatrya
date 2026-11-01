import { render, screen } from "@testing-library/react";
import AuthCard from "@/components/auth/AuthCard";
import { masterPaths } from "@/components/brand/geometry";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// The forms carry the whole auth dependency chain; this spec only verifies the
// brand entry around them, so both are stubbed at the module boundary.
vi.mock("@/components/auth/SigninForm", () => ({
  default: () => <form data-testid="signin-form" />,
}));
vi.mock("@/components/auth/SignupForm", () => ({
  default: () => <form data-testid="signup-form" />,
}));

describe("AuthCard brand mark", () => {
  it.each(["signin", "signup"] as const)(
    "shows the static 40px Master mark above the wordmark on %s",
    (mode) => {
      const { container } = render(<AuthCard mode={mode} />);

      const mark = container.querySelector("svg[data-vocatrya-mark]");
      expect(mark).not.toBeNull();
      expect(mark).toHaveAttribute("width", "40");
      expect(mark).toHaveAttribute("height", "40");
      expect(mark).toHaveAttribute("data-animated", "false");
      expect(mark).toHaveAttribute("data-state", "idle");
      expect(mark).toHaveClass("mx-auto", "mb-3");

      // Master geometry: size 40 > 24 selects the master path set.
      const paths = mark!.querySelectorAll("path");
      expect(paths).toHaveLength(masterPaths.length);
      expect(paths[0]).toHaveAttribute("d", masterPaths[0]);

      // Wordmark and tagline stay in place below the mark.
      expect(
        screen.getByRole("heading", { name: "Vocatrya" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Track your job search, powered by AI"),
      ).toBeInTheDocument();
    },
  );

  it("keeps the mode-specific form and headings", () => {
    const { unmount } = render(<AuthCard mode="signin" />);
    expect(screen.getByTestId("signin-form")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
    unmount();

    render(<AuthCard mode="signup" />);
    expect(screen.getByTestId("signup-form")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Get started" }),
    ).toBeInTheDocument();
  });
});
