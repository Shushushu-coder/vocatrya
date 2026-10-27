/**
 * Deterministic text builders for Application Profile copy.
 * No AI. Sensitive fields and internal preferences are never included in
 * section-level or full-page copies; they are only copied via their own
 * field-level copy button (handled client-side with the full value).
 */

export type EvidenceLike = {
  content?: string | null;
  metricText?: string | null;
  metricValue?: number | null;
  metricUnit?: string | null;
};

export type MaterialLike = {
  type?: string | null;
  title?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  isCurrent?: boolean | null;
  notes?: string | null;
  evidence?: EvidenceLike[] | null;
  internshipDetail?: { organizationName?: string | null; roleTitle?: string | null } | null;
  employmentDetail?: { organizationName?: string | null; roleTitle?: string | null } | null;
  projectDetail?: { organizationName?: string | null; roleTitle?: string | null; techStack?: string | null } | null;
  researchDetail?: { institution?: string | null; roleTitle?: string | null } | null;
  publicationDetail?: { venue?: string | null } | null;
  competitionDetail?: { organizer?: string | null } | null;
  campusActivityDetail?: { organizationName?: string | null; roleTitle?: string | null } | null;
  educationDetail?: { institution?: string | null; degree?: string | null; fieldOfStudy?: string | null } | null;
  awardDetail?: { issuer?: string | null } | null;
  skillDetail?: { skillName?: string | null; proficiency?: string | null } | null;
  certificationDetail?: { organization?: string | null } | null;
  languageDetail?: { language?: string | null; examOrLevel?: string | null; score?: string | null } | null;
  customDetail?: unknown;
};

function formatDateRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
  isCurrent?: boolean | null,
): string | null {
  const fmt = (d: Date | string) => {
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return String(d).slice(0, 10);
    return date.toISOString().slice(0, 10);
  };
  const s = start ? fmt(start) : null;
  const e = isCurrent ? "Present" : end ? fmt(end) : null;
  if (s && e) return `${s} - ${e}`;
  if (s) return s;
  if (e) return e;
  return null;
}

