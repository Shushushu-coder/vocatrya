/**
 * Sections Vocatrya can actually source for an auto-apply export. This is
 * the user-facing selection whitelist — the export never offers sections
 * that have no non-sensitive source (family, declarations, performance,
 * training, patent, self).
 */
export const AUTO_APPLY_EXPORTABLE_SECTIONS = [
  "basic",
  "intention",
  "education",
  "internship",
  "work",
  "project",
  "student",
  "awards",
  "language",
  "computer",
  "certificates",
  "papers",
  "other",
] as const;

export type AutoApplySectionKey =
  (typeof AUTO_APPLY_EXPORTABLE_SECTIONS)[number];

const EXPORTABLE_SET = new Set<string>(AUTO_APPLY_EXPORTABLE_SECTIONS);

export function isExportableSectionKey(
  key: string,
): key is AutoApplySectionKey {
  return EXPORTABLE_SET.has(key);
}

/**
 * Parse a `sections` query value ("basic,education,internship"). An absent
 * or blank value selects every exportable section; unknown keys are
 * collected into `ignored` and never silently exported.
 */
export function parseSectionSelection(raw: string | null | undefined): {
  sections: AutoApplySectionKey[];
  ignored: string[];
} {
  if (raw == null || raw.trim() === "") {
    return { sections: [...AUTO_APPLY_EXPORTABLE_SECTIONS], ignored: [] };
  }
  const seen = new Set<AutoApplySectionKey>();
  const ignored: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key) continue;
    if (isExportableSectionKey(key)) {
      seen.add(key);
    } else {
      ignored.push(key);
    }
  }
  return {
    sections: AUTO_APPLY_EXPORTABLE_SECTIONS.filter((key) => seen.has(key)),
    ignored,
  };
}
