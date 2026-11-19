// GET /api/release-notes: auth gate, locale-section extraction for the
// bundled current-version file, and latest-release notes gated on a real
// semver bump — auto-generated release bodies never surface as notes.

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const mockLocale = vi.fn();
vi.mock("@/i18n/server", () => ({
  getServerLocale: () => mockLocale(),
}));

const mockLoadSource = vi.fn();
vi.mock("@/lib/releaseNotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/releaseNotes")>()),
  loadReleaseNotesSource: (...args: unknown[]) => mockLoadSource(...args),
}));

const mockFetchLatest = vi.fn();
vi.mock("@/lib/latestRelease", () => ({
  fetchLatestRelease: () => mockFetchLatest(),
}));

vi.mock("@/lib/telemetry", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { GET } from "@/app/api/release-notes/route";
import { auth } from "@/auth";

const authed = () =>
  (auth as any).mockResolvedValue({ user: { id: "user-1" } });

const NOTES = `<!-- vocatrya-release-notes -->
## zh-CN

- 中文甲

## en

- English A
`;

beforeEach(() => {
  vi.clearAllMocks();
  authed();
  mockLocale.mockResolvedValue("zh-CN");
  mockLoadSource.mockResolvedValue(NOTES);
  mockFetchLatest.mockResolvedValue(null);
});

describe("GET /api/release-notes", () => {
  it("rejects unauthenticated callers", async () => {
    (auth as any).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the current version's notes in the request locale", async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.current.version).toBeTruthy();
    expect(data.current.notes).toBe("- 中文甲");
    expect(data.latest).toBeNull();
  });

  it("extracts the en section when the locale is en", async () => {
    mockLocale.mockResolvedValue("en");
    const data = await (await GET()).json();
    expect(data.current.notes).toBe("- English A");
  });

  it("reports null notes when no notes file ships for this version", async () => {
    mockLoadSource.mockResolvedValue(null);
    const data = await (await GET()).json();
    expect(data.current.notes).toBeNull();
  });

  it("includes the latest release notes only when it is a real upgrade", async () => {
    const current = (await (await GET()).json()).current.version as string;
    mockFetchLatest.mockResolvedValue({
      tag: `v${current}`,
      url: "https://example.com/r",
      body: NOTES,
    });
    let data = await (await GET()).json();
    expect(data.latest).toBeNull();

    mockFetchLatest.mockResolvedValue({
      tag: "v999.0.0",
      url: "https://example.com/r999",
      body: NOTES,
    });
    data = await (await GET()).json();
    expect(data.latest).toEqual({
      version: "999.0.0",
      notes: "- 中文甲",
      url: "https://example.com/r999",
    });
  });

  it("drops non-curated latest bodies but keeps the version and link", async () => {
    mockFetchLatest.mockResolvedValue({
      tag: "v999.0.0",
      url: "https://example.com/r999",
      body: "### Features\n\n* auto generated commit list\n",
    });
    const data = await (await GET()).json();
    expect(data.latest.version).toBe("999.0.0");
    expect(data.latest.notes).toBeNull();
    expect(data.latest.url).toBe("https://example.com/r999");
  });

  it("still serves current notes when the update check throws", async () => {
    mockFetchLatest.mockRejectedValue(new Error("offline"));
    const data = await (await GET()).json();
    expect(data.current.notes).toBe("- 中文甲");
    expect(data.latest).toBeNull();
  });
});
