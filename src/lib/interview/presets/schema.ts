/**
 * Frozen preset schema (DIRECT_TRANSPLANT + IMPORT_REWRITE).
 * Source: InterviewDx vocatrya-port src/presets/schema.ts
 */
import { z } from "zod";
import { QUESTION_SOURCE_KINDS } from "../persistence/interviewEnums";
import { sha256Canonical } from "../persistence/hash";
import { DomainError, ErrorCodes } from "../persistence/interviewErrors";

export const presetItemSchema = z.object({
  itemKey: z.string().min(1),
  promptText: z.string().min(1),
  referenceAnswer: z.string().optional(),
  category: z.string().optional(),
  locale: z.string().default("zh"),
  sourceKind: z.enum(QUESTION_SOURCE_KINDS).default("QUESTION_BANK"),
  sourceProvenance: z.object({
    origin: z.string(),
    configId: z.string().optional(),
    interviewQuestionId: z.string().optional(),
    commercialQuestionId: z.string().optional(),
    unresolvedBankAttribution: z.boolean().default(false),
  }),
});

export const presetManifestSchema = z.object({
  bankKey: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  locale: z.string().default("zh"),
  kind: z.enum(["SAMPLE_FIXTURE", "CANONICAL_EXPORT"]).default("SAMPLE_FIXTURE"),
  items: z.array(presetItemSchema).min(1),
});

export type PresetManifest = z.infer<typeof presetManifestSchema>;

export function validatePreset(input: unknown): PresetManifest {
  const parsed = presetManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError(ErrorCodes.PRESET_INVALID, parsed.error.message);
  }
  const keys = parsed.data.items.map((item) => item.itemKey);
  const dup = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (dup.length > 0) {
    throw new DomainError(ErrorCodes.PRESET_DUPLICATE, `duplicate preset itemKey: ${dup.join(",")}`);
  }
  const texts = parsed.data.items.map((item) => item.promptText.trim());
  const dupText = texts.filter((text, index) => texts.indexOf(text) !== index);
  if (dupText.length > 0) {
    throw new DomainError(ErrorCodes.PRESET_DUPLICATE, "duplicate preset promptText");
  }
  return parsed.data;
}

export function presetContentHash(manifest: PresetManifest): string {
  return sha256Canonical({
    bankKey: manifest.bankKey,
    version: manifest.version,
    items: manifest.items.map((item) => ({
      itemKey: item.itemKey,
      promptText: item.promptText,
      category: item.category ?? null,
    })),
  });
}