function materialOrgRole(item: MaterialLike): string | null {
  const d =
    item.internshipDetail ??
    item.employmentDetail ??
    item.projectDetail ??
    item.campusActivityDetail ??
    null;
  if (d) {
    const parts = [d.organizationName, d.roleTitle].filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
  }
  if (item.researchDetail) {
    const parts = [item.researchDetail.institution, item.researchDetail.roleTitle].filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
  }
  if (item.educationDetail) {
    const parts = [
      item.educationDetail.institution,
      item.educationDetail.degree,
      item.educationDetail.fieldOfStudy,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
  }
  if (item.publicationDetail?.venue) return item.publicationDetail.venue;
  if (item.competitionDetail?.organizer) return item.competitionDetail.organizer;
  if (item.awardDetail?.issuer) return item.awardDetail.issuer;
  if (item.skillDetail?.skillName) {
    return item.skillDetail.proficiency
      ? `${item.skillDetail.skillName} (${item.skillDetail.proficiency})`
      : item.skillDetail.skillName;
  }
  if (item.certificationDetail?.organization) return item.certificationDetail.organization;
  if (item.languageDetail) {
    const parts = [item.languageDetail.language, item.languageDetail.examOrLevel].filter(Boolean);
    if (parts.length > 0) {
      const base = parts.join(" · ");
      return item.languageDetail.score ? `${base} (${item.languageDetail.score})` : base;
    }
  }
  return null;
}

/**
 * Stable per-item text: title / organization-role / date range / notes /
 * selected evidence (content + metric). Never includes sensitive data.
 */
export function buildMaterialItemText(item: MaterialLike): string {
  const lines: string[] = [];
  if (item.title) lines.push(item.title.trim());
  const orgRole = materialOrgRole(item);
  if (orgRole) lines.push(orgRole);
  if (item.projectDetail?.techStack?.trim()) {
    lines.push(`技术栈：${item.projectDetail.techStack.trim()}`);
  }
  const range = formatDateRange(item.startDate, item.endDate, item.isCurrent);
  if (range) lines.push(range);
  if (item.notes?.trim()) lines.push(item.notes.trim());
  for (const ev of item.evidence ?? []) {
    if (!ev?.content?.trim()) continue;
    const metric = ev.metricText?.trim()
      ? ` (${ev.metricText.trim()})`
      : ev.metricValue !== null && ev.metricValue !== undefined
        ? ` (${String(ev.metricValue)}${ev.metricUnit ? ` ${ev.metricUnit}` : ""})`
        : "";
    lines.push(`- ${ev.content.trim()}${metric}`);
  }
  return lines.join("\n");
}

export function buildEducationSectionText(items: MaterialLike[]): string {
  return items.map(buildMaterialItemText).filter(Boolean).join("\n\n");
}

export function buildExperienceSectionText(items: MaterialLike[]): string {
  return items.map(buildMaterialItemText).filter(Boolean).join("\n\n");
}

export function buildSkillsSectionText(items: MaterialLike[]): string {
  return items.map(buildMaterialItemText).filter(Boolean).join("\n\n");
}

/**
 * Explicit whitelist for the personal-info group copy, in display order.
 * Sensitive keys (证件号、紧急联系人、证明人) are never listed here: they are
 * only copied through their own explicit per-field path.
 */
export const PERSONAL_INFO_COPY_FIELDS = [
  { key: "fullName", label: "姓名" },
  { key: "email", label: "邮箱" },
  { key: "phoneCountryCode", label: "电话区号" },
  { key: "phone", label: "电话" },
  { key: "address", label: "地址" },
  { key: "countryOrRegion", label: "国家/地区" },
  { key: "wechatId", label: "微信号" },
  { key: "qqNumber", label: "QQ号" },
  { key: "currentCity", label: "当前所在地" },
  { key: "homeCity", label: "家庭所在城市" },
  { key: "homeAddress", label: "家庭常驻地址" },
  { key: "gender", label: "性别" },
  { key: "birthDate", label: "出生日期" },
  { key: "ethnicity", label: "民族" },
  { key: "politicalStatus", label: "政治面貌" },
  { key: "nativePlace", label: "籍贯" },
  { key: "householdRegistration", label: "户口所在地" },
  { key: "graduationCohort", label: "毕业届别" },
  { key: "highestEducation", label: "最高学历" },
  { key: "schoolCity", label: "学校城市" },
  { key: "linksData", label: "个人主页" },
] as const;

export type PersonalInfoLike = Partial<
  Record<(typeof PERSONAL_INFO_COPY_FIELDS)[number]["key"], string | null>
> | null;

/** Bare values in whitelist order — the 基本资料 block body of the projection. */
export function buildBasicsSectionText(profile: PersonalInfoLike): string {
  if (!profile) return "";
  return PERSONAL_INFO_COPY_FIELDS.map(({ key }) => profile[key]?.trim())
    .filter((v): v is string => !!v)
    .join("\n");
}

/**
 * Labeled personal-info block (`label：value` per non-empty whitelisted
 * field). Self-describing for standalone pastes; sensitive fields are
 * unreachable by construction.
 */
export function buildPersonalInfoText(profile: PersonalInfoLike): string {
  if (!profile) return "";
  return PERSONAL_INFO_COPY_FIELDS.map(({ key, label }) => {
    const value = profile[key]?.trim();
    return value ? `${label}：${value}` : null;
  })
    .filter((v): v is string => !!v)
    .join("\n");
}

export type ApplicationProjectionInput = {
  profile: PersonalInfoLike;
  preference: {
    targetRoles?: string | null;
    preferredCities?: string | null;
    preferredIndustries?: string | null;
    recruitmentTypes?: string | null;
    availability?: string | null;
  } | null;
  education: MaterialLike[];
  experience: MaterialLike[];
  skills: MaterialLike[];
};

export type ApplicationProjectionSectionId =
  | "basics"
  | "preference"
  | "education"
  | "experience"
  | "skills";

export type ApplicationProjectionSection = {
  id: ApplicationProjectionSectionId;
  /** Section text including its fixed Chinese header line. */
  text: string;
};

/**
 * Ordered non-empty projection sections. Selecting a subset and joining the
 * texts with "\n\n" yields exactly the corresponding slice of the full
 * application summary.
 */
export function buildApplicationProjectionSections(
  input: ApplicationProjectionInput,
): ApplicationProjectionSection[] {
  const sections: ApplicationProjectionSection[] = [];
  const basics = buildBasicsSectionText(input.profile);
  if (basics) sections.push({ id: "basics", text: `基本资料\n${basics}` });
  const pref = input.preference;
  if (pref) {
    const lines = [
      pref.targetRoles,
      pref.preferredCities,
      pref.preferredIndustries,
      pref.recruitmentTypes,
      pref.availability,
    ]
      .filter((v): v is string => !!v?.trim())
      .map((v) => v.trim());
    if (lines.length > 0)
      sections.push({ id: "preference", text: `求职意向\n${lines.join("\n")}` });
  }
  const edu = buildEducationSectionText(input.education);
  if (edu) sections.push({ id: "education", text: `教育经历\n${edu}` });
  const exp = buildExperienceSectionText(input.experience);
  if (exp) sections.push({ id: "experience", text: `经历素材\n${exp}` });
  const skills = buildSkillsSectionText(input.skills);
  if (skills) sections.push({ id: "skills", text: `技能证书\n${skills}` });
  return sections;
}

/**
 * READ-ONLY projection for the 网申资料 tab. Excludes hardConstraints,
 * softPreferences, and all sensitive fields by construction (callers do not
 * pass them in).
 */
export function buildApplicationProjectionText(input: ApplicationProjectionInput): string {
  return buildApplicationProjectionSections(input)
    .map((s) => s.text)
    .join("\n\n");
}
