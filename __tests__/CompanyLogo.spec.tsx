import { render, screen } from "@testing-library/react";
import { CompanyLogo } from "@/components/myjobs/CompanyLogo";
import { companyAvatarPaletteClass } from "@/lib/company-avatar";

/**
 * Radix Avatar reads `complete`/`naturalWidth` off a real `window.Image`
 * instance — jsdom never finishes a fetch, so an unmocked <img> would pin the
 * component in "loading" forever and the assertions below would silently
 * verify nothing. This stub reports the requested outcome synchronously, the
 * same shape a browser produces once the request settles.
 */
type ImageOutcome = "load" | "error" | "pending";
let outcome: ImageOutcome = "pending";
const createdSrcs: string[] = [];

class MockImage {
  complete = false;
  naturalWidth = 0;
  crossOrigin: string | null = null;
  referrerPolicy = "";
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  set src(value: string) {
    createdSrcs.push(value);
    if (outcome === "pending") return;
    // Radix reads getImageLoadingStatus() synchronously after setting src,
    // so the flags alone settle the state — no event dispatch needed.
    this.complete = true;
    this.naturalWidth = outcome === "load" ? 1 : 0;
  }
}

beforeEach(() => {
  createdSrcs.length = 0;
  vi.stubGlobal("Image", MockImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CompanyLogo", () => {
  it("shows the letter avatar when there is no logo URL", () => {
    render(<CompanyLogo name="Acme Corp" />);
    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("renders the real logo once the image loads", () => {
    outcome = "load";
    const { container } = render(
      <CompanyLogo logoUrl="/logo.png" name="Acme Corp" />,
    );
    const img = container.querySelector("img");
    // Radix only mounts <img> after the request resolves — its presence is
    // the loaded signal, not a fallback sibling.
    expect(img).toHaveAttribute("src", "/logo.png");
    expect(img).toHaveAttribute("alt", "");
    // Non-square logos must crop to the square container, not stretch.
    expect(img).toHaveClass("object-cover");
    // Loaded images replace the fallback entirely — no double announcement.
    expect(screen.queryByText("AC")).not.toBeInTheDocument();
    expect(createdSrcs).toContain("/logo.png");
  });

  it("falls back to the letter avatar when the image errors", async () => {
    outcome = "error";
    render(<CompanyLogo logoUrl="/missing.png" name="Acme Corp" />);
    expect(await screen.findByText("AC")).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("shows the letter avatar while the image request is still pending", () => {
    outcome = "pending";
    render(<CompanyLogo logoUrl="/slow.png" name="Acme Corp" />);
    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("reacts to logoUrl changes, including load→error transitions", () => {
    outcome = "load";
    const { container, rerender } = render(
      <CompanyLogo logoUrl="/first.png" name="Acme Corp" />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/first.png");

    outcome = "error";
    rerender(<CompanyLogo logoUrl="/second.png" name="Acme Corp" />);
    // Radix drops the stale <img> as soon as the new request cannot complete.
    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(createdSrcs).toEqual(["/first.png", "/second.png"]);
  });

  it("updates letters and palette when the company name changes", () => {
    const { rerender } = render(<CompanyLogo name="Acme Corp" />);
    const acme = screen.getByText("AC");
    expect(acme).toHaveClass(companyAvatarPaletteClass("Acme Corp"));

    rerender(<CompanyLogo name="ByteDance 字节跳动" />);
    const han = screen.getByText("字");
    expect(han).toHaveClass(
      companyAvatarPaletteClass("ByteDance 字节跳动"),
    );
  });

  it("renders the neutral Building2 icon for empty or meaningless names", () => {
    const { container, rerender } = render(<CompanyLogo name="" />);
    expect(container.querySelector("svg.lucide-building2")).toBeInTheDocument();
    rerender(<CompanyLogo name="🎉🚀" />);
    expect(container.querySelector("svg.lucide-building2")).toBeInTheDocument();
    rerender(<CompanyLogo />);
    expect(container.querySelector("svg.lucide-building2")).toBeInTheDocument();
  });

  it("exposes a single accessible image named after the company", () => {
    render(<CompanyLogo name="Acme Corp" />);
    expect(screen.getByRole("img", { name: "Acme Corp" })).toBeInTheDocument();
  });

  it("falls back to the localized label when the company name is unusable", () => {
    render(<CompanyLogo name="  " />);
    expect(
      screen.getByRole("img", { name: "Company logo" }),
    ).toBeInTheDocument();
  });

  it("keeps the rounded-square shape and forwards consumer sizing", () => {
    render(<CompanyLogo name="Acme Corp" className="h-8 w-8 min-w-8" />);
    const root = screen.getByRole("img", { name: "Acme Corp" });
    expect(root).toHaveClass("rounded-md", "h-8", "w-8", "min-w-8");
    // The palette classes reach the actual fallback element.
    expect(screen.getByText("AC")).toHaveClass(
      "rounded-md",
      companyAvatarPaletteClass("Acme Corp"),
    );
  });
});
