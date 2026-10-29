import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CanonicalResumeImport } from "@/components/career/resume-variant/CanonicalResumeImport";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";
import ResumeVariantsPage from "@/app/dashboard/profile/resumes/page";
const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), fetch: vi.fn(), runtime: vi.fn() }));
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }), usePathname: () => "/dashboard/profile/resumes", useSearchParams: () => searchParams }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n/server", () => ({ getServerI18n: async () => ({ t: (key: string) => key }) }));
vi.mock("@/actions/career.runtime", () => ({ getCareerRuntimeSnapshot: mocks.runtime }));
vi.mock("@/components/career/CareerRuntimeNotice", () => ({ CareerRuntimeNotice: () => null }));
vi.mock("@/actions/resumeVariant.actions", () => ({ listResumeVariants: async () => ({ success: true, data: [] }), archiveResumeVariant: vi.fn(), createResumeVariant: vi.fn(), renameResumeVariant: vi.fn() }));
const preview = { parsed: importFixture, rawText: importRawText, name: "Synthetic", approval: "signed",
  summary: { created: 4, reused: 0, conflicts: ["phone"] } };
beforeEach(() => { searchParams = new URLSearchParams(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const choose = () => {
  fireEvent.click(screen.getByText("canonicalImport.open"));
  fireEvent.change(screen.getByLabelText("canonicalImport.choose"), { target: { files: [new File(["%PDF"], "Synthetic.pdf", { type: "application/pdf" })] } });
};
it("ignores the removed toolbar deep link and still opens from its own import button", () => {
  searchParams = new URLSearchParams("import-resume=true");
  mocks.fetch.mockClear();
  render(<CanonicalResumeImport />);
  expect(screen.queryByLabelText("canonicalImport.choose")).toBeNull();
  fireEvent.click(screen.getByText("canonicalImport.open"));
  expect(screen.getByLabelText("canonicalImport.choose")).toBeVisible();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("fresh/full canonical list exposes Import Resume; legacy runtime does not", async () => {
  mocks.runtime.mockResolvedValue({ origin: "fresh", mode: "AB_ENABLED", rolloutScope: "full" });
  render(await ResumeVariantsPage());
  expect(screen.getByText("canonicalImport.open")).toBeVisible();
  cleanup();
  mocks.runtime.mockResolvedValue({ origin: "legacy", mode: "LEGACY_ONLY", rolloutScope: "none" });
  render(await ResumeVariantsPage());
  expect(screen.queryByText("canonicalImport.open")).not.toBeInTheDocument();
});
it("shows upload/loading/review and cancel discards the draft without confirm", async () => {
  let resolve!: (response: unknown) => void;
  mocks.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<CanonicalResumeImport />); choose();
  expect(screen.getByRole("status")).toHaveTextContent("canonicalImport.extracting");
  resolve({ ok: true, json: async () => preview });
  await screen.findByTestId("canonical-import-review");
  expect(screen.getByText(/canonicalImport.conflicts/)).toBeInTheDocument();
  expect(screen.getAllByText(/P95 从 480ms 降至 120ms/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("common.cancel"));
  expect(screen.queryByTestId("canonical-import-review")).not.toBeInTheDocument();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("confirms only once despite double click and opens canonical workspace", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => preview });
  let resolve!: (response: unknown) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<CanonicalResumeImport />); choose(); await screen.findByTestId("canonical-import-review");
  const confirm = screen.getByText("canonicalImport.confirm");
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("canonicalImport.saving");
  resolve({ ok: true, json: async () => ({ variantId: "new-variant" }) });
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard/profile/resumes/new-variant"));
});
it("renders safe extraction and save errors without raw server output", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: "UNSUPPORTED_FORMAT", error: "secret stack" }) });
  render(<CanonicalResumeImport />); choose();
  expect(await screen.findByRole("alert")).toHaveTextContent("canonicalImport.errors.UNSUPPORTED_FORMAT");
  expect(screen.queryByText("secret stack")).not.toBeInTheDocument();
});
it("surfaces AI environment failures instead of the parse-failure copy", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: "STRUCTURED_OUTPUT_NOT_VERIFIED" }) });
  render(<CanonicalResumeImport />); choose();
  expect(await screen.findByRole("alert")).toHaveTextContent("canonicalImport.errors.AI_UNAVAILABLE");
});
it("save failure keeps the review available for an idempotent retry", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => preview })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ code: "SAVE_FAILED" }) });
  render(<CanonicalResumeImport />); choose(); await screen.findByTestId("canonical-import-review");
  fireEvent.click(screen.getByText("canonicalImport.confirm"));
  expect(await screen.findByRole("alert")).toHaveTextContent("canonicalImport.errors.SAVE_FAILED");
  expect(screen.getByTestId("canonical-import-review")).toBeInTheDocument();
  expect(screen.getByText("canonicalImport.confirm")).toBeEnabled();
});
it("keeps all items checked by default and sends the unchecked refs with confirm", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => preview })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: "v" }) });
  render(<CanonicalResumeImport />); choose(); await screen.findByTestId("canonical-import-review");
  const boxes = screen.getAllByRole("checkbox");
  // Profile exclusion first, then one checkbox per parsed item — all kept.
  expect(boxes).toHaveLength(5);
  for (const box of boxes.slice(1)) expect(box).toBeChecked();
  fireEvent.click(boxes[1]);
  fireEvent.click(boxes[3]);
  expect(screen.getByText("canonicalImport.selectionSummary")).toBeVisible();
  expect(screen.queryByText("canonicalImport.summary")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("canonicalImport.confirm"));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  const body = JSON.parse(String(mocks.fetch.mock.calls[1][1].body));
  expect(body.excludedItemRefs).toEqual(["s0.it0", "s2.it0"]);
  expect(body.excludeProfileImport).toBe(false);
});
it("excludes the profile backfill via its own flag and blocks an all-excluded confirm", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => preview });
  render(<CanonicalResumeImport />); choose(); await screen.findByTestId("canonical-import-review");
  const boxes = screen.getAllByRole("checkbox");
  fireEvent.click(boxes[0]);
  for (const box of boxes.slice(1)) fireEvent.click(box);
  expect(screen.getByText("canonicalImport.confirm")).toBeDisabled();
  // Un-excluding one item re-enables confirm and ships the profile flag.
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: "v" }) });
  fireEvent.click(boxes[2]);
  fireEvent.click(screen.getByText("canonicalImport.confirm"));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  const body = JSON.parse(String(mocks.fetch.mock.calls[1][1].body));
  expect(body.excludedItemRefs).toEqual(["s0.it0", "s2.it0", "s3.it0"]);
  expect(body.excludeProfileImport).toBe(true);
});
