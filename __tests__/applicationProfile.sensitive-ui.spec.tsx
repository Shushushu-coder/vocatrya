import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmergencyContactCard } from "@/components/career/application-profile/EmergencyContactCard";
import { ApplicationProfileField } from "@/components/career/application-profile/ApplicationProfileField";

vi.mock("@/actions/applicationProfile.actions", () => ({
  getEmergencyContactOverview: vi.fn().mockResolvedValue({
    success: true,
    data: { hasData: true, maskedName: "张*", relation: "父亲", maskedPhone: "****8000", updatedAt: null },
  }),
  revealEmergencyContact: vi.fn().mockResolvedValue({
    success: true,
    data: { name: "张建国全名", relation: "父亲", phone: "13800138000" },
  }),
  copyEmergencyContactField: vi.fn().mockImplementation(async (field: string) => ({
    success: true,
    data: { value: field === "emergencyContactPhone" ? "13800138000" : "张建国全名" },
  })),
  updateEmergencyContact: vi.fn(),
  getLocalDbPathDisplay: vi.fn().mockResolvedValue({
    success: true,
    data: { kind: "local-file", path: "/tmp/test.db" },
  }),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

import {
  getEmergencyContactOverview,
  revealEmergencyContact,
  copyEmergencyContactField,
  getLocalDbPathDisplay,
} from "@/actions/applicationProfile.actions";
import { toastError, toastSuccess } from "@/lib/toast";

describe("EmergencyContactCard mask/reveal/copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getEmergencyContactOverview as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { hasData: true, maskedName: "张*", relation: "父亲", maskedPhone: "****8000", updatedAt: null },
    });
    (revealEmergencyContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { name: "张建国全名", relation: "父亲", phone: "13800138000" },
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("initial DOM contains masked values, not full values", async () => {
    render(<EmergencyContactCard />);
    fireEvent.click(screen.getByText("Show"));
    // Overview fetch happens on mount; open the card first via Show button in header.
    await waitFor(() => expect(getEmergencyContactOverview).toHaveBeenCalled());
    // After opening, masked phone should appear, full phone must not.
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("****8000"));
    expect(document.body.textContent).not.toContain("13800138000");
    expect(document.body.textContent).not.toContain("张建国全名");
  });

  it("reveal only after explicit click shows full value", async () => {
    render(<EmergencyContactCard />);
    fireEvent.click(screen.getAllByText("Show")[0]);
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("****8000"));
    // Click reveal inside the phone row (second reveal button).
    const reveals = screen.getAllByText("Show");
    fireEvent.click(reveals[1]);
    await waitFor(() => expect(revealEmergencyContact).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("13800138000"));
  });

  it("sensitive copy writes full value but toast/log path never contains it", async () => {
    render(<EmergencyContactCard />);
    fireEvent.click(screen.getAllByText("Show")[0]);
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("****8000"));
    // Reveal first so copy buttons for phone exist with full-value path via server action.
    fireEvent.click(screen.getAllByText("Show")[1]);
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("13800138000"));
    const copies = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(copies[copies.length - 1]);
    await waitFor(() => expect(copyEmergencyContactField).toHaveBeenCalled());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("13800138000");
    expect(JSON.stringify((toastSuccess as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("13800138000");
  });

  it("toast/error on sensitive copy success and failure omit SENSITIVE_PHONE_SENTINEL", async () => {
    const SENTINEL = "SENSITIVE_PHONE_SENTINEL";
    (copyEmergencyContactField as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: { value: SENTINEL },
    });
    render(<EmergencyContactCard />);
    fireEvent.click(screen.getAllByText("Show")[0]);
    await waitFor(() => expect(screen.getByTestId("emergency-phone").textContent).toContain("****8000"));
    fireEvent.click(screen.getAllByText("Show")[1]);
    await waitFor(() => expect(revealEmergencyContact).toHaveBeenCalled());
    const copies = await screen.findAllByRole("button", { name: "Copy" });
    fireEvent.click(copies[copies.length - 1]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SENTINEL));
    expect(JSON.stringify((toastSuccess as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(SENTINEL);

    (copyEmergencyContactField as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(SENTINEL));
    fireEvent.click(copies[copies.length - 1]);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(JSON.stringify((toastError as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(SENTINEL);
  });

  it("shows unknown storage copy when local DB path is unavailable", async () => {
    (getLocalDbPathDisplay as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: { kind: "unavailable" },
    });
    render(<EmergencyContactCard />);
    fireEvent.click(screen.getAllByText("Show")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("sensitive-storage-notice").textContent).toContain(
        "Unable to determine a local database file path from the current database configuration.",
      ),
    );
    expect(screen.getByTestId("sensitive-storage-notice").textContent).not.toContain("prisma/dev.db");
    expect(screen.getByTestId("sensitive-storage-notice").textContent).not.toContain("password");
  });
});

describe("ApplicationProfileField normal copy", () => {
  it("copies trimmed value and shows generic Copied toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ApplicationProfileField label="Name" value="  Alice  " />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Alice"));
  });
});
