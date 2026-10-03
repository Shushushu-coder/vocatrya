import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResumeExportControl } from "@/components/career/resume-variant/ResumeExportControl";
import { ResumePreview } from "@/components/career/resume-variant/ResumePreview";
import { ResumeVariantWorkspace } from "@/components/career/resume-variant/ResumeVariantWorkspace";
import { ResumePrintReady } from "@/components/career/resume-variant/ResumePrintReady";
import * as actions from "@/actions/resumeVariant.actions";
import { translate } from "@/i18n/translate";

vi.mock("@/i18n", () => {
  const t = (key: string) => translate("en", key);
  return { useI18n: () => ({ t }) };
});
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@/actions/resumeVariant.actions", () => ({
  findReusableResumeExport: vi.fn(), freezeResumeVersion: vi.fn(),
  getResumeVariant: vi.fn(), getResumeVariantVersion: vi.fn(), listResumeVariantVersions: vi.fn(),
  cloneResumeVersionAsDraft: vi.fn(), createResumeExpression: vi.fn(), createResumeSection: vi.fn(),
  createResumeSectionItem: vi.fn(), deleteResumeExpression: vi.fn(), deleteResumeSection: vi.fn(),
  deleteResumeSectionItem: vi.fn(), listResumeCareerMaterials: vi.fn(), reorderResumeExpressions: vi.fn(),
  reorderResumeSectionItems: vi.fn(), reorderResumeSections: vi.fn(), replaceResumeExpressionEvidence: vi.fn(),
  updateResumeExpression: vi.fn(), updateResumeHeaderSnapshot: vi.fn(), updateResumeSection: vi.fn(),
}));
const artifact = { id: "artifact-1", fileName: "张三_校园.pdf" };
const pdf = new Uint8Array([37, 80, 68, 70, 45]);
const bridge = { printToPDF: vi.fn() };
let downloadClick: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  window.vocatryaResume = bridge;
  bridge.printToPDF.mockResolvedValue({ ok: true, bytes: pdf });
  vi.mocked(actions.findReusableResumeExport).mockResolvedValue({ success: true, data: null });
  vi.mocked(actions.freezeResumeVersion).mockResolvedValue({ success: true });
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => artifact }
    : { ok: true, blob: async () => new Blob([pdf], { type: "application/pdf" }) }));
  URL.createObjectURL = vi.fn(() => "blob:stored-artifact");
  URL.revokeObjectURL = vi.fn();
  downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { delete window.vocatryaResume; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function control(status = "FROZEN", archived = false) {
  const onFrozen = vi.fn();
  render(<ResumeExportControl versionId="version-1" status={status} archived={archived} onFrozen={onFrozen} />);
  return { onFrozen, button: screen.getByRole("button", { name: archived ? "Download PDF" : "Export PDF" }) };
}

it("disables export with an explanation outside Electron", () => {
  delete window.vocatryaResume;
  const { button } = control();
  expect(button).toBeDisabled();
  expect(screen.getByText("PDF export is available in the desktop app only.")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["FROZEN", "SUBMITTED"])("renders, persists, then downloads the stored bytes for %s", async (status) => {
  const { button } = control(status);
  fireEvent.click(button);
  await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
  expect(bridge.printToPDF).toHaveBeenCalledWith("version-1");
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/profile/resume-artifacts?versionId=version-1", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/pdf" } }));
  expect(fetch).toHaveBeenNthCalledWith(2, "/api/profile/resume-artifacts/artifact-1", { cache: "no-store" });
  expect(downloadClick.mock.instances[0]).toHaveAttribute("download", artifact.fileName);
  expect(actions.freezeResumeVersion).not.toHaveBeenCalled();
});

it("reuses without printing or persisting, including archived variants", async () => {
  vi.mocked(actions.findReusableResumeExport).mockResolvedValue({ success: true, data: artifact });
  const { button } = control("FROZEN", true);
  fireEvent.click(button);
  await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
  expect(bridge.printToPDF).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

it("refuses new artifacts on an archived draft without freezing", async () => {
  const { button } = control("DRAFT", true);
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("This archived resume has no stored PDF");
  expect(actions.freezeResumeVersion).not.toHaveBeenCalled();
  expect(bridge.printToPDF).not.toHaveBeenCalled();
});

it("confirms read-only/new-draft consequences before freezing and exporting", async () => {
  const { button, onFrozen } = control("DRAFT");
  fireEvent.click(button);
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("This version will become read-only. Further edits require creating a new draft.");
  expect(actions.freezeResumeVersion).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Freeze and export" }));
  await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
  expect(actions.freezeResumeVersion).toHaveBeenCalledWith("version-1");
  expect(onFrozen).toHaveBeenCalledWith("version-1");
});

it("cancel leaves a draft mutable and does not print", () => {
  const { button } = control("DRAFT");
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(actions.freezeResumeVersion).not.toHaveBeenCalled();
  expect(bridge.printToPDF).not.toHaveBeenCalled();
});

it("reports freeze failure without rendering", async () => {
  vi.mocked(actions.freezeResumeVersion).mockResolvedValue({ success: false, message: "failure" });
  const { button, onFrozen } = control("DRAFT");
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Freeze and export" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not freeze this version");
  expect(onFrozen).not.toHaveBeenCalled();
  expect(bridge.printToPDF).not.toHaveBeenCalled();
});

it.each(["print_failed", "load_failed", "timeout"])("reports render failure %s with retry", async (code) => {
  bridge.printToPDF.mockResolvedValue({ ok: false, code });
  const { button } = control();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent(code === "timeout" ? "timed out" : "Could not render");
  expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
  expect(fetch).not.toHaveBeenCalled();
});

it("reports save failure distinctly", async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  const { button } = control();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the PDF");
});

