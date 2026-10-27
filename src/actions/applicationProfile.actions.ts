"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import {
  assertCareerDataReadable,
  assertCareerDataWritable,
  assertCareerDataCopyable,
} from "@/lib/career/access";
import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { JobSearchPreferenceService } from "@/lib/career/jobSearchPreferenceService";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import {
  resolveApplicationMaterialTitle,
  sanitizeApplicationMaterialDetail,
} from "@/lib/career/careerMaterialInput";
import { CandidateRefereeService } from "@/lib/career/candidateRefereeService";
import {
  CandidateAttachmentService,
  careerAttachmentDTO,
} from "@/lib/career/candidateAttachmentService";
import { EducationDerivationService } from "@/lib/career/educationDerivation";
import { maskEmail, maskIdNumber, maskName, maskPhone } from "@/lib/career/sensitiveMask";
import {
  resolveLocalDbDisplayPath,
  type LocalDbPathDisplay,
} from "@/lib/career/localDbPath";
import type { ActionResult } from "@/models/action.model";

const APPLICATION_PATH = "/dashboard/profile/application";

function candidateService(userId: string) {
  return new CandidateProfileService(prisma as never, userId);
}

function preferenceService(userId: string) {
  return new JobSearchPreferenceService(prisma as never, userId);
}

function materialService(userId: string) {
  return new CareerMaterialService(prisma as never, userId);
}

function refereeService(userId: string) {
  return new CandidateRefereeService(prisma as never, userId);
}

function attachmentService(userId: string) {
  return new CandidateAttachmentService(prisma as never, userId);
}

// --- CandidateProfile ---

export async function getApplicationCandidateProfile(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const data = await candidateService(user.id).getCandidateProfile(user.id);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load application profile.");
  }
}

export async function updateApplicationCandidateProfile(input: {
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
  countryOrRegion?: string | null;
  wechatId?: string | null;
  qqNumber?: string | null;
  currentCity?: string | null;
  homeCity?: string | null;
  homeAddress?: string | null;
  phoneCountryCode?: string | null;
  linksData?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    // headline/extraData stay deferred; linksData carries 作品/个人主页 (D9).
    const data = await candidateService(user.id).upsertCandidateProfile(user.id, {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      address: input.address,
      gender: input.gender,
      birthDate: input.birthDate,
      ethnicity: input.ethnicity,
      politicalStatus: input.politicalStatus,
      nativePlace: input.nativePlace,
      householdRegistration: input.householdRegistration,
      graduationCohort: input.graduationCohort,
      countryOrRegion: input.countryOrRegion,
      wechatId: input.wechatId,
      qqNumber: input.qqNumber,
      currentCity: input.currentCity,
      homeCity: input.homeCity,
      homeAddress: input.homeAddress,
      phoneCountryCode: input.phoneCountryCode,
      linksData: input.linksData,
    });
    revalidatePath(APPLICATION_PATH);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to save application profile.");
  }
}

// --- Emergency contact (sensitive, V1 scope only) ---

export async function getEmergencyContactOverview(): Promise<ActionResult<{
  hasData: boolean;
  maskedName: string | null;
  relation: string | null;
  maskedPhone: string | null;
  updatedAt: string | null;
}>> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    if (!row) {
      return {
        success: true,
        data: { hasData: false, maskedName: null, relation: null, maskedPhone: null, updatedAt: null },
      };
    }
    return {
      success: true,
      data: {
        hasData: Boolean(
          row.emergencyContactName ?? row.emergencyContactRelation ?? row.emergencyContactPhone,
        ),
        maskedName: row.emergencyContactName ? maskName(row.emergencyContactName) : null,
        relation: row.emergencyContactRelation ?? null,
        maskedPhone: row.emergencyContactPhone ? maskPhone(row.emergencyContactPhone) : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to load emergency contact.");
  }
}

export async function revealEmergencyContact(): Promise<ActionResult<{
  name: string | null;
  relation: string | null;
  phone: string | null;
}>> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    return {
      success: true,
      data: {
        name: row?.emergencyContactName ?? null,
        relation: row?.emergencyContactRelation ?? null,
        phone: row?.emergencyContactPhone ?? null,
      },
    };
  } catch (error) {
    // Never echo values on failure.
    return handleError(error, "Failed to reveal emergency contact.");
  }
}

