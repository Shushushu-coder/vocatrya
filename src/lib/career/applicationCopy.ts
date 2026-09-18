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
  projectDetail?: { organizationName?: string | null; roleTitle?: string | null } | null;
  researchDetail?: { institution?: string | null; roleTitle?: string | null } | null;
  publicationDetail?: { venue?: string | null } | null;
  competitionDetail?: { organizer?: string | null } | null;
  campusActivityDetail?: { organizationName?: string | null; roleTitle?: string | null } | null;
  educationDetail?: { institution?: string | null; degree?: string | null; fieldOfStudy?: string | null } | null;
  awardDetail?: { issuer?: string | null } | null;
  skillDetail?: { skillName?: string | null; proficiency?: string | null } | null;
  certificationDetail?: { organization?: string | null } | null;
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

export type ApplicationProjectionInput = {
  profile: {
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    gender?: string | null;
    birthDate?: string | null;
    ethnicity?: string | null;
    politicalStatus?: string | null;
    nativePlace?: string | null;
    householdRegistration?: string | null;
    graduationCohort?: string | null;
  } | null;
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

/**
 * READ-ONLY projection for the 网申资料 tab. Excludes hardConstraints,
 * softPreferences, and all sensitive fields by construction (callers do not
 * pass them in).
 */
export function buildApplicationProjectionText(input: ApplicationProjectionInput): string {
  const sections: string[] = [];
  const p = input.profile;
  if (p) {
    const basics = [
      p.fullName,
      p.email,
      p.phone,
      p.address,
      p.gender,
      p.birthDate,
      p.ethnicity,
      p.politicalStatus,
      p.nativePlace,
      p.householdRegistration,
      p.graduationCohort,
    ]
      .filter((v): v is string => !!v?.trim())
      .map((v) => v.trim());
    if (basics.length > 0) sections.push(`基本资料\n${basics.join("\n")}`);
  }
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
    if (lines.length > 0) sections.push(`求职意向\n${lines.join("\n")}`);
  }
  const edu = buildEducationSectionText(input.education);
  if (edu) sections.push(`教育经历\n${edu}`);
  const exp = buildExperienceSectionText(input.experience);
  if (exp) sections.push(`经历素材\n${exp}`);
  const skills = buildSkillsSectionText(input.skills);
  if (skills) sections.push(`技能证书\n${skills}`);
  return sections.join("\n\n");
}
