import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  getResumeEvidenceSaveEligibility,
  validateResumeEvidenceDraft,
  type ResumeEvidenceSaveBlockCode,
} from "@/lib/agent/skills/resumeEvidence";
import { assertResumeV1Writable } from "./capabilities";
import { isValidIsoDate } from "./candidateProfileValidation";
import { CareerRuntimeError } from "./errors";
import {
  APPLICATION_PROFILE_DETAIL_FIELDS,
  resolveApplicationMaterialTitle,
  sanitizeApplicationMaterialDetail,
  type DetailFieldKind,
} from "./careerMaterialInput";
import { CareerMaterialService, detailCreateKey } from "./careerMaterialService";
import type { CareerMaterialType } from "./identities";

// First save capability of the Resume Evidence skill (D4/D5/D7). A validated
// draft becomes ONE plan; the plan is previewed, and on confirm the material
// plus all its evidence are written in a single transaction with
// verificationStatus USER_CONFIRMED. Nothing here is a model tool.

export type ResumeEvidenceSavePlan = {
  operation: "create_new" | "update_existing";
  type: string;
  targetMaterialId: string | null;
  material: {
    title: string;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    notes: string | null;
    detail: Record<string, unknown>;
  } | null;
  /**
   * update_existing only: the draft's confirmed non-null parent/detail values.
   * Unknown (null/empty) values are omitted, never used to clear a field.
   */
  proposed: {
    title: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean | null;
    notes: string | null;
    detail: Record<string, unknown>;
  } | null;
  evidence: { content: string; metricText: string | null }[];
};

export type ResumeEvidenceFieldChange = {
  scope: "parent" | "detail";
  field: string;
  old: string | null;
  new: string;
};

export type ResumeEvidenceSavePreview = {
  digest: string;
  operation: ResumeEvidenceSavePlan["operation"];
  type: string;
  verificationStatus: "USER_CONFIRMED";
  targetMaterialId: string | null;
  material: {
    title: string;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    notes: string | null;
    detail: { key: string; value: string }[];
  } | null;
  /** update_existing: title of the target and each changed field old -> new. */
  targetTitle: string | null;
  changes: ResumeEvidenceFieldChange[];
  evidence: { content: string; metricText: string | null }[];
};

export type ResumeEvidenceSaveErrorCode =
  | ResumeEvidenceSaveBlockCode
  | "invalid_draft"
  | "invalid_detail"
  | "preview_mismatch"
  | "target_not_found"
  | "type_mismatch";

export class ResumeEvidenceSaveError extends Error {
  readonly code: ResumeEvidenceSaveErrorCode;
  /** The draft detail field the user has to fix, for invalid_detail. */
  readonly field?: string;
  constructor(
    code: ResumeEvidenceSaveErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "ResumeEvidenceSaveError";
    this.code = code;
    this.field = field;
  }
}

function optDate(value: string | null): string | null {
  if (value === null) return null;
  if (!isValidIsoDate(value)) {
    throw new ResumeEvidenceSaveError("invalid_draft", "Invalid date in draft.");
  }
  return value;
}

const BOOL_TRUE = new Set(["true", "是", "yes"]);
const BOOL_FALSE = new Set(["false", "否", "no"]);
const STRICT_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Draft detail values are strings. Coerce strictly by the field's kind (float:
 * fully numeric only; boolean: true/false/是/否/yes/no), then run the normal
 * allowlist validator per field so an error can name the field. Empty values
 * mean unknown and are omitted.
 */
export function coerceResumeEvidenceDetail(
  type: string,
  detail: Record<string, string>,
): Record<string, unknown> {
  const allowlist = (
    APPLICATION_PROFILE_DETAIL_FIELDS as Record<
      string,
      Record<string, DetailFieldKind> | undefined
    >
  )[type];
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(detail)) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    const kind = allowlist?.[key];
    let value: unknown = text;
    if (kind === "float") {
      if (!STRICT_NUMBER.test(text)) {
        throw new ResumeEvidenceSaveError(
          "invalid_detail",
          `Invalid detail field "${key}": expected a plain number.`,
          key,
        );
      }
      value = Number(text);
    } else if (kind === "boolean") {
      const lower = text.toLowerCase();
      if (BOOL_TRUE.has(lower)) value = true;
      else if (BOOL_FALSE.has(lower)) value = false;
      else {
        throw new ResumeEvidenceSaveError(
          "invalid_detail",
          `Invalid detail field "${key}": expected yes/no.`,
          key,
        );
      }
    }
    try {
      Object.assign(out, sanitizeApplicationMaterialDetail(type, { [key]: value }));
    } catch (error) {
      if (error instanceof CareerRuntimeError) {
        throw new ResumeEvidenceSaveError(
          "invalid_detail",
          `Invalid detail field "${key}".`,
          key,
        );
      }
      throw error;
    }
  }
  return out;
}

