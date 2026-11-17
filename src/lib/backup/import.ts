import fs from "fs/promises";
import path from "path";
import type JSZip from "jszip";
import db from "@/lib/db";
import { APP_CONSTANTS, CONTACT_ROLES } from "@/lib/constants";
import { IdMap, buildCreateData } from "./idmap";
import { BackupError, openBackupZip, readManifest } from "./manifest";
import { normalizeBackupData } from "./compat";
import {
  checkImportedAttachment,
  checkImportedFile,
  importedAttachmentPath,
  importedFilePath,
  logicalCareerAttachmentStorageKey,
  logicalResumeArtifactStorageKey,
  normalizeAIConnection,
  normalizeAutomation,
  normalizeAutomationRun,
  safeEntryName,
} from "./normalize";
import { resolveCareerAttachmentStorageKey } from "@/lib/career/candidateAttachmentService";
import {
  DEFERRED_FKS,
  EMPTINESS_MODELS,
  INSERT_ORDER,
  LOOKUP_MODELS,
  MODEL_SPECS,
  QUESTION_BANK_CANONICAL_METADATA_FIELDS,
  QUESTION_BANK_IDENTITY_FIELDS,
  QUESTION_BANK_VERSION_CONFLICT,
  SENSITIVE_BACKUP_MODELS,
  backupDataset,
  modelsForWipe,
  type BackupModel,
} from "./ordering";
import { remapLegacyMigrationMapIds } from "./migrationMap";
import { writeSnapshot } from "./snapshot";
import { log } from "@/lib/telemetry";
import { withRestoredJobReferences } from "@/lib/agent/restoredJobReferences";
import { isResumeFilePath } from "@/lib/resumeFiles";
import { BackupDataSchema, type BackupData, type BackupManifest } from "./schema";

export interface PreflightResult {
  manifest: BackupManifest;
  emailMatches: boolean;
  targetIsEmpty: boolean;
  targetCounts: Record<string, number>;
  wipeCounts: Record<string, number>;
  containsSensitiveData: boolean;
}