export async function copyEmergencyContactField(
  field: "emergencyContactName" | "emergencyContactRelation" | "emergencyContactPhone",
): Promise<ActionResult<{ value: string | null }>> {
  try {
    const user = await requireUser();
    await assertCareerDataCopyable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    const value =
      field === "emergencyContactName"
        ? (row?.emergencyContactName ?? null)
        : field === "emergencyContactRelation"
          ? (row?.emergencyContactRelation ?? null)
          : (row?.emergencyContactPhone ?? null);
    return { success: true, data: { value } };
  } catch (error) {
    return handleError(error, "Failed to copy emergency contact.");
  }
}

export async function updateEmergencyContact(input: {
  emergencyContactName?: string | null;
  emergencyContactRelation?: string | null;
  emergencyContactPhone?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    // V1 defers idNumber and family members: never accept them here.
    const data = await candidateService(user.id).upsertCandidateSensitiveInfo(user.id, {
      emergencyContactName: input.emergencyContactName,
      emergencyContactRelation: input.emergencyContactRelation,
      emergencyContactPhone: input.emergencyContactPhone,
    });
    revalidatePath(APPLICATION_PATH);
    // Never return full sensitive values in the write response.
    return {
      success: true,
      data: {
        id: data.id,
        updatedAt: data.updatedAt,
        maskedName: data.emergencyContactName ? maskName(data.emergencyContactName) : null,
        relation: data.emergencyContactRelation ?? null,
        maskedPhone: data.emergencyContactPhone ? maskPhone(data.emergencyContactPhone) : null,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to save emergency contact.");
  }
}

// --- JobSearchPreference ---

export async function getJobSearchPreference(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const data = await preferenceService(user.id).getJobSearchPreference(user.id);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load job preferences.");
  }
}

export async function upsertJobSearchPreference(input: {
  targetRoles?: string | null;
  preferredCities?: string | null;
  preferredIndustries?: string | null;
  recruitmentTypes?: string | null;
  availability?: string | null;
  hardConstraints?: string | null;
  softPreferences?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await preferenceService(user.id).upsertJobSearchPreference(user.id, input);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to save job preferences.");
  }
}

// --- CareerMaterial ---

export async function listApplicationMaterials(input?: {
  type?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const data = await materialService(user.id).list({ type: input?.type });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load materials.");
  }
}

export async function getApplicationMaterial(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const data = await materialService(user.id).get(id);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load material.");
  }
}

export async function createApplicationMaterial(input: {
  type: string;
  title: string;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  notes?: string | null;
  detail?: Record<string, unknown>;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const detail = sanitizeApplicationMaterialDetail(input.type, input.detail);
    const title = resolveApplicationMaterialTitle(input.type, input.title, detail);
    const data = await materialService(user.id).create({
      type: input.type,
      title,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      isCurrent: input.isCurrent ?? false,
      notes: input.notes ?? null,
      detail,
    });
    revalidatePath(APPLICATION_PATH);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create material.");
  }
}

export async function updateApplicationMaterial(input: {
  id: string;
  title?: string;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  notes?: string | null;
  detail?: Record<string, unknown>;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const existing = await materialService(user.id).get(input.id);
    const detail =
      input.detail === undefined
        ? undefined
        : sanitizeApplicationMaterialDetail(existing.type, input.detail);
    // Language records title themselves from the detail (§3.1); follow the
    // detail update so the list row stays readable.
    const title =
      existing.type === "LANGUAGE" && input.title === undefined
        ? resolveApplicationMaterialTitle(
            "LANGUAGE",
            existing.title,
            { ...(existing.languageDetail ?? {}), ...(detail ?? {}) },
          )
        : input.title?.trim();
    const data = await materialService(user.id).update({
      id: input.id,
      title,
      startDate:
        input.startDate === undefined ? undefined : input.startDate ? new Date(input.startDate) : null,
      endDate:
        input.endDate === undefined ? undefined : input.endDate ? new Date(input.endDate) : null,
      isCurrent: input.isCurrent,
      notes: input.notes,
      detail,
    });
    revalidatePath(APPLICATION_PATH);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update material.");
  }
}

export async function archiveApplicationMaterial(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await materialService(user.id).archive(id);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: { id: data.id } };
  } catch (error) {
    return handleError(error, "Failed to archive material.");
  }
}