/** Server-side re-validation: never trust the client's draft. */
export function buildResumeEvidenceSavePlan(raw: unknown): ResumeEvidenceSavePlan {
  const parsed = validateResumeEvidenceDraft(raw);
  if (!parsed.ok) {
    throw new ResumeEvidenceSaveError(
      "invalid_draft",
      `Draft failed validation: ${parsed.errors.slice(0, 3).join("; ")}`,
    );
  }
  const draft = parsed.draft;
  const eligibility = getResumeEvidenceSaveEligibility(draft);
  if (!eligibility.ok) {
    throw new ResumeEvidenceSaveError(
      eligibility.code,
      `Draft cannot be saved: ${eligibility.code}`,
    );
  }
  const mm = draft.materialMapping;
  const evidence = mm.evidenceToAdd.map((e) => ({
    content: e.content.trim(),
    metricText: e.metricText?.trim() ? e.metricText.trim() : null,
  }));
  if (eligibility.operation === "update_existing") {
    const detail = coerceResumeEvidenceDetail(eligibility.type, mm.detail);
    return {
      operation: "update_existing",
      type: eligibility.type,
      targetMaterialId: mm.careerMaterialItemId,
      material: null,
      proposed: {
        title: mm.parent.title?.trim() ? mm.parent.title.trim() : null,
        startDate: optDate(mm.parent.startDate),
        endDate: optDate(mm.parent.endDate),
        isCurrent: mm.parent.isCurrent,
        notes: mm.parent.notes?.trim() ? mm.parent.notes.trim() : null,
        detail,
      },
      evidence,
    };
  }
  const detail = coerceResumeEvidenceDetail(eligibility.type, mm.detail);
  let title: string;
  try {
    title = resolveApplicationMaterialTitle(
      eligibility.type,
      mm.parent.title,
      detail,
    );
  } catch (error) {
    if (error instanceof CareerRuntimeError) {
      throw new ResumeEvidenceSaveError("invalid_detail", error.message);
    }
    throw error;
  }
  const notes = mm.parent.notes?.trim() ? mm.parent.notes.trim() : null;
  return {
    operation: "create_new",
    type: eligibility.type,
    targetMaterialId: null,
    proposed: null,
    material: {
      title,
      startDate: optDate(mm.parent.startDate),
      endDate: optDate(mm.parent.endDate),
      isCurrent: mm.parent.isCurrent ?? false,
      notes,
      detail,
    },
    evidence,
  };
}

export function digestResumeEvidenceSavePlan(
  plan: ResumeEvidenceSavePlan,
  changes: ResumeEvidenceFieldChange[] = [],
) {
  return createHash("sha256")
    .update(JSON.stringify({ plan, changes }))
    .digest("hex");
}

type Db = PrismaClient | Prisma.TransactionClient;

type UpdatePatch = {
  title?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  isCurrent?: boolean;
  notes?: string | null;
  detail?: Record<string, unknown>;
};

type Resolved = {
  changes: ResumeEvidenceFieldChange[];
  patch: UpdatePatch;
  targetTitle: string | null;
  item: { id: string; evidence: { id: string; content: string; sortOrder: number }[] } | null;
};

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return show(a) === show(b);
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return (a ?? null) === (b ?? null);
}

/**
 * Loads the update target (ownership + type check) and works out which parent
 * and detail fields actually change. Only non-null confirmed draft values count
 * and nothing is ever cleared (contract §5).
 */