// Counts read from the target database, not from the file — the manifest is
// self-reported and cannot be allowed to size the destructive confirmation.
async function countModels(
  userId: string,
  models: readonly BackupModel[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    models.map(async (model) => {
      const spec = MODEL_SPECS[model];
      const delegate = (db as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[
        spec.delegate
      ];
      return [model, await delegate.count({ where: spec.scope(userId) })] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function countTargetContent(
  userId: string,
): Promise<Record<string, number>> {
  return countModels(userId, EMPTINESS_MODELS);
}

export async function countWipeTargets(
  userId: string,
  containsSensitiveData: boolean,
): Promise<Record<string, number>> {
  return countModels(userId, modelsForWipe(containsSensitiveData));
}

// Reads manifest.json and validates data.json, writes nothing to the database
// and nothing to disk. Data is normalized before any wipe can run.
export async function preflightBackup(
  bytes: Buffer,
  userId: string,
  userEmail: string,
): Promise<PreflightResult> {
  const zip = await openBackupZip(bytes);
  const manifest = await readManifest(zip);

  if (!zip.file("data.json")) {
    throw new BackupError("Backup is missing data.json.");
  }
  await readData(zip, manifest.containsSensitiveData === true);

  const containsSensitiveData = manifest.containsSensitiveData === true;
  const emptinessModels = containsSensitiveData
    ? [...EMPTINESS_MODELS, ...SENSITIVE_BACKUP_MODELS]
    : EMPTINESS_MODELS;
  const targetCounts = await countModels(userId, emptinessModels);
  const wipeCounts = await countWipeTargets(userId, containsSensitiveData);
  const targetIsEmpty = Object.values(targetCounts).every((n) => n === 0);

  return {
    manifest,
    emailMatches: manifest.sourceEmail === userEmail,
    targetIsEmpty,
    targetCounts,
    wipeCounts,
    containsSensitiveData,
  };
}

export interface ImportResult {
  counts: Record<string, number>;
  filesWritten: number;
  // Where the previous state went, so the UI can tell the user it exists.
  snapshotPath: string | null;
}

type Tx = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;

async function readData(
  zip: JSZip,
  containsSensitiveData: boolean,
): Promise<BackupData> {
  const entry = zip.file("data.json");
  if (!entry) throw new BackupError("Backup is missing data.json.");
  let raw: unknown;
  try {
    raw = JSON.parse(await entry.async("string"));
  } catch {
    throw new BackupError("data.json is not valid JSON.");
  }
  const normalized = normalizeBackupData(raw, containsSensitiveData);
  const parsed = BackupDataSchema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BackupError(
      `Backup data failed validation: ${issue?.path.join(".")} ${issue?.code}`,
    );
  }
  return parsed.data;
}

// The scheduler holds a live handle to an in-flight run and a partial unique
// index enforces one per automation, so deleting it mid-flight is not a
// contention problem the "database busy" retry covers.
async function assertNoActiveRun(userId: string): Promise<void> {
  const active = await db.automationRun.findFirst({
    where: {
      status: { in: ["running", "cancelling"] },
      automation: { userId },
    },
    select: { id: true },
  });
  if (active) {
    throw new BackupError(
      "An automation run is in progress. Wait for it to finish, then import again.",
    );
  }
}

// Resolved against the target's global JobStatus table, creating any the target
// lacks from the carried label/value. Runs before the transaction: it is the
// only write outside the user's own data and it is idempotent.
async function resolveJobStatuses(
  data: BackupData,
): Promise<Map<string, string>> {
  const byValue = new Map<string, string>();
  const existing = await db.jobStatus.findMany({ select: { id: true, value: true } });
  for (const row of existing) byValue.set(row.value, row.id);

  for (const status of data.jobStatuses) {
    if (byValue.has(status.value)) continue;
    const created = await db.jobStatus.create({
      data: { label: status.label, value: status.value },
    });
    byValue.set(created.value, created.id);
  }
  return byValue;
}

// QuestionBank reference resolver (spec v1 §9–§13, frozen).
// Natural identity: (bankKey, version). Canonical metadata: title/locale/kind.
// Comparison ignores id/createdAt/updatedAt. Missing → CREATE, equal → REUSE
// existing target id, conflict → throw QUESTION_BANK_VERSION_CONFLICT.
// Never overwrite/update/delete/duplicate, never silently prefer either side.
// Must run inside the restore transaction before any QuestionBankItem insert
// so membership bankId can map source → final target id; a conflict aborts the
// whole transaction (atomic rollback, no partial wipe/insert residue).
type QuestionBankRow = Record<string, unknown> & { id: string };

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function canonicalFieldEqual(a: unknown, b: unknown): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left === "object" && typeof right === "object") {
    return stableStringify(left) === stableStringify(right);
  }
  if (typeof left === "string" && typeof right === "string") {
    const parsedLeft = tryParseJson(left);
    const parsedRight = tryParseJson(right);
    if (parsedLeft !== undefined && parsedRight !== undefined) {
      return stableStringify(parsedLeft) === stableStringify(parsedRight);
    }
    return false;
  }
  return false;
}

function diffQuestionBankCanonicalFields(
  a: QuestionBankRow,
  b: QuestionBankRow,
): string[] {
  const differing: string[] = [];
  for (const field of [
    ...QUESTION_BANK_IDENTITY_FIELDS,
    ...QUESTION_BANK_CANONICAL_METADATA_FIELDS,
  ] as const) {
    if (!canonicalFieldEqual(a[field], b[field])) differing.push(field);
  }
  return differing;
}

function sameCanonicalBank(a: QuestionBankRow, b: QuestionBankRow): boolean {
  if (String(a.bankKey) !== String(b.bankKey)) return false;
  if (String(a.version) !== String(b.version)) return false;
  return diffQuestionBankCanonicalFields(a, b).length === 0;
}

async function resolveQuestionBanks(
  tx: Tx,
  data: BackupData,
  idMap: IdMap,
  userId: string,
): Promise<void> {
  const rows = (data as unknown as Record<string, QuestionBankRow[]>).QuestionBank ?? [];
  for (const backupBank of rows) {
    const bankKey = String(backupBank.bankKey);
    const version = String(backupBank.version);
    const existing = (await tx.questionBank.findUnique({
      where: { bankKey_version: { bankKey, version } },
    })) as unknown as QuestionBankRow | null;
    if (!existing) {
      const newId = idMap.mint(String(backupBank.id));
      const payload = buildCreateData("QuestionBank", backupBank, idMap, userId);
      // buildCreateData minted-mapping already set newId above; ensure the
      // created row keeps the reference snapshot's canonical metadata with a
      // new local id (id/createdAt from backup are not identity).
      await tx.questionBank.create({
        data: {
          ...(payload as Record<string, unknown>),
          id: newId,
          bankKey,
          version,
          title: backupBank.title as string,
          locale: backupBank.locale as string,
          kind: backupBank.kind as string,
        },
      });
      continue;
    }
    if (sameCanonicalBank(backupBank, existing)) {
      // REUSE: do not update the existing row; map source id → existing id.
      idMap.set(String(backupBank.id), String(existing.id));
      continue;
    }
    const differing = diffQuestionBankCanonicalFields(backupBank, existing);
    throw new BackupError(
      `${QUESTION_BANK_VERSION_CONFLICT}: bankKey=${bankKey} version=${version} ` +
        `differs in ${differing.join(",") || "canonical-metadata"}. ` +
        `Target bank is left unchanged; restore aborted atomically.`,
    );
  }
}

// Straight inserts, no upsert. The wipe on the line above deleted every lookup
// row this user owned, so there is nothing left to resolve against — an
// "existing row" check here can never match. Replace-not-merge is the point:
// post-import counts equal the manifest for every table.
async function insertLookups(
  tx: Tx,
  data: BackupData,
  idMap: IdMap,
  userId: string,
): Promise<void> {
  for (const model of LOOKUP_MODELS) {
    const spec = MODEL_SPECS[model];
    for (const row of (data as unknown as Record<string, { id: string; value: string }[]>)[model]) {
      const newId = idMap.mint(row.id);
      const { id: _old, ...rest } = row;
      await tx[spec.delegate].create({
        data: { ...rest, id: newId, createdBy: userId },
      });
    }
  }
}

async function wipe(
  tx: Tx,
  userId: string,
  containsSensitiveData: boolean,
): Promise<void> {
  // Null the back-reference first: User.defaultResumeId is a foreign key into
  // a table the wipe is about to empty.
  await tx.user.update({
    where: { id: userId },
    data: { defaultResumeId: null },
  });

  // ChatConversation is backed up and wiped through the standard model
  // pipeline — its AI lock columns ride the same row. ApiKey and
  // McpAccessToken remain deliberately absent from backup and wipe.
  // Operational telemetry is not in the ZIP; leftover RUNNING rows would lie.
  await tx.dataMigrationRun.deleteMany({ where: { userId } });

  // Restrict self-FKs (parentVersionId) and current-pointer cycles must be
  // cleared before deleteMany, or SQLite refuses the wipe.
  for (const { model, field } of DEFERRED_FKS) {
    const spec = MODEL_SPECS[model];
    await tx[spec.delegate].updateMany({
      where: spec.scope(userId),
      data: { [field]: null },
    });
  }

  // File and Summary are scoped through back-relations (Resume points at
  // File, ResumeSection points at Summary), and DELETE_ORDER removes those
  // rows first — resolving the scope at delete time would match nothing.
  // Capture the ids up front, then delete by id after the generic pass.
  const backRelationScoped: BackupModel[] = ["File", "Summary"];
  const pendingWipeIds = new Map<string, string[]>();
  for (const model of backRelationScoped) {
    const spec = MODEL_SPECS[model];
    const rows = (await tx[spec.delegate].findMany({
      where: spec.scope(userId),
      select: { id: true },
    })) as { id: string }[];
    pendingWipeIds.set(
      model,
      rows.map((row) => row.id),
    );
  }

  for (const model of modelsForWipe(containsSensitiveData)) {
    // QuestionBank has MODEL_SPECS.wipeMode "none" so it never appears here
    // (spec v1 §15: QuestionBank ∉ per-user wipe; unrelated canonical banks
    // survive). There is intentionally no deleteMany QuestionBank in this flow.
    const spec = MODEL_SPECS[model];
    await tx[spec.delegate].deleteMany({ where: spec.scope(userId) });
  }

  for (const model of backRelationScoped) {
    const spec = MODEL_SPECS[model];
    const ids = pendingWipeIds.get(model)!;
    if (ids.length > 0) {
      await tx[spec.delegate].deleteMany({ where: { id: { in: ids } } });
    }
  }
}

async function patchDeferredForeignKeys(
  tx: Tx,
  data: BackupData,
  idMap: IdMap,
): Promise<void> {
  for (const { model, field } of DEFERRED_FKS) {
    const spec = MODEL_SPECS[model];
    for (const row of rowsFor(data, model)) {
      const original = row[field];
      if (original === null || original === undefined) continue;
      const mapped = idMap.get(original as string);
      if (!mapped) {
        throw new BackupError(
          `Restore failed: ${model}.${field} points at ${String(original)}, which is not in the backup.`,
        );
      }
      const rowId = idMap.get(row.id as string);
      if (!rowId) {
        throw new BackupError(`Restore failed: ${model} row ${String(row.id)} has no minted id.`);
      }
      await tx[spec.delegate].update({
        where: { id: rowId },
        data: { [field]: mapped },
      });
    }
  }
}

function rowsFor(data: BackupData, model: BackupModel): Record<string, unknown>[] {
  return (data as unknown as Record<string, Record<string, unknown>[]>)[model];
}

// Conversation context items and historical tool results store entity ids at
// fixed paths (conversationContext.ts isContextItem; agent tool result types).
// IdMap is fully minted before any insert, including JobOpportunity, which is
// later in INSERT_ORDER than ChatConversation. Only those paths are rewritten,
// and only when the old id belongs to that entity set. Prose, code, message
// ids, tool-call ids, label snapshots and unrecognized message payloads stay
// unchanged. Separate restore provenance is added to context below.
// A dangling id is left in place; malformed JSON is not parsed away.
type EntityIdSets = {
  job: ReadonlySet<string>;
  resume: ReadonlySet<string>;
  coverLetter: ReadonlySet<string>;
};

function mintedSourceIds(
  data: BackupData,
  models: readonly BackupModel[],
  idMap: IdMap,
  containsSensitiveData: boolean,
): Set<string> {
  const ids = new Set<string>();
  for (const model of models) {
    if (model === "QuestionBank" || MODEL_SPECS[model].lookup) continue;
    if (backupDataset(model) === "sensitive" && !containsSensitiveData) continue;
    for (const row of rowsFor(data, model)) {
      const id = row.id;
      if (typeof id === "string" && idMap.get(id)) ids.add(id);
    }
  }
  return ids;
}

function mappedEntityId(
  value: unknown,
  allowed: ReadonlySet<string>,
  idMap: IdMap,
): string | null {
  if (typeof value !== "string" || !allowed.has(value)) return null;
  const next = idMap.get(value);
  if (!next || next === value) return null;
  return next;
}

function remapField(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  idMap: IdMap,
): boolean {
  const next = mappedEntityId(record[key], allowed, idMap);
  if (!next) return false;
  record[key] = next;
  return true;
}

function remapRecordField(
  parent: Record<string, unknown>,
  key: string,
  visit: (child: Record<string, unknown>) => boolean,
): boolean {
  const child = parent[key];
  if (!child || typeof child !== "object" || Array.isArray(child)) return false;
  return visit(child as Record<string, unknown>);
}

function remapObjectArrayIds(
  parent: Record<string, unknown>,
  key: string,
  idKey: string,
  allowed: ReadonlySet<string>,
  idMap: IdMap,
): boolean {
  const list = parent[key];
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    changed = remapField(item as Record<string, unknown>, idKey, allowed, idMap) || changed;
  }
  return changed;
}

function toolNameOf(part: Record<string, unknown>): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return null;
}