export async function addApplicationMaterialEvidence(input: {
  materialItemId: string;
  content: string;
  metricText?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    // V1 exposes evidence as fact points (content + metric) only.
    const data = await materialService(user.id).addEvidence({
      materialItemId: input.materialItemId,
      kind: "FACT",
      content: input.content.trim(),
      metricText: input.metricText?.trim() ?? null,
    });
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: { id: data.id } };
  } catch (error) {
    return handleError(error, "Failed to add evidence.");
  }
}

// --- Safe local storage metadata (path display only) ---

export async function getLocalDbPathDisplay(): Promise<ActionResult<LocalDbPathDisplay>> {
  try {
    const user = await requireUser();
    void user;
    await assertCareerDataReadable(prisma as never);
    return { success: true, data: resolveLocalDbDisplayPath() };
  } catch (error) {
    return handleError(error, "Failed to load storage info.");
  }
}

// --- READ-ONLY aggregation projection (no new table) ---

export async function getApplicationProjection(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const [profile, preference, materials, sensitive, derived] = await Promise.all([
      candidateService(user.id).getCandidateProfile(user.id),
      preferenceService(user.id).getJobSearchPreference(user.id),
      materialService(user.id).list(),
      candidateService(user.id).getCandidateSensitiveInfo(user.id),
      new EducationDerivationService(prisma as never, user.id).getDerivedEducationSummary(),
    ]);
    // Never return full sensitive values in the projection. Emergency contact
    // is copied only via its own field-level copy action. Referees,
    // idType/idNumber and attachment metadata never reach this payload at all.
    return {
      success: true,
      data: {
        profile,
        derived,
        preference: preference
          ? {
              targetRoles: preference.targetRoles,
              preferredCities: preference.preferredCities,
              preferredIndustries: preference.preferredIndustries,
              recruitmentTypes: preference.recruitmentTypes,
              availability: preference.availability,
            }
          : null,
        materials,
        emergencyContact: sensitive
          ? {
              maskedName: sensitive.emergencyContactName
                ? maskName(sensitive.emergencyContactName)
                : null,
              relation: sensitive.emergencyContactRelation ?? null,
              maskedPhone: sensitive.emergencyContactPhone
                ? maskPhone(sensitive.emergencyContactPhone)
                : null,
            }
          : null,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to load application overview.");
  }
}

// --- ID document (sensitive: idType + idNumber) ---

export async function getIdDocumentOverview(): Promise<ActionResult<{
  hasData: boolean;
  idType: string | null;
  maskedIdNumber: string | null;
  updatedAt: string | null;
}>> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    if (!row) {
      return {
        success: true,
        data: { hasData: false, idType: null, maskedIdNumber: null, updatedAt: null },
      };
    }
    return {
      success: true,
      data: {
        hasData: Boolean(row.idType ?? row.idNumber),
        idType: row.idType ?? null,
        maskedIdNumber: row.idNumber ? maskIdNumber(row.idNumber) : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to load ID document.");
  }
}

export async function revealIdDocument(): Promise<ActionResult<{
  idType: string | null;
  idNumber: string | null;
}>> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    return {
      success: true,
      data: { idType: row?.idType ?? null, idNumber: row?.idNumber ?? null },
    };
  } catch (error) {
    return handleError(error, "Failed to reveal ID document.");
  }
}

export async function copyIdDocumentField(
  field: "idType" | "idNumber",
): Promise<ActionResult<{ value: string | null }>> {
  try {
    const user = await requireUser();
    await assertCareerDataCopyable(prisma as never);
    const row = await candidateService(user.id).getCandidateSensitiveInfo(user.id);
    return {
      success: true,
      data: { value: field === "idType" ? (row?.idType ?? null) : (row?.idNumber ?? null) },
    };
  } catch (error) {
    return handleError(error, "Failed to copy ID document field.");
  }
}

