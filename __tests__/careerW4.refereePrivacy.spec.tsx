import { act, fireEvent, render, screen } from "@testing-library/react";
import { RefereeCard } from "@/components/career/application-profile/RefereeCard";
import { IdDocumentCard } from "@/components/career/application-profile/IdDocumentCard";
import { getIdDocumentOverview, listCandidateReferees, revealCandidateReferee, revealIdDocument, updateIdDocument } from "@/actions/applicationProfile.actions";

vi.mock("@/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/actions/applicationProfile.actions", () => ({
  listCandidateReferees: vi.fn(),
  revealCandidateReferee: vi.fn(),
  copyCandidateRefereeField: vi.fn(),
  createCandidateReferee: vi.fn(),
  updateCandidateReferee: vi.fn(),
  archiveCandidateReferee: vi.fn(),
  getIdDocumentOverview: vi.fn(),
  revealIdDocument: vi.fn(),
  updateIdDocument: vi.fn(),
  copyIdDocumentField: vi.fn(),
}));

const full = {
  success: true as const,
  data: { name: "真实姓名", phone: "13800001234", email: null, organization: null, position: null, relationship: null, note: null },
};

async function openCard() {
  fireEvent.click(screen.getByRole("button", { name: "applicationProfile.reveal" }));
  await screen.findByTestId("referee-name-r1");
}

beforeEach(() => {
  vi.mocked(listCandidateReferees).mockResolvedValue({
    success: true,
    data: [{ id: "r1", maskedName: "真***", maskedPhone: "138****1234", maskedEmail: null, organization: null, position: null, relationship: null }],
  });
  vi.mocked(revealCandidateReferee).mockResolvedValue(full);
});

it("clears revealed referee values when the sensitive card closes", async () => {
  render(<RefereeCard />);
  await openCard();
  fireEvent.click(screen.getByRole("button", { name: "applicationProfile.reveal" }));
  await screen.findAllByText("真实姓名");
  fireEvent.click(screen.getAllByRole("button", { name: "applicationProfile.hide" })[0]);
  await openCard();
  expect(screen.getByTestId("referee-name-r1")).toHaveTextContent("真***");
  expect(screen.queryAllByText("真实姓名")).toHaveLength(0);
});

it.each(["applicationProfile.reveal", "common.edit"])("discards a late %s response after closing", async (buttonName) => {
  let resolve!: (value: typeof full) => void;
  vi.mocked(revealCandidateReferee).mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<RefereeCard />);
  await openCard();
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  fireEvent.click(screen.getAllByRole("button", { name: "applicationProfile.hide" })[0]);
  await act(async () => { resolve(full); });
  await openCard();
  expect(screen.queryAllByText("真实姓名")).toHaveLength(0);
  expect(screen.queryByTestId("referee-input-name")).toBeNull();
});

it("clears the ID editor on close even while its save is pending", async () => {
  vi.mocked(getIdDocumentOverview).mockResolvedValue({ success: true, data: { hasData: true, idType: "身份证", maskedIdNumber: "123***456", updatedAt: null } });
  vi.mocked(revealIdDocument).mockResolvedValue({ success: true, data: { idType: "身份证", idNumber: "123456789" } });
  let resolve!: (value: { success: false; message: string }) => void;
  vi.mocked(updateIdDocument).mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<IdDocumentCard />);
  fireEvent.click(screen.getByRole("button", { name: "applicationProfile.reveal" }));
  fireEvent.click(screen.getByRole("button", { name: "common.edit" }));
  await screen.findByTestId("id-doc-input-number");
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  fireEvent.click(screen.getByRole("button", { name: "applicationProfile.hide" }));
  fireEvent.click(screen.getByRole("button", { name: "applicationProfile.reveal" }));
  expect(screen.queryByTestId("id-doc-input-number")).toBeNull();
  expect(screen.getByTestId("id-doc-number")).not.toHaveTextContent("123456789");
  await act(async () => { resolve({ success: false, message: "Save failed" }); });
  expect(screen.queryByTestId("id-doc-input-number")).toBeNull();
});