async function resolveTarget(
  db: Db,
  userId: string,
  plan: ResumeEvidenceSavePlan,
): Promise<Resolved> {
  if (plan.operation !== "update_existing" || !plan.proposed) {
    return { changes: [], patch: {}, targetTitle: null, item: null };
  }
  const item = await db.careerMaterialItem.findFirst({
    where: { id: plan.targetMaterialId ?? "", userId, archivedAt: null },
    include: {
      evidence: {
        where: { archivedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      [detailCreateKey(plan.type as CareerMaterialType) as string]: true,
    } as Prisma.CareerMaterialItemInclude,
  });
  if (!item) {
    throw new ResumeEvidenceSaveError("target_not_found", "Career material not found.");
  }
  if (item.type !== plan.type) {
    throw new ResumeEvidenceSaveError(
      "type_mismatch",
      "Material type differs from the draft.",
    );
  }
  const row = item as unknown as {
    id: string;
    title: string;
    startDate: Date | null;
    endDate: Date | null;
    isCurrent: boolean;
    notes: string | null;
    evidence: { id: string; content: string; sortOrder: number }[];
  } & Record<string, unknown>;
  const existingDetail = (row[detailCreateKey(plan.type as CareerMaterialType) as string] ??
    {}) as Record<string, unknown>;
  const p = plan.proposed;
  const changes: ResumeEvidenceFieldChange[] = [];
  const patch: UpdatePatch = {};

  if (plan.type !== "LANGUAGE" && p.title && !sameValue(p.title, row.title)) {
    patch.title = p.title;
    changes.push({ scope: "parent", field: "title", old: row.title, new: p.title });
  }
  if (p.startDate && !sameValue(p.startDate, row.startDate)) {
    patch.startDate = new Date(p.startDate);
    changes.push({ scope: "parent", field: "startDate", old: show(row.startDate), new: p.startDate });
  }
  if (p.endDate && !sameValue(p.endDate, row.endDate)) {
    patch.endDate = new Date(p.endDate);
    changes.push({ scope: "parent", field: "endDate", old: show(row.endDate), new: p.endDate });
  }
  if (p.isCurrent !== null && p.isCurrent !== row.isCurrent) {
    patch.isCurrent = p.isCurrent;
    changes.push({ scope: "parent", field: "isCurrent", old: String(row.isCurrent), new: String(p.isCurrent) });
  }
  if (p.notes && !sameValue(p.notes, row.notes)) {
    patch.notes = p.notes;
    changes.push({ scope: "parent", field: "notes", old: row.notes, new: p.notes });
  }
  const detailPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p.detail)) {
    if (!sameValue(value, existingDetail[key])) {
      detailPatch[key] = value;
      changes.push({
        scope: "detail",
        field: key,
        old: show(existingDetail[key]),
        new: show(value) ?? "",
      });
    }
  }
  if (Object.keys(detailPatch).length > 0) {
    patch.detail = detailPatch;
    if (plan.type === "LANGUAGE") {
      // Language records title themselves from the detail (as the profile page does).
      const merged = { ...existingDetail, ...detailPatch };
      const title = resolveApplicationMaterialTitle("LANGUAGE", row.title, merged);
      if (!sameValue(title, row.title)) {
        patch.title = title;
        changes.push({ scope: "parent", field: "title", old: row.title, new: title });
      }
    }
  }
  return { changes, patch, targetTitle: row.title, item: row };
}

/** Read-only preview: what exactly would be created or updated. */
export async function previewResumeEvidenceSavePlan(
  db: PrismaClient,
  userId: string,
  plan: ResumeEvidenceSavePlan,
): Promise<ResumeEvidenceSavePreview> {
  const resolved = await resolveTarget(db, userId, plan);
  return {
    digest: digestResumeEvidenceSavePlan(plan, resolved.changes),
    operation: plan.operation,
    type: plan.type,
    verificationStatus: "USER_CONFIRMED",
    targetMaterialId: plan.targetMaterialId,
    material: plan.material
      ? {
          ...plan.material,
          detail: Object.entries(plan.material.detail).map(([key, value]) => ({
            key,
            value: show(value) ?? "",
          })),
        }
      : null,
    targetTitle: resolved.targetTitle,
    changes: resolved.changes,
    evidence: plan.evidence,
  };
}

export type ResumeEvidenceSaveResult = {
  materialId: string;
  evidenceIds: string[];
  /** True when an identical earlier save was found and nothing was written. */
  alreadySaved: boolean;
};

const inFlight = new Map<string, Promise<ResumeEvidenceSaveResult>>();

