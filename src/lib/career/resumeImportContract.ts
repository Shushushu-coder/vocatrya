import { z } from "zod";

const text = z.string().min(1).max(50000);
const optionalText = z.string().max(500).nullable();
export const importProfileFields = ["fullName", "headline", "email", "phone", "address", "linksData"] as const;
export const ImportProfileSchema = z.object({
  fullName: optionalText, headline: optionalText, email: optionalText,
  phone: optionalText, address: optionalText, linksData: optionalText,
}).strict();
export const ImportFieldsSchema = z.object({
  organization: optionalText, role: optionalText, institution: optionalText,
  degree: optionalText, fieldOfStudy: optionalText, location: optionalText,
  startDate: optionalText, endDate: optionalText, url: optionalText,
  venue: optionalText, authors: optionalText, issuer: optionalText,
  skillName: optionalText, proficiency: optionalText,
}).strict();
export const ImportItemSchema = z.object({
  type: z.enum(["EDUCATION", "INTERNSHIP", "EMPLOYMENT", "PROJECT", "RESEARCH", "PUBLICATION", "AWARD", "SKILL", "CUSTOM"]),
  title: z.string().min(1).max(500), sourceText: text,
  structuredFields: ImportFieldsSchema,
  evidenceCandidates: z.array(z.object({
    content: text,
    kind: z.enum(["RESPONSIBILITY", "ACTION", "ACHIEVEMENT", "METRIC", "SKILL_USAGE", "OUTPUT", "OTHER"]),
    expressionIndex: z.number().int().min(0),
  }).strict()).max(100),
  expressions: z.array(text).min(1).max(100),
  uncertainty: z.string().max(500).nullable(),
}).strict();
export const ParsedResumeImportSchema = z.object({
  profile: ImportProfileSchema,
  profileSourceText: text.nullable(),
  sections: z.array(z.object({
    title: z.string().min(1).max(500), items: z.array(ImportItemSchema).min(1).max(100),
  }).strict()).min(1).max(30),
}).strict();
export type ParsedResumeImport = z.infer<typeof ParsedResumeImportSchema>;
export type ResumeImportItem = z.infer<typeof ImportItemSchema>;

/** Reject invented/reworded facts rather than trusting a parser's confidence. */
export function validateResumeImport(value: unknown, rawText: string): ParsedResumeImport {
  const parsed = ParsedResumeImportSchema.parse(value);
  const requireSource = (source: string, fragment: string | null) => {
    if (fragment !== null && !source.includes(fragment)) throw new Error("IMPORT_SOURCE_MISMATCH");
  };
  for (const field of importProfileFields) requireSource(rawText, parsed.profile[field]);
  requireSource(rawText, parsed.profileSourceText);
  let sectionPosition = -1;
  for (const section of parsed.sections) {
    requireSource(rawText, section.title);
    const position = rawText.indexOf(section.title, sectionPosition + 1);
    if (position < 0) throw new Error("IMPORT_SOURCE_ORDER");
    sectionPosition = position;
    let itemPosition = position;
    for (const item of section.items) {
      requireSource(rawText, item.sourceText);
      const itemStart = rawText.indexOf(item.sourceText, itemPosition);
      if (itemStart < 0) throw new Error("IMPORT_SOURCE_ORDER");
      itemPosition = itemStart + item.sourceText.length;
      requireSource(item.sourceText, item.title);
      for (const field of Object.values(item.structuredFields)) requireSource(item.sourceText, field);
      let expressionPosition = 0;
      for (const expression of item.expressions) {
        const start = item.sourceText.indexOf(expression, expressionPosition);
        if (start < 0) throw new Error("IMPORT_SOURCE_MISMATCH");
        expressionPosition = start + expression.length;
      }
      if (item.expressions.join("").replace(/\s/g, "") !== item.sourceText.replace(/\s/g, "")) {
        throw new Error("IMPORT_EXPRESSION_INCOMPLETE");
      }
      for (const evidence of item.evidenceCandidates) {
        const expression = item.expressions[evidence.expressionIndex];
        if (!expression) throw new Error("IMPORT_EVIDENCE_INDEX");
        requireSource(expression, evidence.content);
      }
    }
  }
  const reconstructed = (parsed.profileSourceText ?? "") + parsed.sections.map((section) =>
    section.title + section.items.map((item) => item.sourceText).join("")).join("");
  if (reconstructed.replace(/\s/g, "") !== rawText.replace(/\s/g, "")) {
    throw new Error("IMPORT_SOURCE_INCOMPLETE");
  }
  return parsed;
}

export function safeImportName(filename: string): string {
  return filename.split(/[\\/]/).pop()?.replace(/\.(pdf|docx)$/i, "")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim().slice(0, 120) || "Imported Resume";
}

/** Only full calendar dates can occupy DateTime without inventing precision. */
export function importDate(source: string | null): Date | null {
  if (!source || !/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(source)) return null;
  const normalized = source.replace(/[/.]/g, "-");
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? null : date;
}