function remapToolPart(
  part: Record<string, unknown>,
  maps: EntityIdSets,
  idMap: IdMap,
): boolean {
  const name = toolNameOf(part);
  if (!name) return false;
  if (name === "get_job") {
    const inputChanged = remapRecordField(part, "input", (input) =>
      remapField(input, "jobId", maps.job, idMap));
    const outputChanged = remapRecordField(part, "output", (output) =>
      remapRecordField(output, "job", (job) => remapField(job, "id", maps.job, idMap)));
    return inputChanged || outputChanged;
  }
  if (name === "list_jobs") {
    return remapRecordField(part, "output", (output) =>
      remapObjectArrayIds(output, "jobs", "id", maps.job, idMap));
  }
  if (name === "add_job") {
    return remapRecordField(part, "output", (output) => {
      const jobId = remapField(output, "jobId", maps.job, idMap);
      const opportunityId = remapField(output, "jobOpportunityId", maps.job, idMap);
      const duplicateId = remapRecordField(output, "duplicateOf", (duplicate) =>
        remapField(duplicate, "id", maps.job, idMap));
      return jobId || opportunityId || duplicateId;
    });
  }
  if (name === "match_job" || name === "generate_cover_letter") {
    return remapRecordField(part, "output", (output) => {
      const jobId = remapField(output, "jobId", maps.job, idMap);
      const resumeId = remapField(output, "resumeId", maps.resume, idMap);
      const choices = remapObjectArrayIds(output, "resumes", "id", maps.resume, idMap);
      const letterId = name === "generate_cover_letter"
        ? remapField(output, "coverLetterId", maps.coverLetter, idMap)
        : false;
      return jobId || resumeId || choices || letterId;
    });
  }
  if (name === "get_resume" || name === "review_resume") {
    return remapRecordField(part, "output", (output) => {
      const resumeId = remapField(output, "resumeId", maps.resume, idMap);
      const choices = remapObjectArrayIds(output, "resumes", "id", maps.resume, idMap);
      return resumeId || choices;
    });
  }
  return false;
}

