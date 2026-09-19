import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import ResumeVariantWorkspacePage from "@/app/dashboard/profile/resumes/[variantId]/page";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));

const getCareerRuntimeSnapshot = vi.fn();
vi.mock("@/actions/career.runtime", () => ({
  getCareerRuntimeSnapshot: () => getCareerRuntimeSnapshot(),
}));

vi.mock("@/i18n/server", () => ({
  getServerI18n: vi.fn(async () => ({ t: (key: string) => key })),
}));

vi.mock("@/lib/career/access", () => ({
  canReadCareerData: vi.fn(() => true),
}));

const resolveVersion = vi.fn();
vi.mock("@/actions/resumeVariant.actions", () => ({
  resolveResumeVariantWorkspaceVersion: (input: unknown) => resolveVersion(input),
}));

const renderWorkspace = vi.fn();
vi.mock("@/components/career/resume-variant/ResumeVariantWorkspace", () => ({
  ResumeVariantWorkspace: (props: unknown) => {
    renderWorkspace(props);
    return <div data-testid="resume-variant-workspace" />;
  },
}));

vi.mock("@/components/career/CareerRuntimeNotice", () => ({
  CareerRuntimeNotice: () => <div data-testid="runtime-notice" />
}));

function pageProps(variantId: string, version?: string | string[]): {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
} {
  return {
    params: Promise.resolve({ variantId }),
    searchParams: Promise.resolve(version === undefined ? {} : { version }),
  };
}

describe("ResumeVariantWorkspacePage fail-closed version query", () => {
  beforeEach(() => {
    notFound.mockClear();
    renderWorkspace.mockClear();
    resolveVersion.mockReset();
    getCareerRuntimeSnapshot.mockResolvedValue({ mode: "AB_ENABLED" });
  });

  it("404s on a non-empty nonexistent version instead of opening current", async () => {
    resolveVersion.mockResolvedValue({ success: false, message: "VERSION_NOT_FOUND" });

    await expect(
      ResumeVariantWorkspacePage(pageProps("var-1", "missing-version")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledWith({
      variantId: "var-1",
      versionId: "missing-version",
    });
    expect(renderWorkspace).not.toHaveBeenCalled();
  });

  it("404s on a version that belongs to a different owned variant", async () => {
    resolveVersion.mockResolvedValue({ success: false, message: "VERSION_NOT_FOUND" });

    await expect(
      ResumeVariantWorkspacePage(pageProps("var-a", "ver-from-var-b")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledWith({
      variantId: "var-a",
      versionId: "ver-from-var-b",
    });
    expect(renderWorkspace).not.toHaveBeenCalled();
  });

  it("404s on a foreign user version without leaking existence", async () => {
    resolveVersion.mockResolvedValue({ success: false, message: "VERSION_NOT_FOUND" });

    const failure: unknown = await ResumeVariantWorkspacePage(
      pageProps("var-mine", "ver-foreign"),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(renderWorkspace).not.toHaveBeenCalled();
  });

  it("404s when resolution succeeds without data", async () => {
    resolveVersion.mockResolvedValue({ success: true, data: null });

    await expect(
      ResumeVariantWorkspacePage(pageProps("var-1", "ver-1")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(renderWorkspace).not.toHaveBeenCalled();
  });

  it("opens the exact owned historical version on the valid path", async () => {
    resolveVersion.mockResolvedValue({
      success: true,
      data: { variantId: "var-1", versionId: "ver-1" },
    });

    const element = (await ResumeVariantWorkspacePage(
      pageProps("var-1", "ver-1"),
    )) as unknown as ReactElement;
    render(element);

    expect(notFound).not.toHaveBeenCalled();
    expect(resolveVersion).toHaveBeenCalledWith({
      variantId: "var-1",
      versionId: "ver-1",
    });
    expect(renderWorkspace).toHaveBeenCalledWith({
      variantId: "var-1",
      initialVersionId: "ver-1",
    });
    expect(screen.getByTestId("resume-variant-workspace")).toBeInTheDocument();
  });

  it("opens current when no version query is given", async () => {
    const element = (await ResumeVariantWorkspacePage(
      pageProps("var-1"),
    )) as unknown as ReactElement;
    render(element);

    expect(notFound).not.toHaveBeenCalled();
    expect(resolveVersion).not.toHaveBeenCalled();
    expect(renderWorkspace).toHaveBeenCalledWith({
      variantId: "var-1",
      initialVersionId: undefined,
    });
    expect(screen.getByTestId("resume-variant-workspace")).toBeInTheDocument();
  });

  it("treats an empty version query as unspecified", async () => {
    const element = (await ResumeVariantWorkspacePage(
      pageProps("var-1", ""),
    )) as unknown as ReactElement;
    render(element);

    expect(notFound).not.toHaveBeenCalled();
    expect(resolveVersion).not.toHaveBeenCalled();
    expect(renderWorkspace).toHaveBeenCalledWith({
      variantId: "var-1",
      initialVersionId: undefined,
    });
  });

  it("treats a whitespace-only version query as unspecified", async () => {
    const element = (await ResumeVariantWorkspacePage(
      pageProps("var-1", "   "),
    )) as unknown as ReactElement;
    render(element);

    expect(notFound).not.toHaveBeenCalled();
    expect(resolveVersion).not.toHaveBeenCalled();
    expect(renderWorkspace).toHaveBeenCalledWith({
      variantId: "var-1",
      initialVersionId: undefined,
    });
  });

  it("resolves the first value when the version query repeats", async () => {
    resolveVersion.mockResolvedValue({
      success: true,
      data: { variantId: "var-1", versionId: "ver-1" },
    });

    const element = (await ResumeVariantWorkspacePage(
      pageProps("var-1", ["ver-1", "ver-2"]),
    )) as unknown as ReactElement;
    render(element);

    expect(notFound).not.toHaveBeenCalled();
    expect(resolveVersion).toHaveBeenCalledWith({
      variantId: "var-1",
      versionId: "ver-1",
    });
    expect(renderWorkspace).toHaveBeenCalledWith({
      variantId: "var-1",
      initialVersionId: "ver-1",
    });
  });
});