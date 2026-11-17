import { decodeHistory } from "@/lib/agent/historyCodec";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import db from "@/lib/db";
import {
  MODEL_SPECS,
  modelsForBackup,
  type BackupModel,
} from "./ordering";
import { BackupDataSchema, type BackupData } from "./schema";
import { buildManifest } from "./manifest";
import { stripSensitiveBackupGroups } from "./compat";
import { isResumeFilePath } from "@/lib/resumeFiles";
import {
  isAbsoluteStorageKey,
  logicalCareerAttachmentStorageKey,
  logicalResumeArtifactStorageKey,
  safeEntryName,
} from "./normalize";
import { resolveCareerAttachmentStorageKey } from "@/lib/career/candidateAttachmentService";

type Row = Record<string, unknown>;

// Job and Question need their tag ids, which are not columns; everything else
// reads as-is. Prisma's implicit m2m tables are not models, so this include is
// the only way the join rows reach the file at all.
const TAG_INCLUDE: Partial<Record<BackupModel, Record<string, unknown>>> = {
  Job: { Status: { select: { value: true } }, tags: { select: { id: true } } },
  Question: { tags: { select: { id: true } } },
};

function stripOwnership(model: BackupModel, row: Row): Row {
  const owner = MODEL_SPECS[model].owner;
  if (!owner) return row;
  const { [owner]: _dropped, ...rest } = row;
  return rest;
}

export type CollectBackupOptions = {
  includeSensitiveData?: boolean;
};

function includeSensitiveDataFrom(options?: CollectBackupOptions): boolean {
  return options?.includeSensitiveData === true;
}

export async function collectBackupData(
  userId: string,
  options?: CollectBackupOptions,
): Promise<BackupData> {
  const includeSensitiveData = includeSensitiveDataFrom(options);
  const models = modelsForBackup(includeSensitiveData);
  // Array form: a read-only batch that sees one snapshot without the 5s
  // interactive-transaction timeout. See the spec's Snapshot consistency note.
  const reads = models.map((model) => {
    const spec = MODEL_SPECS[model];
    const delegate = (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Row[]> }>)[
      spec.delegate
    ];
    const include = TAG_INCLUDE[model];
    return delegate.findMany(
      include ? { where: spec.scope(userId), include } : { where: spec.scope(userId) },
    );
  });

  // These two ride inside the same batch, not alongside it. defaultResumeId is
  // exactly the field likely to move mid-export, and a backup naming a resume
  // the file does not contain is the dangling reference the snapshot exists to
  // prevent.
  const batch = [
    ...reads,
    db.user.findUnique({
      where: { id: userId },
      select: { defaultResumeId: true },
    }),
    db.jobStatus.findMany({
      where: { jobs: { some: { userId } } },
      select: { label: true, value: true },
    }),
  ];

  const batchResults = (await db.$transaction(batch as never)) as unknown as unknown[];
  const results = batchResults.slice(0, models.length) as Row[][];
  const userRow = batchResults[models.length] as { defaultResumeId: string | null } | null;
  const statuses = batchResults[models.length + 1] as { label: string; value: string }[];

  const raw: Record<string, unknown> = {};
  const jobToTag: { jobId: string; tagId: string }[] = [];
  const questionToTag: { questionId: string; tagId: string }[] = [];

  // Deterministic export: never rely on database default row order. Rows are
  // sorted by stable primary key so two consecutive exports of the same
  // disposable DB produce identical Interview sections (modulo export
  // timestamp metadata, which lives in the manifest, not data.json).
  const byId = (a: Row, b: Row) =>
    String(a.id ?? "").localeCompare(String(b.id ?? ""));
  models.forEach((model, index) => {
    const sorted = [...results[index]].sort(byId);
    raw[model] = sorted.map((row) => {
      const clean = stripOwnership(model, row);
      if (model === "ChatConversation" && typeof clean.messages === "string") {
        try {
          clean.messages = decodeHistory(clean.messages);
        } catch {
          // A single unreadable (corrupt) encoded row must not sink the whole
          // backup — keep its raw payload so nothing is silently dropped.
        }
      }

      if (model === "Job") {
        const { statusId, Status, tags, ...rest } = clean as Row & {
          Status: { value: string };
          tags: { id: string }[];
        };
        for (const tag of tags ?? []) jobToTag.push({ jobId: rest.id as string, tagId: tag.id });
        return { ...rest, statusValue: Status.value };
      }

      if (model === "Question") {
        const { tags, ...rest } = clean as Row & { tags: { id: string }[] };
        for (const tag of tags ?? []) {
          questionToTag.push({ questionId: rest.id as string, tagId: tag.id });
        }
        return rest;
      }

      if (model === "ResumeArtifact") {
        const artifact = clean as Row & {
          id: string;
          storageKey: string;
          fileName: string;
        };
        const storageKey = isAbsoluteStorageKey(artifact.storageKey)
          ? logicalResumeArtifactStorageKey(artifact.id, artifact.fileName)
          : artifact.storageKey;
        return { ...artifact, storageKey, bytesMissing: true };
      }

      if (model === "CandidateAttachment") {
        const attachment = clean as Row & {
          id: string;
          storageKey: string;
          fileName: string;
        };
        const storageKey = isAbsoluteStorageKey(attachment.storageKey)
          ? logicalCareerAttachmentStorageKey(attachment.id, attachment.fileName)
          : attachment.storageKey;
        return { ...attachment, storageKey };
      }

      return clean;
    });
  });

  raw._JobToTag = jobToTag.sort((a, b) =>
    `${a.jobId}${a.tagId}`.localeCompare(`${b.jobId}${b.tagId}`),
  );
  raw._QuestionToTag = questionToTag.sort((a, b) =>
    `${a.questionId}${a.tagId}`.localeCompare(`${b.questionId}${b.tagId}`),
  );
  raw.jobStatuses = statuses;
  raw.user = { defaultResumeId: userRow?.defaultResumeId ?? null };

  return BackupDataSchema.parse(raw);
}