async function run(
  db: PrismaClient,
  userId: string,
  plan: ResumeEvidenceSavePlan,
  expectedDigest: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<ResumeEvidenceSaveResult> {
  await assertResumeV1Writable(db, env);
  return db.$transaction(async (tx) => {
    const contents = plan.evidence.map((e) => e.content);
    const containsAll = (existing: { content: string }[]) =>
      contents.every((c) => existing.some((e) => e.content === c));
    const activeEvidence = {
      where: { archivedAt: null },
      orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    };
    const already = (item: {
      id: string;
      evidence: { id: string; content: string }[];
    }): ResumeEvidenceSaveResult => ({
      materialId: item.id,
      evidenceIds: item.evidence
        .filter((e) => contents.includes(e.content))
        .map((e) => e.id),
      alreadySaved: true,
    });
    const checkDigest = (changes: ResumeEvidenceFieldChange[]) => {
      if (
        expectedDigest !== undefined &&
        digestResumeEvidenceSavePlan(plan, changes) !== expectedDigest
      ) {
        throw new ResumeEvidenceSaveError(
          "preview_mismatch",
          "The draft or the saved material changed after the preview. Preview it again.",
        );
      }
    };

    let materialId: string;
    let sortBase = 0;
    if (plan.operation === "update_existing") {
      const resolved = await resolveTarget(tx, userId, plan);
      const item = resolved.item!;
      // Nothing left to change and the evidence is already there: a repeat.
      if (resolved.changes.length === 0 && containsAll(item.evidence)) {
        return already(item);
      }
      checkDigest(resolved.changes);
      materialId = item.id;
      sortBase = item.evidence.reduce(
        (m, e) => Math.max(m, e.sortOrder + 1),
        0,
      );
      if (resolved.changes.length > 0) {
        await new CareerMaterialService(db, userId).updateWithin(tx, {
          id: item.id,
          ...resolved.patch,
        });
        await tx.careerMaterialItem.update({
          where: { id: item.id },
          data: { verificationStatus: "USER_CONFIRMED" },
        });
      }
    } else {
      checkDigest([]);
      const material = plan.material!;
      const candidates = await tx.careerMaterialItem.findMany({
        where: {
          userId,
          type: plan.type,
          title: material.title,
          archivedAt: null,
          origin: "USER",
          verificationStatus: "USER_CONFIRMED",
        },
        include: { evidence: activeEvidence },
      });
      const same = candidates.find((c) => containsAll(c.evidence));
      if (same) return already(same);
      const type = plan.type as CareerMaterialType;
      const created = await tx.careerMaterialItem.create({
        data: {
          user: { connect: { id: userId } },
          type,
          title: material.title,
          startDate: material.startDate ? new Date(material.startDate) : null,
          endDate: material.endDate ? new Date(material.endDate) : null,
          isCurrent: material.isCurrent,
          notes: material.notes,
          origin: "USER",
          verificationStatus: "USER_CONFIRMED",
          [detailCreateKey(type)]: { create: material.detail },
        } as Prisma.CareerMaterialItemCreateInput,
      });
      materialId = created.id;
    }

    const evidenceIds: string[] = [];
    for (const [i, e] of plan.evidence.entries()) {
      const row = await tx.careerEvidence.create({
        data: {
          materialItemId: materialId,
          kind: "FACT",
          content: e.content,
          metricText: e.metricText,
          sortOrder: sortBase + i,
          origin: "USER",
          verificationStatus: "USER_CONFIRMED",
        },
      });
      evidenceIds.push(row.id);
    }
    return { materialId, evidenceIds, alreadySaved: false };
  });
}

/**
 * Writes the plan in one transaction (all or nothing): for update_existing the
 * changed parent/detail fields and the appended evidence commit together.
 * Concurrent identical submits share one in-flight write; a repeat after
 * completion is detected from stored rows and reports `alreadySaved`.
 * `expectedDigest` is the preview digest the user confirmed.
 */
export function saveResumeEvidencePlan(
  db: PrismaClient,
  userId: string,
  plan: ResumeEvidenceSavePlan,
  options: { expectedDigest?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResumeEvidenceSaveResult> {
  const key = `${userId}:${digestResumeEvidenceSavePlan(plan)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = run(db, userId, plan, options.expectedDigest, options.env).finally(
    () => inFlight.delete(key),
  );
  inFlight.set(key, p);
  return p;
}