// Same predicate as isContextItem in conversationContext.ts. Items that fail
// it are preserved and not scanned for similarly named fields.
function isRemappableContextItem(value: unknown): value is {
  kind: "job" | "resume";
  entityId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "job" || item.kind === "resume") &&
    typeof item.entityId === "string" &&
    item.entityId.length > 0 &&
    typeof item.labelSnapshot === "string" &&
    (item.source === "AUTO" || item.source === "MANUAL")
  );
}

function remapConversationContext(
  serialized: unknown,
  jobIds: ReadonlySet<string>,
  resumeIds: ReadonlySet<string>,
  idMap: IdMap,
): unknown {
  if (typeof serialized !== "string") return serialized;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return serialized;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.items)) return serialized;
  // Restoring data must never revive Full access or automatic approval.
  let changed = "permissionMode" in record;
  delete record.permissionMode;
  for (const item of record.items) {
    if (!isRemappableContextItem(item)) continue;
    const allowed = item.kind === "job" ? jobIds : resumeIds;
    changed = remapField(item as Record<string, unknown>, "entityId", allowed, idMap) || changed;
  }
  return changed ? JSON.stringify(parsed) : serialized;
}

function remapConversationMessages(
  serialized: unknown,
  maps: EntityIdSets,
  idMap: IdMap,
): unknown {
  if (typeof serialized !== "string") return serialized;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  if (!Array.isArray(parsed)) return serialized;
  let changed = false;
  for (const message of parsed) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const parts = (message as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      changed = remapToolPart(part as Record<string, unknown>, maps, idMap) || changed;
    }
  }
  return changed ? JSON.stringify(parsed) : serialized;
}

