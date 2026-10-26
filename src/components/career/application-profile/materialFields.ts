/**
 * CP-EDIT: editable detail-field map for material record autosave.
 *
 * Mirrors the server allowlist (APPLICATION_PROFILE_DETAIL_FIELDS in
 * careerMaterialInput.ts): the section renders exactly these fields per
 * record type, and every committed draft is sent inside a single-key
 * `detail` patch so a save can never clear sibling detail columns.
 *
 * Pure module: no React, safe to import anywhere.
 */

export type MaterialDetailFieldKind = "text" | "float" | "date";

export type MaterialDetailFieldDef = {
  /** Prisma detail column; also the key sent inside `detail` patches. */
  key: string;
  /** i18n key inside the applicationProfile namespace. */
  labelKey: string;
  kind: MaterialDetailFieldKind;
};

export const MATERIAL_DETAIL_FIELDS = {
  EDUCATION: [
    { key: "institution", labelKey: "materialInstitution", kind: "text" },
    { key: "degree", labelKey: "materialDegree", kind: "text" },
    { key: "fieldOfStudy", labelKey: "materialFieldOfStudy", kind: "text" },
    { key: "locationText", labelKey: "materialLocation", kind: "text" },
    { key: "gpaValue", labelKey: "materialGpa", kind: "float" },
    { key: "gpaScale", labelKey: "materialGpaScale", kind: "float" },
    { key: "rankText", labelKey: "materialRank", kind: "text" },
  ],
  INTERNSHIP: [
    { key: "organizationName", labelKey: "materialOrganization", kind: "text" },
    { key: "roleTitle", labelKey: "materialRole", kind: "text" },
    { key: "locationText", labelKey: "materialLocation", kind: "text" },
  ],
  PROJECT: [
    { key: "organizationName", labelKey: "materialOrganization", kind: "text" },
    { key: "roleTitle", labelKey: "materialRole", kind: "text" },
    { key: "projectUrl", labelKey: "materialProjectUrl", kind: "text" },
  ],
  RESEARCH: [
    { key: "institution", labelKey: "materialInstitution", kind: "text" },
    { key: "roleTitle", labelKey: "materialRole", kind: "text" },
    { key: "field", labelKey: "materialResearchField", kind: "text" },
  ],
  PUBLICATION: [
    { key: "venue", labelKey: "materialVenue", kind: "text" },
    { key: "authors", labelKey: "materialAuthors", kind: "text" },
    { key: "url", labelKey: "materialUrl", kind: "text" },
    { key: "publishedAt", labelKey: "materialPublishedAt", kind: "date" },
  ],
  COMPETITION: [
    { key: "organizer", labelKey: "materialOrganizer", kind: "text" },
    { key: "awardLevel", labelKey: "materialAwardLevel", kind: "text" },
    { key: "result", labelKey: "materialResult", kind: "text" },
  ],
  CAMPUS_ACTIVITY: [
    { key: "organizationName", labelKey: "materialOrganization", kind: "text" },
    { key: "roleTitle", labelKey: "materialRole", kind: "text" },
  ],
  AWARD: [
    { key: "issuer", labelKey: "materialIssuer", kind: "text" },
    { key: "awardedAt", labelKey: "materialAwardedAt", kind: "date" },
  ],
  SKILL: [
    { key: "skillName", labelKey: "materialSkillName", kind: "text" },
    { key: "proficiency", labelKey: "materialProficiency", kind: "text" },
  ],
  CERTIFICATION: [
    { key: "organization", labelKey: "materialCertOrg", kind: "text" },
    { key: "credentialUrl", labelKey: "materialCredentialUrl", kind: "text" },
    { key: "issueDate", labelKey: "materialIssueDate", kind: "date" },
    { key: "expirationDate", labelKey: "materialExpirationDate", kind: "date" },
  ],
} as const satisfies Record<string, readonly MaterialDetailFieldDef[]>;

export type EditableMaterialType = keyof typeof MATERIAL_DETAIL_FIELDS;

const DETAIL_RELATION: Record<EditableMaterialType, string> = {
  EDUCATION: "educationDetail",
  INTERNSHIP: "internshipDetail",
  PROJECT: "projectDetail",
  RESEARCH: "researchDetail",
  PUBLICATION: "publicationDetail",
  COMPETITION: "competitionDetail",
  CAMPUS_ACTIVITY: "campusActivityDetail",
  AWARD: "awardDetail",
  SKILL: "skillDetail",
  CERTIFICATION: "certificationDetail",
};

/**
 * A record is directly editable only when its type is covered by the server
 * detail allowlist. EMPLOYMENT, CUSTOM and unknown legacy types stay
 * read-only, matching the action's contract.
 */
export function isEditableMaterialType(
  type: string,
): type is EditableMaterialType {
  return type in MATERIAL_DETAIL_FIELDS;
}

export function toDateInput(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Stored detail column → editor draft string ("" when empty). */
export function detailFieldDraft(
  item: { type: string },
  def: MaterialDetailFieldDef,
): string {
  const relation = DETAIL_RELATION[item.type as EditableMaterialType];
  if (!relation) return "";
  const detail = (item as unknown as Record<string, unknown>)[relation] as
    | Record<string, unknown>
    | null
    | undefined;
  const value = detail?.[def.key];
  if (value === null || value === undefined) return "";
  if (def.kind === "date") return toDateInput(value);
  if (def.kind === "float")
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
  return typeof value === "string" ? value.trim() : String(value);
}

/**
 * Editor draft → wire value placed inside the single-key `detail` patch.
 * Empty drafts persist null (explicit clear); floats that do not parse are
 * sent through so the server reject surfaces as a retriable save failure.
 */
export function detailFieldWire(
  def: MaterialDetailFieldDef,
  draft: string,
): string | number | null {
  const trimmed = draft.trim();
  if (def.kind === "float") return trimmed === "" ? null : Number(trimmed);
  return trimmed === "" ? null : trimmed;
}
