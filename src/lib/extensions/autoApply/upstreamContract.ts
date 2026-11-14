/**
 * Pinned upstream contract for the OpenJobAutofill companion extension.
 *
 * The constants below were verified against upstream commit
 * 005eda98841b3671ead615ebfde5922f0dfd7c36 (vendored under
 * extensions/auto-apply/, MIT license). Keep them in sync when the vendored
 * copy is updated to a different upstream commit.
 */

import vendoredManifest from "../../../../extensions/auto-apply/manifest.json";

export const UPSTREAM_REPO_URL =
  "https://github.com/Br1an67/OpenJobAutofill";
export const UPSTREAM_COMMIT =
  "005eda98841b3671ead615ebfde5922f0dfd7c36";
export const UPSTREAM_EXTENSION_VERSION = "1.0.2";
export const UPSTREAM_VENDORED_PATH = "extensions/auto-apply";
// The vendored copy's own manifest version — upstream baseline plus
// Vocatrya's connection-layer increments. Read straight from the vendored
// manifest so it can never drift from the file users actually load.
export const VENDORED_EXTENSION_VERSION: string = vendoredManifest.version;

/** Backup envelope accepted by upstream `parseImportedProfileBackup`. */
export const PROFILE_BACKUP_FORMAT = "OpenJobAutofillProfileBackup";
export const PROFILE_BACKUP_VERSION = 1;
/** `profileV2.schemaVersion` expected by upstream normalizeProfileV2. */
export const PROFILE_SCHEMA_VERSION = 2;

export type UpstreamSectionKind = "simple" | "repeat";

export interface UpstreamSectionMeta {
  key: string;
  title: string;
  kind: UpstreamSectionKind;
  itemLabel?: string;
}

/**
 * All section keys in upstream STRUCTURED_RESUME_SECTIONS. Sections outside
 * AUTO_APPLY_EXPORTABLE_SECTIONS are still written as empty sections so the
 * plugin editor shows its full structure (upstream does the same for empty
 * sections).
 */
export const UPSTREAM_SECTIONS: readonly UpstreamSectionMeta[] = [
  { key: "basic", title: "基本信息", kind: "simple" },
  { key: "intention", title: "求职意向", kind: "repeat", itemLabel: "求职意向" },
  { key: "education", title: "教育经历", kind: "repeat", itemLabel: "教育经历" },
  { key: "internship", title: "实习经历", kind: "repeat", itemLabel: "实习经历" },
  { key: "work", title: "工作经历", kind: "repeat", itemLabel: "工作经历" },
  { key: "performance", title: "绩效考核", kind: "repeat", itemLabel: "绩效考核" },
  { key: "project", title: "项目经历/实践活动", kind: "repeat", itemLabel: "项目经历" },
  { key: "student", title: "干部任职经历（在校职务）", kind: "repeat", itemLabel: "干部任职经历" },
  { key: "awards", title: "奖惩情况", kind: "repeat", itemLabel: "奖惩" },
  { key: "language", title: "外语能力", kind: "repeat", itemLabel: "外语能力" },
  { key: "computer", title: "计算机技能（IT技能）", kind: "repeat", itemLabel: "计算机技能" },
  { key: "certificates", title: "证书", kind: "repeat", itemLabel: "证书" },
  { key: "family", title: "家庭情况", kind: "repeat", itemLabel: "家庭情况" },
  { key: "training", title: "培训经历", kind: "repeat", itemLabel: "培训经历" },
  { key: "papers", title: "论文和著作", kind: "repeat", itemLabel: "论文和著作" },
  { key: "patent", title: "专利", kind: "repeat", itemLabel: "专利" },
  { key: "self", title: "自我描述", kind: "simple" },
  { key: "declarations", title: "有关声明", kind: "simple" },
  { key: "other", title: "其他信息", kind: "simple" },
] as const;

export const UPSTREAM_SECTION_KEYS = new Set(
  UPSTREAM_SECTIONS.map((section) => section.key),
);
