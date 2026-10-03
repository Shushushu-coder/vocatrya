// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { makeResumeExportTestContext } from "./helpers/resumeExportTestDb";
import { ResumeArtifactService, MAX_RESUME_PDF_BYTES, resolveResumeArtifactStorageKey, resumeExportFileName } from "@/lib/career/resumeArtifactService";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { writeInstanceMigrationState } from "@/lib/career/migrationState";
import { logicalResumeArtifactStorageKey } from "@/lib/backup/normalize";

const ctx = makeResumeExportTestContext();
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", VOCATRYA_AB_RUNTIME_ENABLED: "true", VOCATRYA_AB_ROLLOUT_SCOPE: "resume_v1" };
const bytes = Buffer.from("%PDF-1.7\n测试 resume\n%%EOF");
let owner: string;
let other: string;
let versionId: string;
let variantId: string;
const artifacts = (userId = owner) => new ResumeArtifactService(db, userId, env, ctx.uploadsRoot);

beforeAll(async () => {
  owner = (await db.user.create({ data: { name: "Owner", email: "export-owner@example.com", password: "test" } })).id;
  other = (await db.user.create({ data: { name: "Other", email: "export-other@example.com", password: "test" } })).id;
  await writeInstanceMigrationState(db, { status: "COMPLETED", completedAt: new Date(), verifiedAt: new Date() });
});
beforeEach(async () => {
  const created = await new ResumeVariantService(db, owner, env).createVariant({ name: "校园/简历", headerSnapshot: JSON.stringify({ fullName: "张三" }) });
  variantId = created.id;
  versionId = created.currentVersionId!;
  await new ResumeVariantService(db, owner, env).freeze(versionId);
});
afterAll(async () => {
  await db.$disconnect();
  // ctx.dir is the mkdtemp result and always under the OS temp directory.
  await fs.rm(ctx.dir, { recursive: true, force: true });
});

it("stores bytes, hash, size and the backup-compatible logical key; download exposes identical bytes", async () => {
  const artifact = await artifacts().createExport(versionId, bytes);
  expect(artifact).toMatchObject({ kind: "EXPORT", format: "PDF", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: "张三_校园_简历.pdf" });
  expect(artifact.storageKey).toBe(logicalResumeArtifactStorageKey(artifact.id, artifact.fileName));
  expect((await artifacts().openForDownload(artifact.id)).bytes).toEqual(bytes);
  expect(await fs.readFile(path.join(ctx.uploadsRoot, artifact.storageKey))).toEqual(bytes);
});

it("reuses an export across sequential and concurrent service instances", async () => {
  const [first, second] = await Promise.all([artifacts().createExport(versionId, bytes), artifacts().createExport(versionId, Buffer.from("%PDF-other"))]);
  expect(second.id).toBe(first.id);
  expect((await artifacts().createExport(versionId, bytes)).id).toBe(first.id);
  expect(await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } })).toBe(1);
  expect(await fs.readdir(path.dirname(resolveResumeArtifactStorageKey(first.storageKey, ctx.uploadsRoot)))).toEqual([first.fileName]);
});

it("keeps a missing-file row and creates a new artifact", async () => {
  const first = await artifacts().createExport(versionId, bytes);
  await fs.unlink(resolveResumeArtifactStorageKey(first.storageKey, ctx.uploadsRoot));
  expect(await artifacts().findReusableExport(versionId)).toBeNull();
  await expect(artifacts().openForDownload(first.id)).rejects.toMatchObject({ code: "ARTIFACT_BYTES_MISSING" });
  const second = await artifacts().createExport(versionId, bytes);
  expect(second.id).not.toBe(first.id);
  expect(await db.resumeArtifact.findUnique({ where: { id: first.id } })).toEqual(first);
});

