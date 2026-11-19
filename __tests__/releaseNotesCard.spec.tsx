// The About-page release notes card renders the current version's curated
// section and, only when an update exists, the latest release's. With neither
// it stays hidden so pre-notes installs and dev builds are not cluttered.
import { render, screen, waitFor } from "@testing-library/react";
import ReleaseNotesCard from "@/components/settings/ReleaseNotesCard";
import { I18nProvider, type Locale } from "@/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div data-testid="notes-content">{content}</div>
  ),
}));

const nullLocaleLoader = async (): Promise<Locale | null> => null;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function respond(info: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => info,
  });
}

function renderCard(locale: Locale = "zh-CN") {
  return render(
    <I18nProvider initialLocale={locale} loadPersistedLocale={nullLocaleLoader}>
      <ReleaseNotesCard />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReleaseNotesCard", () => {
  it("stays hidden when there is nothing to show", async () => {
    respond({ current: { version: "1.2.1-rc", notes: null }, latest: null });
    const { container } = renderCard();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("release-notes-card")).toBeNull(),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the current version's notes in the UI locale", async () => {
    respond({
      current: { version: "1.2.1-rc", notes: "- 新增甲\n- 修复乙" },
      latest: null,
    });
    renderCard("zh-CN");

    await waitFor(() =>
      expect(screen.getByTestId("release-notes-current")).toBeInTheDocument(),
    );
    expect(screen.getByText("当前版本 1.2.1-rc")).toBeInTheDocument();
    expect(screen.queryByTestId("release-notes-latest")).toBeNull();
  });

  it("renders English labels for the en locale", async () => {
    respond({
      current: { version: "1.2.1-rc", notes: "- Added A" },
      latest: null,
    });
    renderCard("en");

    await waitFor(() =>
      expect(
        screen.getByText("Current version 1.2.1-rc"),
      ).toBeInTheDocument(),
    );
  });

  it("shows the latest version notes and release link on update", async () => {
    respond({
      current: { version: "1.2.1-rc", notes: "- 新增甲" },
      latest: {
        version: "1.3.0",
        notes: "- 更大更新",
        url: "https://example.com/releases/v1.3.0",
      },
    });
    renderCard("zh-CN");

    await waitFor(() =>
      expect(screen.getByTestId("release-notes-latest")).toBeInTheDocument(),
    );
    expect(screen.getByText("最新版本 1.3.0")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "查看发布页面" });
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/releases/v1.3.0",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("keeps the latest heading and link when its notes are not curated", async () => {
    respond({
      current: { version: "1.2.1-rc", notes: null },
      latest: {
        version: "1.3.0",
        notes: null,
        url: "https://example.com/releases/v1.3.0",
      },
    });
    renderCard("zh-CN");

    await waitFor(() =>
      expect(screen.getByText("最新版本 1.3.0")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "查看发布页面" })).toBeInTheDocument();
    expect(screen.queryByTestId("release-notes-current")).toBeNull();
  });

  it("stays hidden when the fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { container } = renderCard();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("release-notes-card")).toBeNull(),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
