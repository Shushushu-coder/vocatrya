/**
 * CP-UI: frozen seven-tab contract for the career profile workspace.
 *
 * Order and names are fixed by the V1 product decision
 * (docs: 职业资料 V1 重构决策与呈现规格):
 *   个人信息 / 教育经历 / 实习经历 / 项目经历 / 获奖经历 / 其他 / 网申资料
 *
 * Tab visibility is a UI preference only: hiding a tab never deletes data
 * and never changes the application-projection copy scope. It persists at
 * `careerProfile.tabVisibility` inside the UserSettings JSON document via
 * the atomic patch path.
 *
 * Pure module: safe to import from both client components and server
 * actions (no "use client").
 */

export const CAREER_PROFILE_TAB_IDS = [
  "personal",
  "education",
  "internship",
  "project",
  "awards",
  "other",
  "application",
] as const;

export type CareerProfileTabId = (typeof CAREER_PROFILE_TAB_IDS)[number];

const TAB_ID_SET: ReadonlySet<string> = new Set(CAREER_PROFILE_TAB_IDS);

export function isCareerProfileTabId(
  value: unknown,
): value is CareerProfileTabId {
  return typeof value === "string" && TAB_ID_SET.has(value);
}

export type CareerProfileTabVisibility = Record<CareerProfileTabId, boolean>;

/**
 * Normalize the persisted `tabVisibility` subtree. Missing keys and any
 * non-boolean garbage default to visible so older payloads (and the
 * contract default) show all seven tabs. Unknown tab ids are dropped.
 */
export function normalizeTabVisibility(
  raw: unknown,
): CareerProfileTabVisibility {
  const source =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const visibility = {} as CareerProfileTabVisibility;
  for (const id of CAREER_PROFILE_TAB_IDS) {
    visibility[id] = source[id] !== false;
  }
  return visibility;
}

export function visibleCareerProfileTabs(
  visibility: CareerProfileTabVisibility,
): CareerProfileTabId[] {
  return CAREER_PROFILE_TAB_IDS.filter((id) => visibility[id]);
}

/**
 * Record tabs (in contract order) and the material types each renders.
 * Per the V1 contract: research and publications are sub-modules of
 * 教育经历; competitions count toward 获奖经历; skills, certifications,
 * campus activities and custom entries live under 其他.
 */
export const CAREER_PROFILE_RECORD_TAB_TYPES = {
  education: ["EDUCATION", "RESEARCH", "PUBLICATION"],
  internship: ["INTERNSHIP"],
  project: ["PROJECT"],
  awards: ["AWARD", "COMPETITION"],
  other: ["SKILL", "CERTIFICATION", "CAMPUS_ACTIVITY"],
} as const;

export type CareerProfileRecordTabId =
  keyof typeof CAREER_PROFILE_RECORD_TAB_TYPES;

export const CAREER_PROFILE_RECORD_TAB_IDS = Object.keys(
  CAREER_PROFILE_RECORD_TAB_TYPES,
) as CareerProfileRecordTabId[];

/**
 * Types offered by a tab's create/edit picker. EMPLOYMENT stays legacy
 * read-only and CUSTOM has no dedicated detail editor, matching the
 * previous workspace behavior.
 */
export const CAREER_PROFILE_TAB_CREATABLE_TYPES: Record<
  CareerProfileRecordTabId,
  readonly string[]
> = {
  education: ["EDUCATION", "RESEARCH", "PUBLICATION"],
  internship: ["INTERNSHIP"],
  project: ["PROJECT"],
  awards: ["AWARD", "COMPETITION"],
  other: ["CAMPUS_ACTIVITY", "SKILL", "CERTIFICATION"],
};

/** Legacy read-only types surfaced inside a record tab. */
export const CAREER_PROFILE_TAB_READONLY_TYPES: Partial<
  Record<CareerProfileRecordTabId, readonly string[]>
> = {
  internship: ["EMPLOYMENT"],
};

const NON_OTHER_TYPES: ReadonlySet<string> = new Set([
  ...CAREER_PROFILE_RECORD_TAB_TYPES.education,
  ...CAREER_PROFILE_RECORD_TAB_TYPES.internship,
  ...CAREER_PROFILE_RECORD_TAB_TYPES.project,
  ...CAREER_PROFILE_RECORD_TAB_TYPES.awards,
  "EMPLOYMENT",
]);

/**
 * Items rendered inside a record tab. `other` is a catch-all: any material
 * type not owned by another record tab (CUSTOM, legacy or future types)
 * still surfaces somewhere instead of silently disappearing.
 */
export function itemsForRecordTab<T extends { type: string }>(
  items: T[],
  tabId: CareerProfileRecordTabId,
): T[] {
  if (tabId === "other") {
    return items.filter((item) => !NON_OTHER_TYPES.has(item.type));
  }
  const owned = new Set<string>(CAREER_PROFILE_RECORD_TAB_TYPES[tabId]);
  return items.filter((item) => owned.has(item.type));
}
