import type { ParsedResumeImport } from "./resumeImportContract";

// Item-level import exclusions (RESUME-BUILDER contract §5 I5/I6).
// A previewRef addresses one parsed item by its position inside the SIGNED
// parse result — the approval token freezes `parsed`, so indices are stable
// between preview and confirm. Pure module: safe for client and server.
export const IMPORT_ITEM_REF_PATTERN = /^s(?:0|[1-9]\d*)\.it(?:0|[1-9]\d*)$/;

export function importItemRef(sectionIndex: number, itemIndex: number): string {
  return `s${sectionIndex}.it${itemIndex}`;
}

/** Inverse of importItemRef — null when the ref is malformed. */
export function parseImportItemRef(ref: string): [number, number] | null {
  if (!IMPORT_ITEM_REF_PATTERN.test(ref)) return null;
  const [sectionIndex, itemIndex] = ref.slice(1).split(".it").map(Number);
  return [sectionIndex, itemIndex];
}

/** Every excludable item ref, in signed-parse order. */
export function importPreviewRefs(parsed: ParsedResumeImport): string[] {
  return parsed.sections.flatMap((section, sectionIndex) =>
    section.items.map((_, itemIndex) => importItemRef(sectionIndex, itemIndex)));
}

/** Raw confirm-payload fields — normalized and bounds-checked before use. */
export type ImportSelectionPayload = {
  excludedItemRefs?: unknown;
  excludeProfileImport?: unknown;
};

export type ResolvedImportSelection = {
  /** Sorted, deduplicated, validated refs — canonical signature input. */
  refs: string[];
  excluded: ReadonlySet<string>;
  excludeProfileImport: boolean;
};

function invalid(): never {
  throw new Error("IMPORT_EXCLUSION_INVALID");
}

/**
 * Normalize the confirm selection against the signed parse. Any malformed,
 * out-of-bounds or mistyped entry rejects the whole request — exclusions
 * never reach persistence on doubt.
 */
export function resolveImportSelection(
  parsed: ParsedResumeImport,
  payload: ImportSelectionPayload | undefined | null,
): ResolvedImportSelection {
  if (payload === undefined || payload === null) {
    return { refs: [], excluded: new Set(), excludeProfileImport: false };
  }
  if (typeof payload !== "object" || Array.isArray(payload)) invalid();
  const { excludedItemRefs, excludeProfileImport } = payload;
  if (excludeProfileImport !== undefined && typeof excludeProfileImport !== "boolean") invalid();
  if (excludedItemRefs !== undefined && !Array.isArray(excludedItemRefs)) invalid();
  const excluded = new Set<string>();
  for (const ref of excludedItemRefs ?? []) {
    if (typeof ref !== "string") invalid();
    const position = parseImportItemRef(ref);
    if (!position || !parsed.sections[position[0]]?.items[position[1]]) invalid();
    excluded.add(ref);
  }
  const total = parsed.sections.reduce((sum, section) => sum + section.items.length, 0);
  // Excluding everything equals cancel — the explicit cancel path already exists.
  if (total - excluded.size <= 0) throw new Error("IMPORT_EXCLUSION_EMPTY");
  return { refs: [...excluded].sort(), excluded, excludeProfileImport: excludeProfileImport === true };
}

/** Default (keep-everything) selection — the only replay allowed on pre-feature imports. */
export function isDefaultImportSelection(selection: ResolvedImportSelection): boolean {
  return selection.refs.length === 0 && !selection.excludeProfileImport;
}

/** Canonical JSON — the exact bytes hashed into confirmedSelectionSha. */
export function canonicalImportSelection(selection: ResolvedImportSelection): string {
  return JSON.stringify({
    excludedItemRefs: selection.refs,
    excludeProfileImport: selection.excludeProfileImport,
  });
}

/**
 * Persistence subset: excluded items and now-empty sections drop out, kept
 * content stays byte-identical to the signed parse. The profile object is
 * untouched — profile exclusion is a separate write flag, not a data rewrite.
 */
export function selectImportSubset(
  parsed: ParsedResumeImport,
  selection: ResolvedImportSelection,
): ParsedResumeImport {
  return {
    ...parsed,
    sections: parsed.sections
      .map((section, sectionIndex) => ({
        ...section,
        items: section.items.filter((_, itemIndex) => !selection.excluded.has(importItemRef(sectionIndex, itemIndex))),
      }))
      .filter((section) => section.items.length > 0),
  };
}
