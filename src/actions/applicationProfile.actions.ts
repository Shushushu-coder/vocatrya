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
  assertApplicationMaterialCreateTitle,
  sanitizeApplicationMaterialDetail,
} from "@/lib/career/careerMaterialInput";
import { maskName, maskPhone } from "@/lib/career/sensitiveMask";
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
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    // V1 explicitly defers headline/linksData/extraData: never accept them here.
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
    const title = assertApplicationMaterialCreateTitle(input.title);
    const detail = sanitizeApplicationMaterialDetail(input.type, input.detail);
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
    const data = await materialService(user.id).update({
      id: input.id,
      title: input.title?.trim(),
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
    const [profile, preference, materials, sensitive] = await Promise.all([
      candidateService(user.id).getCandidateProfile(user.id),
      preferenceService(user.id).getJobSearchPreference(user.id),
      materialService(user.id).list(),
      candidateService(user.id).getCandidateSensitiveInfo(user.id),
    ]);
    // Never return full sensitive values in the projection. Emergency contact
    // is copied only via its own field-level copy action.
    return {
      success: true,
      data: {
        profile,
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
