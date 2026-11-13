import type { PrismaClient } from "@prisma/client";
import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { JobSearchPreferenceService } from "@/lib/career/jobSearchPreferenceService";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import type {
  AutoApplySource,
  AutoApplySourceMaterial,
  AutoApplySourcePreference,
  AutoApplySourceProfile,
} from "./types";

/**
 * Whitelist read layer for the auto-apply export.
 *
 * Explicitly NOT read here: CandidateSensitiveInfo (证件/紧急联系人),
 * CandidateFamilyMember, CandidateReferee, CandidateAttachment, File rows and
 * any credential tables. The services above return whole rows, so every
 * consumer-facing DTO is rebuilt with explicit field picks — a column added
 * to a Prisma model later cannot silently leak into the export.
 */

const MATERIAL_DETAIL_RELATION: Record<string, string> = {
  EMPLOYMENT: "employmentDetail",
  INTERNSHIP: "internshipDetail",
  PROJECT: "projectDetail",
  RESEARCH: "researchDetail",
  PUBLICATION: "publicationDetail",
  COMPETITION: "competitionDetail",
  CAMPUS_ACTIVITY: "campusActivityDetail",
  EDUCATION: "educationDetail",
  AWARD: "awardDetail",
  SKILL: "skillDetail",
  CERTIFICATION: "certificationDetail",
  LANGUAGE: "languageDetail",
  CUSTOM: "customDetail",
};

/**
 * Plain columns allowed per detail type. Everything else on the detail row
 * (ids, materialItemId, structuredData, companyId, relation objects,
 * timestamps) is dropped here.
 */
const MATERIAL_DETAIL_FIELDS: Record<string, readonly string[]> = {
  EMPLOYMENT: ["organizationName", "roleTitle", "employmentType", "locationText"],
  INTERNSHIP: ["organizationName", "roleTitle", "locationText", "department"],
  EDUCATION: [
    "institution",
    "degree",
    "fieldOfStudy",
    "locationText",
    "gpaValue",
    "gpaScale",
    "rankText",
    "currentStudyLocation",
    "department",
    "majorCategory",
    "studyMode",
    "isExchange",
    "graduationOn",
    "graduationExpected",
    "rankClassText",
    "rankMajorText",
    "hasNationalScholarship",
    "advisorName",
    "labName",
    "researchDirection",
  ],
  PROJECT: ["organizationName", "roleTitle", "projectUrl", "projectType", "techStack"],
  RESEARCH: ["institution", "roleTitle", "field"],
  PUBLICATION: ["venue", "authors", "url", "venueLevel", "authorRole", "publishedAt"],
  COMPETITION: ["organizer", "awardLevel", "result"],
  CAMPUS_ACTIVITY: ["organizationName", "roleTitle"],
  AWARD: ["issuer", "awardedAt", "awardType", "awardLevel", "awardScope"],
  SKILL: ["skillName", "proficiency"],
  CERTIFICATION: ["organization", "credentialUrl", "credentialId", "issueDate", "expirationDate"],
  LANGUAGE: ["language", "examOrLevel", "score", "obtainedOn"],
  CUSTOM: [],
};

function pickProfile(row: Record<string, unknown>): AutoApplySourceProfile {
  const pick = (key: string) => (row[key] as string | null) ?? null;
  return {
    fullName: pick("fullName"),
    headline: pick("headline"),
    email: pick("email"),
    phone: pick("phone"),
    phoneCountryCode: pick("phoneCountryCode"),
    address: pick("address"),
    linksData: pick("linksData"),
    gender: pick("gender"),
    birthDate: pick("birthDate"),
    ethnicity: pick("ethnicity"),
    politicalStatus: pick("politicalStatus"),
    nativePlace: pick("nativePlace"),
    householdRegistration: pick("householdRegistration"),
    graduationCohort: pick("graduationCohort"),
    countryOrRegion: pick("countryOrRegion"),
    wechatId: pick("wechatId"),
    qqNumber: pick("qqNumber"),
    currentCity: pick("currentCity"),
    homeCity: pick("homeCity"),
    homeAddress: pick("homeAddress"),
    updatedAt: (row.updatedAt as Date | string | null) ?? null,
    hasExtraData: typeof row.extraData === "string" && row.extraData.trim() !== "",
  };
}

function pickPreference(row: Record<string, unknown>): AutoApplySourcePreference {
  const pick = (key: string) => (row[key] as string | null) ?? null;
  return {
    targetRoles: pick("targetRoles"),
    preferredCities: pick("preferredCities"),
    preferredIndustries: pick("preferredIndustries"),
    recruitmentTypes: pick("recruitmentTypes"),
    availability: pick("availability"),
    updatedAt: (row.updatedAt as Date | string | null) ?? null,
    hasConstraints:
      typeof row.hardConstraints === "string" && row.hardConstraints.trim() !== "",
    hasSoftPreferences:
      typeof row.softPreferences === "string" && row.softPreferences.trim() !== "",
  };
}

function hasStructuredData(detail: Record<string, unknown> | null): boolean {
  const raw = detail?.structuredData;
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return trimmed !== "" && trimmed !== "{}";
}

function flattenMaterial(item: Record<string, unknown>): AutoApplySourceMaterial {
  const type = String(item.type ?? "");
  const relation = MATERIAL_DETAIL_RELATION[type];
  const rawDetail =
    relation && item[relation] && typeof item[relation] === "object"
      ? (item[relation] as Record<string, unknown>)
      : null;
  const allowed = MATERIAL_DETAIL_FIELDS[type] ?? [];
  const detail: Record<string, unknown> = {};
  if (rawDetail) {
    for (const key of allowed) {
      if (key in rawDetail) detail[key] = rawDetail[key];
    }
  }
  const rawEvidence = Array.isArray(item.evidence) ? item.evidence : [];
  return {
    id: String(item.id ?? ""),
    type,
    title: typeof item.title === "string" ? item.title : "",
    startDate: (item.startDate as Date | string | null) ?? null,
    endDate: (item.endDate as Date | string | null) ?? null,
    isCurrent: item.isCurrent === true,
    notes: (item.notes as string | null) ?? null,
    updatedAt: (item.updatedAt as Date | string | null) ?? null,
    detail,
    hasStructuredData: hasStructuredData(rawDetail),
    evidence: rawEvidence.map((entry) => ({
      content: (entry?.content as string | null) ?? null,
      metricText: (entry?.metricText as string | null) ?? null,
    })),
  };
}

export async function loadAutoApplySource(
  db: PrismaClient,
  userId: string,
): Promise<AutoApplySource> {
  const [profile, preference, materials] = await Promise.all([
    new CandidateProfileService(db, userId).getCandidateProfile(userId),
    new JobSearchPreferenceService(db, userId).getJobSearchPreference(userId),
    new CareerMaterialService(db, userId).list(),
  ]);
  return {
    profile: profile ? pickProfile(profile as unknown as Record<string, unknown>) : null,
    preference: preference
      ? pickPreference(preference as unknown as Record<string, unknown>)
      : null,
    materials: materials.map((item) =>
      flattenMaterial(item as unknown as Record<string, unknown>),
    ),
  };
}
