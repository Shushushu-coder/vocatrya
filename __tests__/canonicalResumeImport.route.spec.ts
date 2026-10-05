// @vitest-environment node
import { NextRequest } from "next/server";
import { POST } from "@/app/api/profile/resume-import/route";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), gate: vi.fn(), extract: vi.fn(), preprocess: vi.fn(), execute: vi.fn(), inspect: vi.fn(), persist: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("@/lib/career/capabilities", () => ({ assertResumeV1Writable: mocks.gate }));
vi.mock("@/lib/ai/import/extract-text", async (original) => ({ ...await original<typeof import("@/lib/ai/import/extract-text")>(), extractText: mocks.extract }));
vi.mock("@/lib/ai/tools/preprocessing", () => ({ preprocessText: mocks.preprocess }));
vi.mock("@/lib/ai/structured-execution", () => ({ executeStructuredForAssignment: mocks.execute }));
vi.mock("@/lib/ai/rate-limiter", () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/career/canonicalResumeImport", () => ({ inspectResumeImport: mocks.inspect, persistResumeImport: mocks.persist }));
const upload = (content = "%PDF-test", mime = "application/pdf", filename = "Synthetic.pdf") => {
  const form = new FormData(); form.set("file", new File([content], filename, { type: mime }));
  return new NextRequest("http://localhost/api/profile/resume-import", { method: "POST", body: form });
};
beforeEach(() => {
  mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.gate.mockResolvedValue(undefined);
  mocks.extract.mockResolvedValue({ success: true, data: { text: importRawText, truncated: false } });
  mocks.preprocess.mockResolvedValue({ success: true, data: { normalizedText: "CHANGED BY NORMALIZER" } });
  mocks.execute.mockResolvedValue({ status: "OK", value: importFixture, resolvedConnectionId: "connection", resolvedModel: "model" });
  mocks.inspect.mockResolvedValue({ conflicts: [], created: 4, reused: 0 });
  mocks.persist.mockResolvedValue({ id: "variant" });
});
it("uses raw source for assignment parsing and returns review with zero persistence calls", async () => {
  const response = await POST(upload());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.parsed).toEqual(importFixture);
  expect(mocks.execute.mock.calls[0][0].prompt).toContain(importRawText);
  expect(mocks.execute.mock.calls[0][0].prompt).not.toContain("CHANGED BY NORMALIZER");
  expect(mocks.persist).not.toHaveBeenCalled();
  // Cancel is local draft disposal; no API mutation is needed.
});
it("accepts only an owned signed approval for confirm", async () => {
  const { approval } = await (await POST(upload())).json();
  const confirm = (token: string) => new NextRequest("http://localhost/api/profile/resume-import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval: token }),
  });
  expect((await POST(confirm(approval))).status).toBe(200);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  mocks.auth.mockResolvedValue({ user: { id: "other" } });
  expect((await POST(confirm(approval))).status).toBe(409);
  expect((await POST(confirm("tampered"))).status).toBe(409);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
});
it.each(["unsupported", "corrupt", "empty", "short", "long", "truncated", "malformed AI", "broken assignment", "missing assignment"])("fails %s safely with zero writes", async (kind) => {
  if (kind === "corrupt") mocks.extract.mockResolvedValue({ success: false, error: { code: "EXTRACTION_FAILED", message: "secret server path" } });
  if (kind === "empty" || kind === "short" || kind === "long") mocks.preprocess.mockResolvedValue({ success: false, error: { code: kind === "empty" ? "NO_CONTENT" : kind === "short" ? "TOO_SHORT" : "TOO_LONG" } });
  if (kind === "truncated") mocks.extract.mockResolvedValue({ success: true, data: { text: importRawText, truncated: true } });
  if (kind === "malformed AI") mocks.execute.mockResolvedValue({ status: "OK", value: { arbitrary: true } });
  if (kind === "broken assignment") mocks.execute.mockResolvedValue({ status: "FAILED", code: "ASSIGNED_CONNECTION_UNAVAILABLE" });
  if (kind === "missing assignment") mocks.execute.mockResolvedValue({ status: "NOT_CONFIGURED" });
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
