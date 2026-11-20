import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorNoticeHost } from "@/components/common/ErrorNoticeHost";
import { useConditionNotice } from "@/components/common/useConditionNotice";
import { NotionStatusNotice } from "@/components/extensions/NotionStatusNotice";
import ByokConnectionsCard from "@/components/settings/ByokConnectionsCard";
import { resetErrorNoticesForTests, RECOVERED_DISMISS_MS } from "@/lib/errorNotices";

const byok = vi.hoisted(() => ({
  getUserApiKeys: vi.fn(),
  status: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/actions/apiKey.actions", () => ({
  getUserApiKeys: byok.getUserApiKeys,
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));
vi.mock("@/actions/byokCredential.actions", () => ({
  getByokCredentialStorageStatus: byok.status,
  migrateByokCredentialsToOsStore: vi.fn(),
  verifyByokCredentials: byok.verify,
}));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

afterEach(() => {
  act(() => resetErrorNoticesForTests());
  vi.useRealTimers();
});

function Probe({ active }: { active: boolean | null }) {
  useConditionNotice(active, {
    kind: "ai-connection:REAUTH_REQUIRED",
    title: "AI re-auth",
    action: { label: "Reconnect", href: "/dashboard/settings?section=ai-services" },
  });
  return null;
}

describe("useConditionNotice (ai-connection:REAUTH_REQUIRED)", () => {
  it("reports on detect, merges repeats, resolves and auto-dismisses", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <>
        <ErrorNoticeHost />
        <Probe active={null} />
      </>,
    );
    expect(screen.queryByTestId("error-notice")).toBeNull(); // unknown != error
    rerender(<><ErrorNoticeHost /><Probe active /></>);
    rerender(<><ErrorNoticeHost /><Probe active={false} /></>);
    rerender(<><ErrorNoticeHost /><Probe active /></>); // recurrence, same kind
    expect(screen.getAllByTestId("error-notice")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      "/dashboard/settings?section=ai-services",
    );
    rerender(<><ErrorNoticeHost /><Probe active={false} /></>);
    expect(screen.getByTestId("error-notice")).toHaveAttribute("data-status", "recovered");
    act(() => vi.advanceTimersByTime(RECOVERED_DISMISS_MS));
    expect(screen.queryByTestId("error-notice")).toBeNull();
  });
});

describe("NotionStatusNotice (extension-notion:REAUTH_REQUIRED)", () => {
  it("reports on REAUTH_REQUIRED, stays merged across checks, resolves when connected", () => {
    const view = (s: string | null) => (
      <><ErrorNoticeHost /><NotionStatusNotice status={s} /></>
    );
    const { rerender } = render(view(null));
    expect(screen.queryByTestId("error-notice")).toBeNull();
    rerender(view("REAUTH_REQUIRED"));
    rerender(view("REAUTH_REQUIRED"));
    expect(screen.getAllByTestId("error-notice")).toHaveLength(1);
    expect(screen.getByTestId("error-notice")).toHaveAttribute(
      "data-kind",
      "extension-notion:REAUTH_REQUIRED",
    );
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      "/dashboard/extensions/notion",
    );
    rerender(view("CONNECTED"));
    expect(screen.getByTestId("error-notice")).toHaveAttribute("data-status", "recovered");
  });

  it("does not report for a plain disconnected state", () => {
    render(<><ErrorNoticeHost /><NotionStatusNotice status="DISCONNECTED" /></>);
    expect(screen.queryByTestId("error-notice")).toBeNull();
  });
});

describe("ByokConnectionsCard storage verification (byok-credentials:REAUTH_REQUIRED)", () => {
  it("reports issues as a persistent notice and resolves on a clean re-check", async () => {
    byok.getUserApiKeys.mockResolvedValue({ success: true, data: [] });
    byok.status.mockResolvedValue({
      success: true,
      data: { mode: "os-backed", available: true, backend: "dpapi", osProtected: 1, appCipher: 0, plaintext: 0 },
    });
    byok.verify.mockResolvedValueOnce({ success: true, data: [{ status: "reauth_required" }] });
    byok.verify.mockResolvedValueOnce({ success: true, data: [{ status: "ok" }] });
    render(<><ErrorNoticeHost /><ByokConnectionsCard /></>);
    const user = userEvent.setup();
    const verify = await screen.findByRole("button", { name: "Verify protected keys" });
    await user.click(verify);
    const notice = await screen.findByTestId("error-notice");
    expect(notice).toHaveAttribute("data-kind", "byok-credentials:REAUTH_REQUIRED");
    await user.click(screen.getByRole("button", { name: "Verify protected keys" }));
    await waitFor(() =>
      expect(screen.getByTestId("error-notice")).toHaveAttribute("data-status", "recovered"),
    );
  });
});
