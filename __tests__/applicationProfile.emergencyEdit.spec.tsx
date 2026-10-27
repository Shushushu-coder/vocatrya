import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmergencyContactCard } from "@/components/career/application-profile/EmergencyContactCard";

vi.mock("@/actions/applicationProfile.actions", () => ({
  getEmergencyContactOverview: vi.fn(),
  revealEmergencyContact: vi.fn(),
  copyEmergencyContactField: vi.fn(),
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
  updateEmergencyContact,
} from "@/actions/applicationProfile.actions";
import { toastError } from "@/lib/toast";

type MockFn = ReturnType<typeof vi.fn>;

const OVERVIEW = {
  success: true,
  data: {
    hasData: true,
    maskedName: "张*",
    relation: "父亲",
    maskedPhone: "****8000",
    updatedAt: null,
  },
};

const FULL = {
  success: true,
  data: { name: "张建国", relation: "父亲", phone: "13800138000" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openCard() {
  render(<EmergencyContactCard />);
  fireEvent.click(screen.getByText("Show"));
  await waitFor(() =>
    expect(screen.getByTestId("emergency-phone").textContent).toContain("****8000"),
  );
}

async function enterEdit() {
  fireEvent.click(screen.getByText("Edit"));
  await waitFor(() =>
    expect((screen.getByTestId("emergency-input-name") as HTMLInputElement).value).toBe(
      "张建国",
    ),
  );
}

describe("EmergencyContactCard edit data protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getEmergencyContactOverview as unknown as MockFn).mockResolvedValue(OVERVIEW);
    (revealEmergencyContact as unknown as MockFn).mockResolvedValue(FULL);
    (updateEmergencyContact as unknown as MockFn).mockResolvedValue({ success: true });
  });

  it("editing without prior reveal loads real values and only writes the changed field", async () => {
    await openCard();
    await enterEdit();
    expect(revealEmergencyContact).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByTestId("emergency-input-phone") as HTMLInputElement).value,
    ).toBe("13800138000");

    fireEvent.change(screen.getByTestId("emergency-input-relation"), {
      target: { value: "母亲" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateEmergencyContact).toHaveBeenCalledTimes(1));
    expect(updateEmergencyContact).toHaveBeenCalledWith({
      emergencyContactRelation: "母亲",
    });
  });

  it("actively clearing a field writes null while untouched fields are omitted", async () => {
    await openCard();
    await enterEdit();
    fireEvent.change(screen.getByTestId("emergency-input-name"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateEmergencyContact).toHaveBeenCalledTimes(1));
    expect(updateEmergencyContact).toHaveBeenCalledWith({
      emergencyContactName: null,
    });
  });

  it("failed read before edit keeps view mode and never submits empty values", async () => {
    (revealEmergencyContact as unknown as MockFn).mockResolvedValueOnce({
      success: false,
    });
    await openCard();
    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByTestId("emergency-input-name")).toBeNull();
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("emergency-input-name") as HTMLInputElement).value,
      ).toBe("张建国"),
    );
    expect(updateEmergencyContact).not.toHaveBeenCalled();
  });

  it.each(["response", "exception"])("failed save (%s) keeps the draft so the user can retry", async (failure) => {
    const update = updateEmergencyContact as unknown as MockFn;
    if (failure === "exception") update.mockRejectedValueOnce(new Error("network unavailable"));
    else update.mockResolvedValueOnce({ success: false });
    update.mockResolvedValueOnce({ success: true });
    await openCard();
    await enterEdit();
    fireEvent.change(screen.getByTestId("emergency-input-relation"), {
      target: { value: "母亲" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      (screen.getByTestId("emergency-input-relation") as HTMLInputElement).value,
    ).toBe("母亲");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(updateEmergencyContact).toHaveBeenCalledTimes(2),
    );
    expect(updateEmergencyContact).toHaveBeenLastCalledWith({
      emergencyContactRelation: "母亲",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("emergency-input-relation")).toBeNull(),
    );
  });

  it("saving with no changes skips the update call and closes the editor", async () => {
    await openCard();
    await enterEdit();
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(screen.queryByTestId("emergency-input-name")).toBeNull(),
    );
    expect(updateEmergencyContact).not.toHaveBeenCalled();
  });

  it("collapse clears revealed plaintext; reopening shows masked values again", async () => {
    await openCard();
    fireEvent.click(screen.getAllByText("Show")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("emergency-phone").textContent).toContain(
        "13800138000",
      ),
    );

    // Header collapse is the first "Hide" (row buttons follow it in DOM order).
    fireEvent.click(screen.getAllByText("Hide")[0]);
    fireEvent.click(screen.getByText("Show"));

    await waitFor(() =>
      expect(screen.getByTestId("emergency-phone").textContent).toContain(
        "****8000",
      ),
    );
    expect(document.body.textContent).not.toContain("13800138000");
    expect(document.body.textContent).not.toContain("张建国");
  });

  it("a late reveal response arriving after collapse cannot repopulate plaintext", async () => {
    const pending = deferred<typeof FULL>();
    (revealEmergencyContact as unknown as MockFn).mockReturnValueOnce(
      pending.promise,
    );
    await openCard();
    fireEvent.click(screen.getAllByText("Show")[0]);
    fireEvent.click(screen.getByText("Hide"));

    await act(async () => {
      pending.resolve(FULL);
      await pending.promise;
    });

    fireEvent.click(screen.getByText("Show"));
    await waitFor(() =>
      expect(screen.getByTestId("emergency-phone").textContent).toContain(
        "****8000",
      ),
    );
    expect(document.body.textContent).not.toContain("13800138000");
  });
});