export async function updateIdDocument(input: {
  idType?: string | null;
  idNumber?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await candidateService(user.id).upsertCandidateSensitiveInfo(user.id, {
      idType: input.idType,
      idNumber: input.idNumber,
    });
    revalidatePath(APPLICATION_PATH);
    // Never return full sensitive values in the write response.
    return {
      success: true,
      data: {
        id: data.id,
        updatedAt: data.updatedAt,
        idType: data.idType ?? null,
        maskedIdNumber: data.idNumber ? maskIdNumber(data.idNumber) : null,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to save ID document.");
  }
}

// --- CandidateReferee (sensitive, single-record CRUD + archive) ---

function maskedRefereeDTO(row: {
  id: string;
  name: string | null;
  organization: string | null;
  position: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    maskedName: row.name ? maskName(row.name) : null,
    organization: row.organization ?? null,
    position: row.position ?? null,
    relationship: row.relationship ?? null,
    maskedPhone: row.phone ? maskPhone(row.phone) : null,
    maskedEmail: row.email ? maskEmail(row.email) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCandidateReferees(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const rows = await refereeService(user.id).list();
    return { success: true, data: rows.map(maskedRefereeDTO) };
  } catch (error) {
    return handleError(error, "Failed to load referees.");
  }
}

export async function revealCandidateReferee(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const rows = await refereeService(user.id).list();
    const row = rows.find((item) => item.id === id);
    if (!row) return { success: false, message: "Referee not found." };
    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        organization: row.organization,
        position: row.position,
        relationship: row.relationship,
        phone: row.phone,
        email: row.email,
        note: row.note,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to reveal referee.");
  }
}

const REFEREE_COPY_FIELDS = new Set([
  "name",
  "organization",
  "position",
  "relationship",
  "phone",
  "email",
  "note",
]);

export async function copyCandidateRefereeField(
  id: string,
  field: string,
): Promise<ActionResult<{ value: string | null }>> {
  try {
    const user = await requireUser();
    await assertCareerDataCopyable(prisma as never);
    if (!REFEREE_COPY_FIELDS.has(field)) {
      return { success: false, message: "Unsupported referee field." };
    }
    const rows = await refereeService(user.id).list();
    const row = rows.find((item) => item.id === id);
    if (!row) return { success: false, message: "Referee not found." };
    return {
      success: true,
      data: { value: (row as unknown as Record<string, string | null>)[field] ?? null },
    };
  } catch (error) {
    return handleError(error, "Failed to copy referee field.");
  }
}

export async function createCandidateReferee(input: {
  name?: string | null;
  organization?: string | null;
  position?: string | null;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await refereeService(user.id).create(input);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: maskedRefereeDTO(data) };
  } catch (error) {
    return handleError(error, "Failed to create referee.");
  }
}

export async function updateCandidateReferee(input: {
  id: string;
  name?: string | null;
  organization?: string | null;
  position?: string | null;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const { id, ...rest } = input;
    const data = await refereeService(user.id).update(id, rest);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: maskedRefereeDTO(data) };
  } catch (error) {
    return handleError(error, "Failed to save referee.");
  }
}

export async function archiveCandidateReferee(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await refereeService(user.id).archive(id);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: { id: data.id } };
  } catch (error) {
    return handleError(error, "Failed to archive referee.");
  }
}

// --- CandidateAttachment (sensitive dataset; upload/list/archive) ---

export async function listCandidateAttachments(input?: {
  category?: string;
  materialItemId?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const rows = await attachmentService(user.id).list({
      category: input?.category,
      materialItemId: input?.materialItemId,
    });
    return { success: true, data: rows.map(careerAttachmentDTO) };
  } catch (error) {
    return handleError(error, "Failed to load attachments.");
  }
}

export async function uploadCandidateAttachment(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const category = formData.get("category");
    const file = formData.get("file");
    const materialItemId = formData.get("materialItemId");
    if (typeof category !== "string" || !(file instanceof File)) {
      return { success: false, message: "Attachment file is required." };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await attachmentService(user.id).create({
      category,
      fileName: file.name || "attachment",
      bytes,
      materialItemId: typeof materialItemId === "string" && materialItemId ? materialItemId : null,
    });
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: careerAttachmentDTO(data) };
  } catch (error) {
    return handleError(error, "Failed to upload attachment.");
  }
}

export async function archiveCandidateAttachment(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const data = await attachmentService(user.id).archive(id);
    revalidatePath(APPLICATION_PATH);
    return { success: true, data: { id: data.id } };
  } catch (error) {
    return handleError(error, "Failed to archive attachment.");
  }
}
