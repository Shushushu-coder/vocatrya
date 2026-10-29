import type { PrismaClient, ResumeArtifact } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APP_CONSTANTS } from "@/lib/constants";
import { assertResumeV1Readable, assertResumeV1Writable } from "./capabilities";
import { CareerRuntimeError } from "./errors";
import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";

export const MAX_RESUME_PDF_BYTES = 20 * 1024 * 1024;

export function resumeExportFileName(headerSnapshot: string | null, variantName: string): string {
  const name = parseResumeHeaderSnapshot(headerSnapshot).fullName;
  if (!name || !variantName.trim()) return "resume.pdf";
  // Reserve space for the extension; avoid splitting a surrogate pair.
  let base = `${name}_${variantName}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim().slice(0, 180).replace(/[\uD800-\uDBFF]$/u, "").replace(/[. ]+$/g, "");
  if (!base) return "resume.pdf";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base}.pdf`;
}

export function buildResumeArtifactStorageKey(artifactId: string, fileName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(artifactId) || !fileName || /[\\/]/.test(fileName) || fileName === "." || fileName === "..") {
    throw new CareerRuntimeError("ARTIFACT_KEY_INVALID", "Invalid artifact storage key");
  }
  return `resume-artifacts/${artifactId}/${fileName}`;
}

export function resolveResumeArtifactStorageKey(key: string, uploadsRoot = APP_CONSTANTS.UPLOADS_DIR): string {
  // Require the logical key form on every platform, including Windows drive/UNC paths.
  if (!/^resume-artifacts\/[a-zA-Z0-9_-]+\/[^/\\]+$/.test(key) || /[\x00-\x1f:]/.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
    throw new CareerRuntimeError("ARTIFACT_KEY_INVALID", "Invalid artifact storage key");
  }
  const root = path.resolve(uploadsRoot);
  const resolved = path.resolve(root, key);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CareerRuntimeError("ARTIFACT_KEY_INVALID", "Invalid artifact storage key");
  }
  return resolved;
}

export function resumeArtifactDTO(artifact: ResumeArtifact) {
  return {
    id: artifact.id,
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt,
  };
}

// The desktop backend is one process. Share pending creates across service instances
// so overlapping POSTs cannot write two artifacts for the same owned version.
const pendingExports = new Map<string, Promise<ResumeArtifact>>();

