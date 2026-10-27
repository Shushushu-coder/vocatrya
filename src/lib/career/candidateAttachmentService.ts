import type { CandidateAttachment, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APP_CONSTANTS } from "@/lib/constants";
import { sniffAttachmentFileType } from "@/lib/ai/import/extract-text";
import { assertResumeV1Writable } from "./capabilities";
import { assertCareerDataReadable } from "./access";
import { CareerRuntimeError } from "./errors";

export const CAREER_ATTACHMENT_CATEGORY = {
  ID_PHOTO: "ID_PHOTO",
  AWARD_PROOF: "AWARD_PROOF",
  OTHER: "OTHER",
} as const;
export type CareerAttachmentCategory =
  (typeof CAREER_ATTACHMENT_CATEGORY)[keyof typeof CAREER_ATTACHMENT_CATEGORY];

export const MAX_CAREER_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type AttachmentKind = "png" | "jpg" | "pdf";

const ATTACHMENT_MIME: Record<AttachmentKind, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  pdf: "application/pdf",
};

const IMAGE_ONLY_KINDS = new Set<AttachmentKind>(["png", "jpg"]);

function assertCategory(value: string): CareerAttachmentCategory {
  if (
    value !== CAREER_ATTACHMENT_CATEGORY.ID_PHOTO &&
    value !== CAREER_ATTACHMENT_CATEGORY.AWARD_PROOF &&
    value !== CAREER_ATTACHMENT_CATEGORY.OTHER
  ) {
    throw new CareerRuntimeError(
      "ATTACHMENT_CATEGORY_INVALID",
      "Invalid attachment category.",
    );
  }
  return value;
}

function allowedKinds(category: CareerAttachmentCategory): Set<AttachmentKind> {
  return category === CAREER_ATTACHMENT_CATEGORY.ID_PHOTO
    ? IMAGE_ONLY_KINDS
    : new Set<AttachmentKind>(["png", "jpg", "pdf"]);
}

function sanitizeFileName(fileName: string): string {
  const flattened = fileName.replace(/\\/g, "/");
  const base = flattened.split("/").pop()?.trim() ?? "";
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned;
}

export function buildCareerAttachmentStorageKey(
  attachmentId: string,
  fileName: string,
): string {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(attachmentId) ||
    !fileName ||
    /[\\/]/.test(fileName) ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new CareerRuntimeError(
      "ATTACHMENT_KEY_INVALID",
      "Invalid attachment storage key",
    );
  }
  return `career-attachments/${attachmentId}/${fileName}`;
}

// Logical keys live under UPLOADS_DIR/files/. The key never carries an
// absolute path or separators that could escape the attachments root.
export function resolveCareerAttachmentStorageKey(
  key: string,
  uploadsRoot = APP_CONSTANTS.UPLOADS_DIR,
): string {
  if (
    !/^career-attachments\/[a-zA-Z0-9_-]+\/[^/\\]+$/.test(key) ||
    /[\x00-\x1f:]/.test(key) ||
    key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new CareerRuntimeError(
      "ATTACHMENT_KEY_INVALID",
      "Invalid attachment storage key",
    );
  }
  const root = path.resolve(uploadsRoot, "files");
  const resolved = path.resolve(root, key);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CareerRuntimeError(
      "ATTACHMENT_KEY_INVALID",
      "Invalid attachment storage key",
    );
  }
  return resolved;
}

export function careerAttachmentDTO(attachment: CandidateAttachment) {
  return {
    id: attachment.id,
    category: attachment.category,
    materialItemId: attachment.materialItemId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
  };
}

export class CandidateAttachmentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly userId: string,
    private readonly env?: NodeJS.ProcessEnv,
    private readonly uploadsRoot = APP_CONSTANTS.UPLOADS_DIR,
  ) {}

  async list(input: { category?: string; materialItemId?: string } = {}) {
    return this.db.candidateAttachment.findMany({
      where: {
        userId: this.userId,
        archivedAt: null,
        ...(input.category ? { category: input.category } : {}),
        ...(input.materialItemId ? { materialItemId: input.materialItemId } : {}),
      },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  async create(input: {
    category: string;
    fileName: string;
    bytes: Uint8Array;
    materialItemId?: string | null;
  }) {
    await assertResumeV1Writable(this.db, this.env);
    const category = assertCategory(input.category);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new CareerRuntimeError("ATTACHMENT_INVALID", "Invalid attachment bytes");
    }
    if (input.bytes.byteLength > MAX_CAREER_ATTACHMENT_BYTES) {
      throw new CareerRuntimeError(
        "ATTACHMENT_TOO_LARGE",
        "Attachment exceeds the 5 MB limit",
      );
    }
    const kind = sniffAttachmentFileType(Buffer.from(input.bytes));
    if (!kind || !allowedKinds(category).has(kind)) {
      throw new CareerRuntimeError(
        "ATTACHMENT_TYPE_INVALID",
        category === CAREER_ATTACHMENT_CATEGORY.ID_PHOTO
          ? "ID photo must be a JPG or PNG image"
          : "Attachment must be a JPG, PNG or PDF file",
      );
    }
    const materialItemId = input.materialItemId ?? null;
    if (materialItemId) {
      const material = await this.db.careerMaterialItem.findFirst({
        where: { id: materialItemId, userId: this.userId },
        select: { id: true },
      });
      if (!material) {
        throw new CareerRuntimeError(
          "MATERIAL_NOT_FOUND",
          "Career material not found",
        );
      }
    }

    const id = randomUUID();
    const displayName = sanitizeFileName(input.fileName);
    const storedName = `${displayName.replace(/\.[^.]+$/, "")}.${kind}`;
    const storageKey = buildCareerAttachmentStorageKey(id, storedName);
    const target = resolveCareerAttachmentStorageKey(storageKey, this.uploadsRoot);
    const temporary = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, input.bytes, { flag: "wx" });
      await fs.rename(temporary, target);
      return await this.db.candidateAttachment.create({
        data: {
          id,
          userId: this.userId,
          materialItemId,
          category,
          fileName: displayName,
          mimeType: ATTACHMENT_MIME[kind],
          sizeBytes: input.bytes.byteLength,
          storageKey,
        },
      });
    } catch (error) {
      await Promise.all([
        fs.rm(temporary, { force: true }),
        fs.rm(target, { force: true }),
      ]);
      throw error;
    }
  }

  async archive(id: string) {
    await assertResumeV1Writable(this.db, this.env);
    const existing = await this.requireOwned(id);
    return this.db.candidateAttachment.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  }

  async openForDownload(id: string) {
    await assertCareerDataReadable(this.db, this.env);
    const attachment = await this.requireOwned(id);
    try {
      const bytes = await fs.readFile(
        resolveCareerAttachmentStorageKey(attachment.storageKey, this.uploadsRoot),
      );
      return { attachment, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CareerRuntimeError(
          "ATTACHMENT_BYTES_MISSING",
          "Stored attachment is missing",
        );
      }
      throw error;
    }
  }

  private async requireOwned(id: string) {
    const row = await this.db.candidateAttachment.findFirst({
      where: { id, userId: this.userId, archivedAt: null },
    });
    if (!row) {
      throw new CareerRuntimeError("ATTACHMENT_NOT_FOUND", "Attachment not found");
    }
    return row;
  }
}