it("rejects drafts, archived variants, invalid bytes, oversize and another owner's version/artifact", async () => {
  const draft = await new ResumeVariantService(db, owner, env).createVariant({ name: "Draft" });
  await expect(artifacts().createExport(draft.currentVersionId!, bytes)).rejects.toMatchObject({ code: "VERSION_NOT_IMMUTABLE" });
  await expect(artifacts().createExport(versionId, Buffer.from("not pdf"))).rejects.toMatchObject({ code: "PDF_INVALID" });
  await expect(artifacts().createExport(versionId, new Uint8Array(MAX_RESUME_PDF_BYTES + 1))).rejects.toMatchObject({ code: "PDF_TOO_LARGE" });
  await expect(artifacts(other).createExport(versionId, bytes)).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  await expect(artifacts(other).findReusableExport(versionId)).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  const artifact = await artifacts().createExport(versionId, bytes);
  await expect(artifacts(other).openForDownload(artifact.id)).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  await db.resumeVariant.update({ where: { id: variantId }, data: { archivedAt: new Date() } });
  await expect(artifacts().createExport(versionId, bytes)).rejects.toMatchObject({ code: "VARIANT_ARCHIVED" });
  expect((await artifacts().findReusableExport(versionId))?.id).toBe(artifact.id);
  expect((await artifacts().openForDownload(artifact.id)).bytes).toEqual(bytes);
});

it("accepts submitted versions", async () => {
  await db.resumeVariantVersion.update({ where: { id: versionId }, data: { status: "SUBMITTED" } });
  expect(await artifacts().createExport(versionId, bytes)).toMatchObject({ resumeVariantVersionId: versionId });
});

it("rejects high-bit lookalikes of the PDF signature before writing bytes or creating a row", async () => {
  const write = vi.spyOn(fs, "writeFile");
  await expect(artifacts().createExport(versionId, Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]))).rejects.toMatchObject({ code: "PDF_INVALID" });
  expect(write).not.toHaveBeenCalled();
  expect(await db.resumeArtifact.count({ where: { resumeVariantVersionId: versionId } })).toBe(0);
  write.mockRestore();
});

it("removes bytes if row creation fails", async () => {
  const spy = vi.spyOn(db.resumeArtifact, "create").mockRejectedValueOnce(new Error("row failed"));
  const before = await fs.readdir(path.join(ctx.uploadsRoot, "resume-artifacts"));
  await expect(artifacts().createExport(versionId, bytes)).rejects.toThrow("row failed");
  const after = await fs.readdir(path.join(ctx.uploadsRoot, "resume-artifacts"));
  for (const id of after.filter((id) => !before.includes(id))) expect(await fs.readdir(path.join(ctx.uploadsRoot, "resume-artifacts", id))).toEqual([]);
  spy.mockRestore();
});

it.each(["../x", "resume-artifacts/id/..", "resume-artifacts/../x.pdf", "C:/outside/x.pdf", "/absolute/x.pdf", "\\\\host\\x", "resume-artifacts/id/../../x"])("rejects escaping key %s", (key) => {
  expect(() => resolveResumeArtifactStorageKey(key, ctx.uploadsRoot)).toThrow("Invalid artifact storage key");
});

it("sanitizes Windows names and falls back for an empty header", () => {
  expect(resumeExportFileName(null, "General")).toBe("resume.pdf");
  expect(resumeExportFileName('{"fullName":"A:B?"}', "C<D>\"|\\/*")).toBe("A_B__C_D______.pdf");
});

it("checks write and read gates before domain queries and file writes", async () => {
  const blocked = new ResumeArtifactService(db, owner, { NODE_ENV: "test" }, ctx.uploadsRoot);
  const versionQuery = vi.spyOn(db.resumeVariantVersion, "findFirst");
  const artifactQuery = vi.spyOn(db.resumeArtifact, "findFirst");
  const write = vi.spyOn(fs, "writeFile");
  await expect(blocked.createExport(versionId, bytes)).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
  await expect(blocked.findReusableExport(versionId)).rejects.toMatchObject({ code: "CAREER_READ_NOT_ENABLED" });
  await expect(blocked.openForDownload("missing")).rejects.toMatchObject({ code: "CAREER_READ_NOT_ENABLED" });
  expect(versionQuery).not.toHaveBeenCalled(); expect(artifactQuery).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
