import { CareerRuntimeError } from "./errors";
import { CAREER_MATERIAL_TYPE } from "./identities";
import { isValidIsoDate } from "./candidateProfileService";
import { normalizeOptionalText } from "./opportunityService";

type DetailFieldKind = "string" | "float" | "datetime";

const INVALID_DETAIL_MESSAGE = "Invalid material detail field.";

/**
 * Keys that must never be accepted from Application Profile writes,
 * even if a detail model happens to have them.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "id",
  "materialItemId",
  "userId",
  "createdAt",
  "updatedAt",
  "structuredData",
  "companyId",
  "company",
  "materialItem",
]);

/**
 * Application Profile V1 allowlist, keyed by CareerMaterial type.
 * Field names match the current Prisma detail models. EMPLOYMENT and CUSTOM
 * are intentionally omitted: this action surface does not edit them.
 */
const APPLICATION_PROFILE_DETAIL_FIELDS = {
  EDUCATION: {
    institution: "string",
    degree: "string",
    fieldOfStudy: "string",
    locationText: "string",
    gpaValue: "float",
    gpaScale: "float",
    rankText: "string",
  },
  INTERNSHIP: {
    organizationName: "string",
    roleTitle: "string",
    locationText: "string",
  },
  PROJECT: {
    roleTitle: "string",
    projectUrl: "string",
    organizationName: "string",
  },
  RESEARCH: {
    institution: "string",
    roleTitle: "string",
    field: "string",
  },
  PUBLICATION: {
    venue: "string",
    authors: "string",
    url: "string",
    publishedAt: "datetime",
  },
  COMPETITION: {
    organizer: "string",
    awardLevel: "string",
    result: "string",
  },
  CAMPUS_ACTIVITY: {
    organizationName: "string",
    roleTitle: "string",
  },
  AWARD: {
    issuer: "string",
    awardedAt: "datetime",
  },
  SKILL: {
    skillName: "string",
    proficiency: "string",
  },
  CERTIFICATION: {
    organization: "string",
    credentialUrl: "string",
    issueDate: "datetime",
    expirationDate: "datetime",
  },
} as const satisfies Record<string, Record<string, DetailFieldKind>>;

export type ApplicationProfileMaterialType =
  keyof typeof APPLICATION_PROFILE_DETAIL_FIELDS;

function invalidDetail(): never {
  throw new CareerRuntimeError("INVALID_MATERIAL_DETAIL", INVALID_DETAIL_MESSAGE);
}

export function assertApplicationProfileMaterialType(
  type: string,
): ApplicationProfileMaterialType {
  if (type === CAREER_MATERIAL_TYPE.CUSTOM) {
    throw new CareerRuntimeError(
      "INVALID_MATERIAL_TYPE",
      "CUSTOM editing not supported in Application Profile V1",
    );
  }
  if (type === CAREER_MATERIAL_TYPE.EMPLOYMENT) {
    throw new CareerRuntimeError(
      "INVALID_MATERIAL_TYPE",
      "EMPLOYMENT editing is not supported in Application Profile V1",
    );
  }
  if (!(type in APPLICATION_PROFILE_DETAIL_FIELDS)) {
    throw new CareerRuntimeError(
      "INVALID_MATERIAL_TYPE",
      `Unsupported career material type: ${type}`,
    );
  }
  return type as ApplicationProfileMaterialType;
}

export function assertApplicationMaterialCreateTitle(title: string): string {
  if (typeof title !== "string") {
    throw new CareerRuntimeError("INVALID_MATERIAL_TITLE", "Title is required.");
  }
  const trimmed = title.trim();
  if (!trimmed) {
    throw new CareerRuntimeError("INVALID_MATERIAL_TITLE", "Title is required.");
  }
  return trimmed;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") invalidDetail();
  return normalizeOptionalText(value);
}

function optionalFloat(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalidDetail();
  return value;
}

function optionalDateTime(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalidDetail();
    return value;
  }
  if (typeof value !== "string" || !isValidIsoDate(value)) invalidDetail();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function coerceField(kind: DetailFieldKind, value: unknown): unknown {
  switch (kind) {
    case "string":
      return optionalString(value);
    case "float":
      return optionalFloat(value);
    case "datetime":
      return optionalDateTime(value);
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

/**
 * Validate + construct a sanitized detail object for Application Profile
 * writes. Unknown / forbidden keys are rejected (never silently stripped).
 */
export function sanitizeApplicationMaterialDetail(
  type: string,
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const materialType = assertApplicationProfileMaterialType(type);
  if (detail === undefined) return {};
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    invalidDetail();
  }

  const allowlist = APPLICATION_PROFILE_DETAIL_FIELDS[materialType];
  const sanitized: Record<string, unknown> = {};

  for (const key of Object.keys(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key) || !(key in allowlist)) {
      invalidDetail();
    }
    const coerced = coerceField(
      allowlist[key as keyof typeof allowlist] as DetailFieldKind,
      detail[key],
    );
    if (coerced !== undefined) sanitized[key] = coerced;
  }

  return sanitized;
}


