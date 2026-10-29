// @vitest-environment node
import fs from "node:fs/promises";
import { NextRequest } from "next/server";

const ctx = await vi.hoisted(async () => {
  const { makeResumeExportTestContext } = await import("./helpers/resumeExportTestDb");
  return makeResumeExportTestContext();
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/lib/constants", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/constants")>();
  return { ...original, APP_CONSTANTS: { ...original.APP_CONSTANTS, UPLOADS_DIR: ctx.uploadsRoot } };
});
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import db from "@/lib/db";
import { auth } from "@/auth";
import { getCurrentUser } from "@/utils/user.utils";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { writeInstanceMigrationState } from "@/lib/career/migrationState";
import { POST } from "@/app/api/profile/resume-artifacts/route";
import { GET } from "@/app/api/profile/resume-artifacts/[artifactId]/route";
import ResumePrintPage from "@/app/resume-print/[versionId]/page";
import { findReusableResumeExport } from "@/actions/resumeVariant.actions";
import { MAX_RESUME_PDF_BYTES, resolveResumeArtifactStorageKey } from "@/lib/career/resumeArtifactService";

const bytes = Buffer.from("%PDF-1.7\n中文 résumé\n%%EOF");
let userId: string;
let otherId: string;
let versionId: string;
beforeAll(async () => {
  userId = (await db.user.create({ data: { name: "张三", email: "route-export@example.com", password: "test" } })).id;
  otherId = (await db.user.create({ data: { name: "Other", email: "route-other@example.com", password: "test" } })).id;
  await writeInstanceMigrationState(db, { status: "COMPLETED", completedAt: new Date(), verifiedAt: new Date() });
});
beforeEach(async () => {
  vi.stubEnv("VOCATRYA_AB_RUNTIME_ENABLED", "true");
  vi.stubEnv("VOCATRYA_AB_ROLLOUT_SCOPE", "resume_v1");
  vi.mocked(auth).mockResolvedValue({ user: { id: userId }, expires: "2099-01-01" } as never);
  vi.mocked(getCurrentUser).mockResolvedValue({ id: userId } as never);
  const service = new ResumeVariantService(db, userId);
  const variant = await service.createVariant({ name: "校园", headerSnapshot: '{"fullName":"张三"}' });
  versionId = variant.currentVersionId!;
  await service.freeze(versionId);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => { await db.$disconnect(); await fs.rm(ctx.dir, { recursive: true, force: true }); });

function post(pdf = bytes) {
  return POST(new NextRequest(`http://localhost/api/profile/resume-artifacts?versionId=${versionId}`, {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf,
  }));
}
function download(id: string) {
  return GET(new NextRequest(`http://localhost/api/profile/resume-artifacts/${id}`), { params: Promise.resolve({ artifactId: id }) });
}
const print = () => ResumePrintPage({ params: Promise.resolve({ versionId }) });

it("round trips exact stored bytes with a UTF-8 filename and no storage key in the DTO/action", async () => {
  const response = await post();
  expect(response.status).toBe(201);
  const artifact = await response.json();
  expect(Object.keys(artifact).sort()).toEqual(["byteSize", "createdAt", "fileName", "id", "sha256"]);
  const result = await download(artifact.id);
  expect(result.status).toBe(200);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
  expect(result.headers.get("Content-Type")).toBe("application/pdf");
  const encoded = result.headers.get("Content-Disposition")!.split("filename*=UTF-8''")[1];
  expect(decodeURIComponent(encoded)).toBe("张三_校园.pdf");
  const reusable = await findReusableResumeExport(versionId);
  expect(JSON.parse(JSON.stringify(reusable))).toMatchObject({ success: true, data: artifact });
  if (!reusable.success) throw new Error(reusable.message);
  expect(reusable.data).not.toHaveProperty("storageKey");
  expect((await post()).status).toBe(201);
  expect(await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } })).toBe(1);
});