export class ResumeArtifactService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
    private readonly uploadsRoot = APP_CONSTANTS.UPLOADS_DIR,
  ) {}

  private async ownedVersion(versionId: string) {
    if (typeof versionId !== "string" || !versionId.trim()) {
      throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    }
    const version = await this.db.resumeVariantVersion.findFirst({
      where: { id: versionId, resumeVariant: { userId: this.userId } },
      include: { resumeVariant: true },
    });
    if (!version) throw new CareerRuntimeError("VERSION_NOT_FOUND", "Resume version not found");
    return version;
  }

  private async existingExport(versionId: string, format: "PDF" | "DOCX" = "PDF") {
    const rows = await this.db.resumeArtifact.findMany({
      where: { resumeVariantVersionId: versionId, kind: "EXPORT", format },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of rows) {
      try {
        const stat = await fs.stat(resolveResumeArtifactStorageKey(row.storageKey, this.uploadsRoot));
        if (stat.isFile()) return row;
      } catch (error) {
        if (error instanceof CareerRuntimeError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new CareerRuntimeError("ARTIFACT_READ_FAILED", "Could not read stored resume PDF");
        }
      }
    }
    return null;
  }

  async findReusableExport(versionId: string) {
    await assertResumeV1Readable(this.db, this.env);
    await this.ownedVersion(versionId);
    return this.existingExport(versionId);
  }

  async createExport(versionId: string, bytes: Uint8Array) {
    await assertResumeV1Writable(this.db, this.env);
    const version = await this.ownedVersion(versionId);
    if (version.status !== "FROZEN" && version.status !== "SUBMITTED") {
      throw new CareerRuntimeError("VERSION_NOT_IMMUTABLE", "Freeze the resume version before exporting");
    }
    if (version.resumeVariant.archivedAt) {
      throw new CareerRuntimeError("VARIANT_ARCHIVED", "Archived resumes cannot create exports");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RESUME_PDF_BYTES) {
      throw new CareerRuntimeError("PDF_TOO_LARGE", "PDF exceeds the 20 MB limit");
    }
    if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) {
      throw new CareerRuntimeError("PDF_INVALID", "Invalid PDF bytes");
    }
    const key = `${path.resolve(this.uploadsRoot)}:${this.userId}:${versionId}`;
    const pending = pendingExports.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const existing = await this.existingExport(versionId);
      if (existing) return existing;
      const id = randomUUID();
      const fileName = resumeExportFileName(version.headerSnapshot, version.resumeVariant.name);
      const storageKey = buildResumeArtifactStorageKey(id, fileName);
      const target = resolveResumeArtifactStorageKey(storageKey, this.uploadsRoot);
      const temporary = `${target}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx" });
        await fs.rename(temporary, target);
        return await this.db.resumeArtifact.create({
          data: {
            id, resumeVariantVersionId: versionId, kind: "EXPORT", format: "PDF",
            storageKey, fileName,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byteSize: bytes.byteLength,
          },
        });
      } catch (error) {
        await Promise.all([fs.rm(temporary, { force: true }), fs.rm(target, { force: true })]);
        throw error;
      }
    })();
    pendingExports.set(key, operation);
    try { return await operation; }
    finally { pendingExports.delete(key); }
  }

  async createDocxExport(versionId: string) {
    await assertResumeV1Writable(this.db, this.env);
    const version = await this.ownedVersion(versionId);
    if (version.status !== "FROZEN" && version.status !== "SUBMITTED") throw new CareerRuntimeError("VERSION_NOT_IMMUTABLE", "Freeze the resume version before exporting");
    if (version.resumeVariant.archivedAt) throw new CareerRuntimeError("VARIANT_ARCHIVED", "Archived resumes cannot create exports");
    const key = `${path.resolve(this.uploadsRoot)}:${this.userId}:${versionId}:DOCX`;
    const pending = pendingExports.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const existing = await this.existingExport(versionId, "DOCX");
      if (existing) return existing;
      const { ResumeVariantService } = await import("./resumeVariantService");
      const { buildResumeDocx } = await import("./resumeDocx");
      const graph = await new ResumeVariantService(this.db, this.userId, this.env).getVersion(versionId);
      const bytes = await buildResumeDocx(graph);
      if (bytes.byteLength > MAX_RESUME_PDF_BYTES) throw new CareerRuntimeError("DOCX_TOO_LARGE", "Document exceeds the 20 MB limit");
      const id = randomUUID();
      const fileName = resumeExportFileName(version.headerSnapshot, version.resumeVariant.name).replace(/\.pdf$/, ".docx");
      const storageKey = buildResumeArtifactStorageKey(id, fileName);
      const target = resolveResumeArtifactStorageKey(storageKey, this.uploadsRoot), temporary = `${target}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx" });
        await fs.rename(temporary, target);
        return await this.db.resumeArtifact.create({ data: { id, resumeVariantVersionId: versionId, kind: "EXPORT", format: "DOCX", storageKey, fileName, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.byteLength } });
      } catch (error) {
        await Promise.all([fs.rm(temporary, { force: true }), fs.rm(target, { force: true })]);
        throw error;
      }
    })();
    pendingExports.set(key, operation);
    try { return await operation; } finally { pendingExports.delete(key); }
  }

  async openForDownload(artifactId: string) {
    await assertResumeV1Readable(this.db, this.env);
    if (typeof artifactId !== "string" || !artifactId.trim()) {
      throw new CareerRuntimeError("ARTIFACT_NOT_FOUND", "Resume artifact not found");
    }
    const artifact = await this.db.resumeArtifact.findFirst({
      where: { id: artifactId, kind: "EXPORT", format: { in: ["PDF", "DOCX"] }, version: { resumeVariant: { userId: this.userId } } },
    });
    if (!artifact) throw new CareerRuntimeError("ARTIFACT_NOT_FOUND", "Resume artifact not found");
    try {
      const bytes = await fs.readFile(resolveResumeArtifactStorageKey(artifact.storageKey, this.uploadsRoot));
      return { artifact, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CareerRuntimeError("ARTIFACT_BYTES_MISSING", "Stored resume PDF is missing");
      }
      throw error;
    }
  }
}