// The prep-goal handoff snapshot embeds the ids of the entities it
// verified (the goal itself, job, pinned/current JD versions, bound
// session, summary generation). Every one was minted up front, so a deep
// rewrite against the id map keeps the restored snapshot coherent — it is
// still recomputed from live rows on the next read, but it must never
// reference pre-restore ids.
function remapEmbeddedIds(value: unknown, idMap: IdMap): unknown {
  if (typeof value === "string") return idMap.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((item) => remapEmbeddedIds(item, idMap));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = remapEmbeddedIds(item, idMap);
    }
    return out;
  }
  return value;
}

function remapPrepHandoff(serialized: unknown, idMap: IdMap): unknown {
  if (serialized === null || serialized === undefined) return serialized;
  if (typeof serialized !== "string") return serialized;
  try {
    return JSON.stringify(remapEmbeddedIds(JSON.parse(serialized), idMap));
  } catch {
    // Malformed snapshots stay verbatim: the reader treats an unparsable
    // snapshot as absent and rebuilds it deterministically.
    return serialized;
  }
}

export async function importBackup(
  bytes: Buffer,
  userId: string,
  userEmail: string,
  confirmWipe: boolean,
): Promise<ImportResult> {
  // A JWT session outlives the database it was minted against: a container
  // with a fresh dev.db still accepts the old cookie, and every scoped read
  // returns empty instead of failing. wipe()'s user.update is the only
  // statement that needs the row itself, so without this the import dies
  // mid-transaction on an opaque P2025.
  const owner = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!owner) {
    throw new BackupError(
      "Your sign-in is out of date. Sign out, sign in again, then retry the import.",
    );
  }

  const zip = await openBackupZip(bytes);
  const manifest = await readManifest(zip);
  const containsSensitiveData = manifest.containsSensitiveData === true;
  const data = await readData(zip, containsSensitiveData);

  const emptinessModels = containsSensitiveData
    ? [...EMPTINESS_MODELS, ...SENSITIVE_BACKUP_MODELS]
    : EMPTINESS_MODELS;
  const targetCounts = await countModels(userId, emptinessModels);
  const targetIsEmpty = Object.values(targetCounts).every((n) => n === 0);
  if (!targetIsEmpty && !confirmWipe) {
    throw new BackupError(
      "This account already holds data. Confirm that you want it replaced before importing.",
    );
  }

  await assertNoActiveRun(userId);

  // The safety net, and the last thing that happens before this function is
  // able to destroy anything. The transaction below protects against a crash;
  // nothing except this protects against importing the wrong file. Skipped on
  // an empty target because there is nothing to snapshot.
  let snapshotPath: string | null = null;
  if (!targetIsEmpty) {
    snapshotPath = await writeSnapshot(userId, userEmail);
  }

  const statusByValue = await resolveJobStatuses(data);

  // Mint every non-lookup id up front so the file writes below can name their
  // targets, and so a forward reference in the FK rewrite never misses.
  // QuestionBank is excluded: it resolves by natural key (bankKey, version)
  // inside the transaction (missing → CREATE, equal → REUSE existing id,
  // conflict → QUESTION_BANK_VERSION_CONFLICT), so its source ids must not be
  // pre-minted to fresh UUIDs.
  const idMap = new IdMap();
  for (const model of INSERT_ORDER) {
    if (model === "QuestionBank") continue;
    if (MODEL_SPECS[model].lookup) continue;
    if (backupDataset(model) === "sensitive" && !containsSensitiveData) continue;
    for (const row of rowsFor(data, model)) idMap.mint(row.id as string);
  }
  const jobReferenceIds = mintedSourceIds(
    data,
    ["Job", "JobOpportunity"],
    idMap,
    containsSensitiveData,
  );
  const resumeReferenceIds = mintedSourceIds(
    data,
    ["Resume", "ResumeVariant"],
    idMap,
    containsSensitiveData,
  );
  const coverLetterReferenceIds = mintedSourceIds(
    data,
    ["CoverLetter"],
    idMap,
    containsSensitiveData,
  );
  const conversationReferenceIds: EntityIdSets = {
    job: jobReferenceIds,
    resume: resumeReferenceIds,
    coverLetter: coverLetterReferenceIds,
  };

  // Capture every historically mentioned job, including prose and unknown
  // tool payloads, before rewriting structured ids. Do this before imported
  // file writes or destructive database work (the safety snapshot stays).
  // An unrepresentable context fails
  // closed rather than restoring history that can evade the archive guard.
  const restoredConversations = new Map<string, { context: unknown; messages: unknown }>();
  for (const row of rowsFor(data, "ChatConversation")) {
    const source = JSON.stringify([row.context, row.messages]);
    const references = [...jobReferenceIds]
      .filter((id) => source.includes(id))
      .map((id) => idMap.get(id)!);
    const context = remapConversationContext(row.context, jobReferenceIds, resumeReferenceIds, idMap);
    try {
      restoredConversations.set(row.id as string, {
        context: withRestoredJobReferences(context as string | null, references),
        messages: remapConversationMessages(row.messages, conversationReferenceIds, idMap),
      });
    } catch {
      throw new BackupError(
        "Cannot safely restore conversation job references: invalid context. Import cancelled; nothing was changed. / 对话上下文无效，无法安全恢复职位关联，已取消导入，数据未更改。",
      );
    }
  }

  // Files are written before the transaction: a failed import leaves orphaned
  // bytes (unlinked below) rather than committed rows pointing at nothing.
  const writtenPaths: string[] = [];
  const uploadDir = path.join(APP_CONSTANTS.UPLOADS_DIR, "files", "resumes");
  await fs.mkdir(uploadDir, { recursive: true });

  // filePath and fileType are both rebuilt here; neither is taken from the
  // payload. A row whose bytes are absent, oversized or not really a resume
  // keeps its row and loses its file — the same end state as an export whose
  // bytes had already gone missing, which the schema already models.
  const newFilePaths = new Map<string, string>();
  const newFileTypes = new Map<string, string>();
  const rejectedFiles: string[] = [];

  for (const file of data.File) {
    const newId = idMap.get(file.id)!;
    const prefix = `files/${file.id}/`;
    // A prefix scan, not `new RegExp(prefix)`: file.id comes out of the
    // payload, and interpolating it into a pattern hands an untrusted string
    // to the regex engine for no gain over startsWith.
    const entry =
      zip.file(`${prefix}${safeEntryName(file.filePath)}`) ??
      Object.keys(zip.files)
        .filter((name) => name.startsWith(prefix) && !zip.files[name].dir)
        .map((name) => zip.files[name])[0] ??
      null;

    if (!entry || file.fileMissing) {
      newFilePaths.set(file.id, importedFilePath(newId, file.filePath, "pdf"));
      continue;
    }

    const bytes = await entry.async("nodebuffer");
    const checked = checkImportedFile(bytes);
    if (!checked) {
      rejectedFiles.push(file.fileName);
      newFilePaths.set(file.id, importedFilePath(newId, file.filePath, "pdf"));
      continue;
    }

    const target = importedFilePath(newId, entry.name, checked.kind);
    newFilePaths.set(file.id, target);
    newFileTypes.set(file.id, checked.mimeType);
    await fs.writeFile(target, bytes);
    writtenPaths.push(target);
  }

  if (rejectedFiles.length > 0) {
    log.warn("[Backup] Dropped file entries that are not resumes", {
      "backup.rejected_file_count": rejectedFiles.length,
      "backup.rejected_file_names": rejectedFiles.join(", "),
    });
  }

  // CandidateAttachment bytes ride in the zip only inside a sensitive backup,
  // so this loop is a no-op for standard restores. Same shape as the resume
  // file pass above: bytes are written before the transaction, mimeType and
  // storageKey are rebuilt server-side and never trusted from the payload,
  // and a row whose bytes are absent or rejected keeps its metadata.
  const newAttachmentKeys = new Map<string, string>();
  const newAttachmentMimes = new Map<string, string>();
  const newAttachmentSizes = new Map<string, number>();
  const rejectedAttachments: string[] = [];

  for (const attachment of data.CandidateAttachment) {
    const newId = idMap.get(attachment.id)!;
    const prefix = `career-attachments/${attachment.id}/`;
    const entry =
      zip.file(`${prefix}${safeEntryName(attachment.fileName)}`) ??
      Object.keys(zip.files)
        .filter((name) => name.startsWith(prefix) && !zip.files[name].dir)
        .map((name) => zip.files[name])[0] ??
      null;
    const fallbackKey = logicalCareerAttachmentStorageKey(
      newId,
      attachment.fileName,
    );

    if (!entry || attachment.bytesMissing) {
      newAttachmentKeys.set(attachment.id, fallbackKey);
      continue;
    }

    const bytes = await entry.async("nodebuffer");
    const checked = checkImportedAttachment(bytes, attachment.category);
    if (!checked) {
      rejectedAttachments.push(attachment.fileName);
      newAttachmentKeys.set(attachment.id, fallbackKey);
      continue;
    }

    const target = importedAttachmentPath(newId, entry.name, checked.kind);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    writtenPaths.push(target);
    newAttachmentKeys.set(
      attachment.id,
      logicalCareerAttachmentStorageKey(newId, path.basename(target)),
    );
    newAttachmentMimes.set(attachment.id, checked.mimeType);
    newAttachmentSizes.set(attachment.id, bytes.length);
  }

  if (rejectedAttachments.length > 0) {
    log.warn("[Backup] Dropped attachment entries that failed validation", {
      "backup.rejected_attachment_count": rejectedAttachments.length,
      "backup.rejected_attachment_names": rejectedAttachments.join(", "),
    });
  }

  // Captured before the wipe so the old bytes can be unlinked after it commits.
  const oldFilePaths = (
    await db.file.findMany({
      where: MODEL_SPECS.File.scope(userId),
      select: { filePath: true },
    })
  ).map((f) => f.filePath);

  // Attachment rows are only wiped on a sensitive restore; on a standard
  // restore they keep their files and this list stays empty.
  const oldAttachmentPaths = containsSensitiveData
    ? (
        await db.candidateAttachment.findMany({
          where: { userId },
          select: { storageKey: true },
        })
      )
        .map((a) => {
          try {
            return resolveCareerAttachmentStorageKey(a.storageKey);
          } catch {
            return null;
          }
        })
        .filter((p): p is string => p !== null)
    : [];

  const counts: Record<string, number> = {};

  try {
    await db.$transaction(
      async (transaction) => {
        const tx = transaction as unknown as Tx;

        await wipe(tx, userId, containsSensitiveData);
        await insertLookups(tx, data, idMap, userId);

        // A backup from before contacts carries no roles, and the wipe above
        // just deleted the seeded ones — reseed rather than leave none.
        if (manifest.counts.ContactRole === undefined && data.ContactRole.length === 0) {
          await tx.contactRole.createMany({
            data: CONTACT_ROLES.map((role) => ({
              label: role.label,
              value: role.value,
              createdBy: userId,
            })),
          });
        }

        // QuestionBank reference resolution must precede every QuestionBankItem
        // insert (restore topology: resolve reference banks → insert user-scoped
        // memberships). It runs inside the same atomic transaction so a
        // QUESTION_BANK_VERSION_CONFLICT rolls back wipe + all inserts.
        await resolveQuestionBanks(tx, data, idMap, userId);
        counts.QuestionBank = (
          (data as unknown as Record<string, unknown[]>).QuestionBank ?? []
        ).length;

        for (const model of INSERT_ORDER) {
          if (model === "QuestionBank") continue;
          if (MODEL_SPECS[model].lookup) continue;
          if (backupDataset(model) === "sensitive" && !containsSensitiveData) {
            continue;
          }
          const spec = MODEL_SPECS[model];
          const rows = rowsFor(data, model);
          counts[model] = rows.length;

          for (const row of rows) {
            let payload = buildCreateData(model, row, idMap, userId);

            // TranscriptRevision author rule (spec v1 §19, frozen):
            // TRANSCRIPT_REVISION_AUTHOR_POLICY:
            // NORMALIZED_TO_IMPORTING_USER_ON_CROSS_USER_RESTORE
            // PROVENANCE_TRADEOFF: KNOWN_PROVENANCE_TRADEOFF —
            // original author identity is not preserved across cross-user restore
            // (ownership consistency > original author provenance). Same-user
            // restore is semantically unchanged (same id rewrite is a no-op);
            // null author stays null. createdByUserId points at User, which is
            // intentionally never in the backup: attribute the restored
            // revision to the importing user instead of replaying a stale
            // cross-account id that would violate the Restrict FK.
            if (model === "ChatConversation") {
              // Restored history starts inactive. A backup cannot grant execution authority.
              payload.revision = 0;
              payload.activeRequestId = null;
              payload.activeRequestExpiresAt = null;
              const restored = restoredConversations.get(row.id as string)!;
              payload.context = restored.context;
              payload.messages = restored.messages;
            }
            if (model === "AgentOperationProposal") {
              // Runtime links are never restored: HarnessTask does not
              // travel in the backup, and a stale task id must never
              // impersonate a live execution. dispatchKey/dispatchedAt stay
              // — they are evidence the call may already be out.
              payload.harnessTaskId = null;
            }
            if (model === "InterviewPrepGoal") {
              payload = {
                ...payload,
                handoffJson: remapPrepHandoff(row.handoffJson, idMap),
              };
            }
            if (model === "TranscriptRevision") {
              if (payload.createdByUserId !== null && payload.createdByUserId !== undefined) {
                payload = { ...payload, createdByUserId: userId };
              }
            }

            if (model === "File") {
              const { fileMissing: _marker, ...rest } = payload;
              payload = {
                ...rest,
                filePath: newFilePaths.get(row.id as string)!,
                // From the sniff, never the payload. The fallback only reaches
                // rows whose bytes were absent or rejected, where the column
                // describes a file that is not on disk either way.
                fileType: newFileTypes.get(row.id as string) ?? "application/pdf",
              };
            }
            if (model === "Job") {
              const { statusValue, ...rest } = payload as { statusValue: string };
              payload = { ...rest, statusId: statusByValue.get(statusValue)! };
            }
            if (model === "Automation") {
              payload = normalizeAutomation(payload as never);
            }
            if (model === "AutomationRun") {
              payload = normalizeAutomationRun(payload as never);
            }
            // Credentials never travel in a backup: a CONNECTED
            // ACCOUNT_LOGIN row must come back demanding re-auth.
            if (model === "AIConnection") {
              payload = normalizeAIConnection(payload as never);
            }
            if (model === "ResumeArtifact") {
              const { bytesMissing: _marker, storageKey: _ignored, ...rest } = payload;
              payload = {
                ...rest,
                storageKey: logicalResumeArtifactStorageKey(
                  rest.id as string,
                  row.fileName as string,
                ),
              };
            }
            if (model === "CandidateAttachment") {
              const {
                bytesMissing: _marker,
                storageKey: _ignored,
                mimeType: _payloadMime,
                ...rest
              } = payload;
              payload = {
                ...rest,
                storageKey: newAttachmentKeys.get(row.id as string)!,
                // From the sniff, never the payload; falls back to the carried
                // value only for rows whose bytes never landed.
                mimeType:
                  newAttachmentMimes.get(row.id as string) ??
                  (row.mimeType as string),
                sizeBytes:
                  newAttachmentSizes.get(row.id as string) ??
                  (row.sizeBytes as number | null),
              };
            }
            if (model === "LegacyMigrationMap") {
              try {
                const remapped = remapLegacyMigrationMapIds(
                  {
                    legacyEntityType: row.legacyEntityType as string,
                    legacyEntityId: row.legacyEntityId as string,
                    targetEntityType: row.targetEntityType as string,
                    targetEntityId: row.targetEntityId as string,
                  },
                  idMap,
                  userId,
                );
                payload = { ...payload, ...remapped };
              } catch (error) {
                throw new BackupError(
                  error instanceof Error
                    ? `Restore failed: ${error.message}`
                    : "Restore failed: LegacyMigrationMap ids could not be remapped.",
                );
              }
            }
            // Reminder.targetId is polymorphic: PROCESS_STEP →
            // ApplicationProcessStep, JOB_DUE → Job. A source row that was
            // not in this backup leaves a live reminder pointing at nothing,
            // so the restored row is downgraded to an inert CANCELLED
            // tombstone instead.
            if (model === "Reminder") {
              const mapped = idMap.get(row.targetId as string);
              payload = mapped
                ? { ...payload, targetId: mapped }
                : { ...payload, status: "CANCELLED" };
            }

            await tx[spec.delegate].create({ data: payload });
          }
        }

        await patchDeferredForeignKeys(tx, data, idMap);

        // Join tables last: both endpoints have to exist first.
        for (const link of data._JobToTag) {
          await tx.job.update({
            where: { id: idMap.get(link.jobId)! },
            data: { tags: { connect: { id: idMap.get(link.tagId)! } } },
          });
        }
        for (const link of data._QuestionToTag) {
          await tx.question.update({
            where: { id: idMap.get(link.questionId)! },
            data: { tags: { connect: { id: idMap.get(link.tagId)! } } },
          });
        }
        counts._JobToTag = data._JobToTag.length;
        counts._QuestionToTag = data._QuestionToTag.length;

        // A back-reference from a row the import never inserts.
        const defaultResumeId = data.user.defaultResumeId
          ? (idMap.get(data.user.defaultResumeId) ?? null)
          : null;
        await tx.user.update({ where: { id: userId }, data: { defaultResumeId } });
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (error) {
    await Promise.all(
      writtenPaths.map((p) => fs.unlink(p).catch(() => undefined)),
    );
    if (error instanceof BackupError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
      throw new BackupError("The database is busy. Please try the import again.");
    }
    log.error("[Backup] Import transaction failed");
    throw new BackupError("Import failed and nothing was changed.");
  }

  // Without this every restore-over-existing leaves the previous account's
  // resume files in UPLOADS_DIR forever with no row pointing at them.
  for (const filePath of oldFilePaths) {
    if (writtenPaths.includes(filePath)) continue;
    if (!isResumeFilePath(filePath)) {
      log.warn("[Backup] Skipped removing a file outside the resumes directory", {
        "file.path": filePath,
      });
      continue;
    }
    await fs.unlink(filePath).catch((error) => {
      log.warn("[Backup] Could not remove replaced file", {
        "file.path": filePath,
        error: String(error),
      });
    });
  }

  // Same orphan cleanup for replaced attachment bytes. Paths were resolved
  // through the storage-key gate at capture time, so only keys that already
  // validated under files/career-attachments reach unlink here.
  for (const attachmentPath of oldAttachmentPaths) {
    if (writtenPaths.includes(attachmentPath)) continue;
    await fs.unlink(attachmentPath).catch((error) => {
      log.warn("[Backup] Could not remove replaced attachment", {
        "file.path": attachmentPath,
        error: String(error),
      });
    });
  }

  // Nothing else would: syncSchedulerState runs at boot and in the automation
  // actions, and an import goes through neither. Imported dynamically so
  // node-cron and the whole scraper graph stay out of this module's imports.
  const { syncSchedulerState } = await import("@/lib/scheduler");
  await syncSchedulerState();

  return { counts, filesWritten: writtenPaths.length, snapshotPath };
}