it("rejects unauthenticated routes, print view and action before data queries", async () => {
  vi.mocked(auth).mockResolvedValue(null as never);
  vi.mocked(getCurrentUser).mockResolvedValue(null);
  const query = vi.spyOn(db.resumeVariantVersion, "findFirst");
  expect((await post()).status).toBe(401);
  expect((await download("missing")).status).toBe(401);
  await expect(print()).rejects.toThrow("NEXT_NOT_FOUND");
  expect((await findReusableResumeExport(versionId)).success).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it.each(["none", "jobs_v1"])("blocks scope %s without artifact queries or writes", async (scope) => {
  vi.stubEnv("VOCATRYA_AB_ROLLOUT_SCOPE", scope);
  const query = vi.spyOn(db.resumeVariantVersion, "findFirst");
  const write = vi.spyOn(fs, "writeFile");
  expect((await post()).status).toBe(403);
  expect((await download("missing")).status).toBe(403);
  await expect(print()).rejects.toThrow("NEXT_NOT_FOUND");
  expect((await findReusableResumeExport(versionId)).success).toBe(false);
  expect(query).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it("does not expose foreign version/artifact data", async () => {
  const { id } = await (await post()).json();
  vi.mocked(auth).mockResolvedValue({ user: { id: otherId } } as never);
  expect((await post()).status).toBe(404);
  expect((await download(id)).status).toBe(404);
  await expect(print()).rejects.toThrow("NEXT_NOT_FOUND");
});

it("reports missing bytes and does not render drafts", async () => {
  const { id } = await (await post()).json();
  const row = await db.resumeArtifact.findUniqueOrThrow({ where: { id } });
  await fs.unlink(resolveResumeArtifactStorageKey(row.storageKey, ctx.uploadsRoot));
  const missing = await download(id);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "ARTIFACT_BYTES_MISSING" });
  await db.resumeVariantVersion.update({ where: { id: versionId }, data: { status: "DRAFT" } });
  await expect(print()).rejects.toThrow("NEXT_NOT_FOUND");
  expect((await post()).status).toBe(400);
});

it("renders an owned immutable graph through the shared preview", async () => {
  const page = await print();
  expect(page.props.children[0].props).toMatchObject({ print: true, headerSnapshot: '{"fullName":"张三","headline":null,"email":null,"phone":null,"address":null,"links":[]}' });
  expect(page.props.children[1].props.versionId).toBe(versionId);
});

it("rejects invalid PDF bytes", async () => {
  const response = await post(Buffer.from("invalid"));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "PDF_INVALID" });
});

it("bounds chunked PDF uploads and rejects a non-PDF content type", async () => {
  const oversize = await post(Buffer.alloc(MAX_RESUME_PDF_BYTES + 1));
  expect(oversize.status).toBe(413);
  expect(await oversize.json()).toMatchObject({ code: "PDF_TOO_LARGE" });
  const invalidType = await POST(new NextRequest(`http://localhost/api/profile/resume-artifacts?versionId=${versionId}`, {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: bytes,
  }));
  expect(invalidType.status).toBe(400);
  expect(await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } })).toBe(0);
  const boundary = Buffer.alloc(MAX_RESUME_PDF_BYTES);
  boundary.write("%PDF-");
  const accepted = await post(boundary);
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toMatchObject({ byteSize: MAX_RESUME_PDF_BYTES });
});

it("generates DOCX on the server and serves its actual MIME type", async () => {
  const response = await POST(new NextRequest(`http://localhost/api/profile/resume-artifacts?versionId=${versionId}&format=DOCX`, { method: "POST" }));
  expect(response.status).toBe(201);
  const artifact = await response.json();
  expect(artifact.fileName).toMatch(/\.docx$/);
  const result = await download(artifact.id);
  expect(result.status).toBe(200);
  expect(result.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(Buffer.from(await result.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
});
it("accepts a DOCX POST framed the way the node runtime frames a bodyless request", async () => {
  // In production every non-GET request exposes a req.body stream — even a
  // bodyless browser POST — so the guard must inspect the stream's actual
  // bytes rather than reject every non-null req.body.
  const response = await POST(new NextRequest(`http://localhost/api/profile/resume-artifacts?versionId=${versionId}&format=DOCX`, {
    method: "POST",
    headers: { "content-length": "0" },
    body: new ReadableStream({ start(controller) { controller.close(); } }),
    duplex: "half",
  }));
  expect(response.status).toBe(201);
  const artifact = await response.json();
  expect(artifact.fileName).toMatch(/\.docx$/);
});
it("rejects client-supplied DOCX bytes and unsupported formats without writing an artifact", async () => {
  const count = await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } });
  for (const format of ["DOCX", "HTML"]) {
    const response = await POST(new NextRequest(`http://localhost/api/profile/resume-artifacts?versionId=${versionId}&format=${format}`, { method: "POST", body: Buffer.from("PK client supplied") }));
    expect(response.status).toBe(400);
  }
  expect(await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } })).toBe(count);
});