export async function buildBackupZip(
  userId: string,
  sourceEmail: string,
  options?: CollectBackupOptions,
): Promise<{ buffer: Buffer; fileName: string }> {
  const includeSensitiveData = includeSensitiveDataFrom(options);
  const data = await collectBackupData(userId, { includeSensitiveData });

  // File bytes are read outside the read transaction. A row committed inside
  // the snapshot whose bytes land later is covered by the fileMissing marker.
  const zip = new JSZip();
  for (const file of data.File) {
    // A stored path outside the resumes directory is never read into the zip
    if (!isResumeFilePath(file.filePath)) {
      file.fileMissing = true;
      continue;
    }
    try {
      const bytes = await fs.readFile(file.filePath);
      zip.file(`files/${file.id}/${path.basename(file.filePath)}`, bytes);
    } catch {
      file.fileMissing = true;
    }
  }

  // Attachment bytes travel only inside a sensitive backup: the rows only
  // exist in data when includeSensitiveData is true. The zip entry reuses the
  // logical key layout career-attachments/<id>/<fileName>; the row keeps the
  // metadata and a bytesMissing marker when the source file is unreadable.
  for (const attachment of data.CandidateAttachment) {
    const entryName = `career-attachments/${attachment.id}/${safeEntryName(attachment.fileName)}`;
    try {
      const target = resolveCareerAttachmentStorageKey(attachment.storageKey);
      zip.file(entryName, await fs.readFile(target));
    } catch {
      attachment.bytesMissing = true;
    }
  }

  const manifest = buildManifest(data, sourceEmail, { includeSensitiveData });
  const serialized = includeSensitiveData
    ? data
    : stripSensitiveBackupGroups(data as unknown as Record<string, unknown>);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("data.json", JSON.stringify(serialized));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, fileName: `vocatrya-backup-${stamp}.zip` };
}
