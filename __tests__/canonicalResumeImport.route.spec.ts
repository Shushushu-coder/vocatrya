// @vitest-environment node
import { NextRequest } from "next/server";
import { POST } from "@/app/api/profile/resume-import/route";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), gate: vi.fn(), extract: vi.fn(), preprocess: vi.fn(), execute: vi.fn(), inspect: vi.fn(), persist: vi.fn(), confirm: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("@/lib/career/capabilities", () => ({ assertResumeV1Writable: mocks.gate }));
vi.mock("@/lib/ai/import/extract-text", async (original) => ({ ...await original<typeof import("@/lib/ai/import/extract-text")>(), extractText: mocks.extract }));
vi.mock("@/lib/ai/tools/preprocessing", () => ({ preprocessText: mocks.preprocess }));
vi.mock("@/lib/career/resumeImportAttempt", async (original) => ({
  ...await original<typeof import("@/lib/career/resumeImportAttempt")>(),
  executeDurableResumeImport: mocks.execute,
  markResumeImportConfirmed: mocks.confirm,
}));
vi.mock("@/lib/ai/rate-limiter", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/career/canonicalResumeImport", () => ({ inspectResumeImport: mocks.inspect, persistResumeImport: mocks.persist }));
const upload = (content = "%PDF-test", mime = "application/pdf", filename = "Synthetic.pdf", requestId: string | null = "req-synthetic-1") => {
  const form = new FormData(); form.set("file", new File([content], filename, { type: mime }));
  if (requestId) form.set("requestId", requestId);
  return new NextRequest("http://localhost/api/profile/resume-import", { method: "POST", body: form });
};
beforeEach(() => {
  mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.gate.mockResolvedValue(undefined);
  mocks.extract.mockResolvedValue({ success: true, data: { text: importRawText, truncated: false } });
  mocks.preprocess.mockResolvedValue({ success: true, data: { normalizedText: "CHANGED BY NORMALIZER" } });
  mocks.execute.mockResolvedValue({ kind: "ok", attemptId: "req-synthetic-1", replayed: false, value: importFixture, resolvedConnectionId: "connection", resolvedModel: "model", managedAiProvenance: null });
  mocks.inspect.mockResolvedValue({ conflicts: [], created: 4, reused: 0 });
  mocks.persist.mockResolvedValue({ id: "variant" });
  mocks.confirm.mockResolvedValue(undefined);
});
it("uses raw source for assignment parsing and returns review with zero persistence calls", async () => {
  const response = await POST(upload());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.parsed).toEqual(importFixture);
  // I5: the preview emits a stable ref for every excludable item, bound to
  // its position inside the signed parse result.
  expect(body.previewRefs).toEqual(["s0.it0", "s1.it0", "s2.it0", "s3.it0"]);
  expect(mocks.execute.mock.calls[0][1].execution.prompt).toContain(importRawText);
  expect(mocks.execute.mock.calls[0][1].execution.prompt).not.toContain("CHANGED BY NORMALIZER");
  expect(mocks.execute.mock.calls[0][1].requestId).toBe("req-synthetic-1");
  expect(mocks.persist).not.toHaveBeenCalled();
  // Cancel is local draft disposal; no API mutation is needed.
});
it("requires the durable request id on the import form", async () => {
  expect((await POST(upload(undefined, undefined, undefined, null))).status).toBe(400);
  expect((await POST(upload(undefined, undefined, undefined, "x"))).status).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("accepts only an owned signed approval for confirm", async () => {
  const { approval } = await (await POST(upload())).json();
  const confirm = (token: string) => new NextRequest("http://localhost/api/profile/resume-import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval: token }),
  });
  expect((await POST(confirm(approval))).status).toBe(200);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.anything(), "owner", "req-synthetic-1");
  mocks.auth.mockResolvedValue({ user: { id: "other" } });
  expect((await POST(confirm(approval))).status).toBe(409);
  expect((await POST(confirm("tampered"))).status).toBe(409);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
});
it("forwards the exclusion selection to persist and maps selection errors to their codes", async () => {
  const { approval } = await (await POST(upload())).json();
  const confirm = (body: unknown) => new NextRequest("http://localhost/api/profile/resume-import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await POST(confirm({ approval, excludedItemRefs: ["s1.it0"], excludeProfileImport: true }))).status).toBe(200);
  expect(mocks.persist.mock.calls[0][2].selection).toEqual({ excludedItemRefs: ["s1.it0"], excludeProfileImport: true });
  // A bare approval still confirms with the default keep-all selection.
  expect((await POST(confirm({ approval }))).status).toBe(200);
  expect(mocks.persist.mock.calls[1][2].selection).toEqual({ excludedItemRefs: undefined, excludeProfileImport: undefined });
  for (const [code, status] of [["IMPORT_EXCLUSION_INVALID", 422], ["IMPORT_EXCLUSION_EMPTY", 422], ["IMPORT_CONFIRMATION_IMMUTABLE", 409]] as const) {
    mocks.persist.mockRejectedValueOnce(new Error(code));
    const response = await POST(confirm({ approval }));
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  }
  // Confirm consumes the attempt only on success — never on a rejected selection.
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
});
it.each(["unsupported", "corrupt", "empty", "short", "long", "truncated", "malformed AI", "broken assignment", "missing assignment"])("fails %s safely with zero writes", async (kind) => {
  if (kind === "corrupt") mocks.extract.mockResolvedValue({ success: false, error: { code: "EXTRACTION_FAILED", message: "secret server path" } });
  if (kind === "empty" || kind === "short" || kind === "long") mocks.preprocess.mockResolvedValue({ success: false, error: { code: kind === "empty" ? "NO_CONTENT" : kind === "short" ? "TOO_SHORT" : "TOO_LONG" } });
  if (kind === "truncated") mocks.extract.mockResolvedValue({ success: true, data: { text: importRawText, truncated: true } });
  if (kind === "malformed AI") mocks.execute.mockResolvedValue({ kind: "ok", attemptId: "r", replayed: false, value: { arbitrary: true }, resolvedConnectionId: "c", resolvedModel: "m", managedAiProvenance: null });
  if (kind === "broken assignment") mocks.execute.mockResolvedValue({ kind: "failed", code: "ASSIGNED_CONNECTION_UNAVAILABLE" });
  if (kind === "missing assignment") mocks.execute.mockResolvedValue({ kind: "failed", code: "NOT_CONFIGURED" });
  const response = await POST(kind === "unsupported" ? upload("text", "text/plain") : upload());
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(await response.json())).not.toContain("secret server path");
  expect(mocks.persist).not.toHaveBeenCalled();
  if (["unsupported", "corrupt", "empty", "short", "long", "truncated"].includes(kind)) expect(mocks.execute).not.toHaveBeenCalled();
});
it("preserves the 5 MB size limit", async () => {
  const request = upload(); request.headers.set("content-length", "6000000");
  expect((await POST(request)).status).toBe(413);
  expect(mocks.extract).not.toHaveBeenCalled();
});
it("blocks unauthenticated or disabled runtime", async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await POST(upload())).status).toBe(401);
  mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.gate.mockRejectedValue(new Error("disabled"));
  expect((await POST(upload())).status).toBe(403);
  expect(mocks.extract).not.toHaveBeenCalled();
});