it("reports lookup failure before rendering and generic download failure after reuse", async () => {
  vi.mocked(actions.findReusableResumeExport).mockResolvedValueOnce({ success: false, message: "lookup failed" });
  const { button } = control();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not check for a stored PDF");
  expect(bridge.printToPDF).not.toHaveBeenCalled();
  vi.mocked(actions.findReusableResumeExport).mockResolvedValueOnce({ success: true, data: artifact });
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: "failed" }) } as Response);
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not download the stored PDF"));
});

it("reports missing stored bytes distinctly", async () => {
  vi.mocked(actions.findReusableResumeExport).mockResolvedValue({ success: true, data: artifact });
  vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ code: "ARTIFACT_BYTES_MISSING" }) } as Response);
  const { button } = control();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("The stored PDF is missing");
});

it("shows progress and locks double clicks through persistence", async () => {
  let resolvePrint!: (value: { ok: true; bytes: Uint8Array }) => void;
  bridge.printToPDF.mockImplementation(() => new Promise((resolve) => { resolvePrint = resolve; }));
  const { button } = control();
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByRole("button", { name: "Rendering PDF…" });
  expect(screen.getByRole("button", { name: "Rendering PDF…" })).toBeDisabled();
  expect(bridge.printToPDF).toHaveBeenCalledOnce();
  await act(async () => { resolvePrint({ ok: true, bytes: pdf }); });
  await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
});

it("keeps the workspace frozen after export fails and retries without a second freeze", async () => {
  const graph = { id: "version-1", status: "DRAFT", headerSnapshot: null, resumeVariant: { id: "variant-1", name: "Campus", archivedAt: null }, submittedAttempts: [], sections: [] };
  vi.mocked(actions.getResumeVariant).mockResolvedValue({ success: true, data: { name: "Campus", currentVersionId: "version-1" } });
  vi.mocked(actions.listResumeVariantVersions).mockResolvedValue({ success: true, data: [{ id: "version-1", versionNumber: 1, status: "DRAFT", currentVersion: true }] });
  vi.mocked(actions.getResumeVariantVersion).mockResolvedValue({ success: true, data: graph });
  bridge.printToPDF.mockResolvedValueOnce({ ok: false, code: "print_failed" });
  render(<ResumeVariantWorkspace variantId="variant-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Export PDF" }));
  fireEvent.click(screen.getByRole("button", { name: "Freeze and export" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Create new draft" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Freeze version" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("textbox").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
  await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
  expect(actions.freezeResumeVersion).toHaveBeenCalledOnce();
});

const sections = [{ id: "section", title: "经历", items: [{ id: "item", careerMaterialItem: { title: "编译器" }, expressions: [{ id: "expression", sortOrder: 0, content: "开发中文简历" }, { id: "empty", sortOrder: 1, content: "   " }] }] }];
it("print preview keeps resume content and omits preview notice, placeholders and empty expressions", () => {
  render(<ResumePreview print headerSnapshot='{"fullName":"张三"}' sections={sections} />);
  const preview = screen.getByTestId("resume-print-preview");
  for (const text of ["张三", "经历", "编译器", "开发中文简历"]) expect(preview).toHaveTextContent(text);
  expect(preview).not.toHaveTextContent(translate("en", "resumeVariants.previewReadOnly"));
  expect(preview).not.toHaveTextContent(translate("en", "applicationProfile.emptyValue"));
  expect(preview.querySelectorAll("li")).toHaveLength(1);
  expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
});
it("default preview retains its existing notice, placeholder and empty expressions", () => {
  render(<ResumePreview headerSnapshot={null} sections={sections} />);
  const preview = screen.getByTestId("resume-browser-preview");
  expect(preview).toHaveTextContent(translate("en", "resumeVariants.previewReadOnly"));
  expect(preview).toHaveTextContent(translate("en", "applicationProfile.emptyValue"));
  expect(preview.querySelectorAll("li")).toHaveLength(2);
});
it("print preview with an empty header has no placeholder", () => {
  render(<ResumePreview print headerSnapshot={null} sections={[]} />);
  expect(screen.getByTestId("resume-print-preview").textContent).toBe("");
});
it("signals readiness only after fonts resolve and clears it on unmount", async () => {
  let ready!: () => void;
  const fonts = { ready: new Promise<void>((resolve) => { ready = resolve; }) };
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const { unmount } = render(<><ResumePreview print headerSnapshot={null} sections={[]} /><ResumePrintReady versionId="version-1" /></>);
  expect(document.documentElement.dataset.resumePrintReady).toBeUndefined();
  await act(async () => { ready(); });
  expect(document.documentElement.dataset.resumePrintReady).toBe("version-1");
  unmount();
  expect(document.documentElement.dataset.resumePrintReady).toBeUndefined();
});
