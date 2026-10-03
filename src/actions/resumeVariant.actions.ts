"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import {
  assertResumeV1Readable,
  assertResumeV1Writable,
} from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import { ResumeProvenanceService } from "@/lib/career/resumeProvenanceService";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { ResumeArtifactService, resumeArtifactDTO } from "@/lib/career/resumeArtifactService";
import { buildResumeHeaderSnapshot } from "@/lib/career/resumeHeaderSnapshot";
import type { ActionResult } from "@/models/action.model";

const LIST_PATH = "/dashboard/profile/resumes";

function variantsFor(userId: string) {
  return new ResumeVariantService(prisma as never, userId);
}

function provenanceFor(userId: string) {
  return new ResumeProvenanceService(prisma as never, userId);
}

function materialsFor(userId: string) {
  return new CareerMaterialService(prisma as never, userId);
}

function workspacePath(variantId: string) {
  return `${LIST_PATH}/${variantId}`;
}

function requireId(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CareerRuntimeError(code, code);
  }
  return value.trim();
}

function requireIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new CareerRuntimeError("REORDER_INVALID", "Invalid id list");
  }
  return value.map((id) => id.trim());
}

function optionalId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new CareerRuntimeError("INVALID_ID", "Invalid id");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function listResumeVariants(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).listVariants();
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to list resume variants.");
  }
}

export async function getResumeVariant(variantId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).getVariant(requireId(variantId, "VARIANT_NOT_FOUND"));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load resume variant.");
  }
}

export async function createResumeVariant(input: {
  name: string;
  targetJobOpportunityId?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const name = requireId(input?.name, "VARIANT_NAME_REQUIRED");
    const profile = await new CandidateProfileService(
      prisma as never,
      user.id,
    ).getCandidateProfile(user.id);
    const data = await variantsFor(user.id).createVariant({
      name,
      targetJobOpportunityId: optionalId(input?.targetJobOpportunityId),
      headerSnapshot: buildResumeHeaderSnapshot(
        profile
          ? {
              fullName: profile.fullName,
              headline: profile.headline,
              email: profile.email,
              phone: profile.phone,
              address: profile.address,
              linksData: profile.linksData,
            }
          : null,
      ),
    });
    revalidatePath(LIST_PATH);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create resume variant.");
  }
}

export async function renameResumeVariant(input: {
  variantId: string;
  name: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).renameVariant(
      requireId(input?.variantId, "VARIANT_NOT_FOUND"),
      requireId(input?.name, "VARIANT_NAME_REQUIRED"),
    );
    revalidatePath(LIST_PATH);
    revalidatePath(workspacePath(data.id));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to rename resume variant.");
  }
}

export async function archiveResumeVariant(variantId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).archiveVariant(
      requireId(variantId, "VARIANT_NOT_FOUND"),
    );
    revalidatePath(LIST_PATH);
    revalidatePath(workspacePath(data.id));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to archive resume variant.");
  }
}

export async function listResumeVariantVersions(
  variantId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).listVariantVersions(
      requireId(variantId, "VARIANT_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to list resume versions.");
  }
}

export async function getResumeVariantVersion(
  versionId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).getVersion(
      requireId(versionId, "VERSION_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load resume version.");
  }
}

export async function resolveResumeVariantWorkspaceVersion(input: {
  variantId: string;
  versionId: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).resolveWorkspaceVersion(
      requireId(input?.variantId, "VARIANT_NOT_FOUND"),
      requireId(input?.versionId, "VERSION_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to resolve resume version.");
  }
}

export async function listSubmittableResumeVersions(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const data = await variantsFor(user.id).listSubmittableVersions();
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to list submittable resume versions.");
  }
}

export async function createBlankResumeDraft(variantId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).createBlankDraft(
      requireId(variantId, "VARIANT_NOT_FOUND"),
    );
    revalidatePath(workspacePath(requireId(variantId, "VARIANT_NOT_FOUND")));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create blank draft.");
  }
}

export async function cloneResumeVersionAsDraft(
  versionId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).cloneAsDraft(
      requireId(versionId, "VERSION_NOT_FOUND"),
    );
    const version = await variantsFor(user.id).getVersion(data.id);
    revalidatePath(workspacePath(version.resumeVariant.id));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to clone resume version.");
  }
}

export async function freezeResumeVersion(versionId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).freeze(
      requireId(versionId, "VERSION_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to freeze resume version.");
  }
}

export async function findReusableResumeExport(versionId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma);
    const artifact = await new ResumeArtifactService(prisma, user.id).findReusableExport(
      requireId(versionId, "VERSION_NOT_FOUND"),
    );
    return { success: true, data: artifact ? resumeArtifactDTO(artifact) : null };
  } catch (error) {
    return handleError(error, "Failed to look up resume export.");
  }
}

export async function updateResumeHeaderSnapshot(input: {
  versionId: string;
  fullName?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  links?: Array<{ label?: string | null; url?: string | null }> | string[] | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).updateHeaderSnapshot(
      requireId(input?.versionId, "VERSION_NOT_FOUND"),
      {
        fullName: input.fullName ?? null,
        headline: input.headline ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        links: input.links ?? [],
      },
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update resume header.");
  }
}

export async function createResumeSection(input: {
  versionId: string;
  title: string;
  systemKind?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).createSection({
      versionId: requireId(input?.versionId, "VERSION_NOT_FOUND"),
      title: requireId(input?.title, "SECTION_TITLE_REQUIRED"),
      systemKind: optionalId(input?.systemKind),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create section.");
  }
}

export async function updateResumeSection(input: {
  sectionId: string;
  title?: string;
  systemKind?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).updateSection({
      sectionId: requireId(input?.sectionId, "SECTION_NOT_FOUND"),
      title: input.title === undefined ? undefined : requireId(input.title, "SECTION_TITLE_REQUIRED"),
      systemKind: input.systemKind === undefined ? undefined : optionalId(input.systemKind),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update section.");
  }
}

export async function deleteResumeSection(sectionId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).deleteSection(
      requireId(sectionId, "SECTION_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to delete section.");
  }
}

export async function reorderResumeSections(input: {
  versionId: string;
  orderedIds: string[];
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).reorderSections(
      requireId(input?.versionId, "VERSION_NOT_FOUND"),
      requireIdList(input?.orderedIds),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to reorder sections.");
  }
}

export async function createResumeSectionItem(input: {
  sectionId: string;
  careerMaterialItemId?: string | null;
  itemKind?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).createSectionItem({
      sectionId: requireId(input?.sectionId, "SECTION_NOT_FOUND"),
      careerMaterialItemId: optionalId(input?.careerMaterialItemId),
      itemKind: optionalId(input?.itemKind),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to add resume item.");
  }
}

export async function updateResumeSectionItem(input: {
  itemId: string;
  itemKind?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).updateSectionItem({
      itemId: requireId(input?.itemId, "ITEM_NOT_FOUND"),
      itemKind: input.itemKind === undefined ? undefined : requireId(input.itemKind, "INVALID_ITEM_KIND"),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update resume item.");
  }
}

export async function deleteResumeSectionItem(itemId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).deleteSectionItem(
      requireId(itemId, "ITEM_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to delete resume item.");
  }
}

export async function reorderResumeSectionItems(input: {
  sectionId: string;
  orderedIds: string[];
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).reorderSectionItems(
      requireId(input?.sectionId, "SECTION_NOT_FOUND"),
      requireIdList(input?.orderedIds),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to reorder resume items.");
  }
}

export async function createResumeExpression(input: {
  itemId: string;
  content: string;
  kind?: string | null;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).createExpression({
      itemId: requireId(input?.itemId, "ITEM_NOT_FOUND"),
      content: requireId(input?.content, "EXPRESSION_CONTENT_REQUIRED"),
      kind: optionalId(input?.kind),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create expression.");
  }
}

export async function updateResumeExpression(input: {
  expressionId: string;
  content?: string;
  kind?: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).updateExpression({
      expressionId: requireId(input?.expressionId, "EXPRESSION_NOT_FOUND"),
      content:
        input.content === undefined
          ? undefined
          : requireId(input.content, "EXPRESSION_CONTENT_REQUIRED"),
      kind: input.kind === undefined ? undefined : requireId(input.kind, "INVALID_EXPRESSION_KIND"),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update expression.");
  }
}

export async function deleteResumeExpression(
  expressionId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).deleteExpression(
      requireId(expressionId, "EXPRESSION_NOT_FOUND"),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to delete expression.");
  }
}

export async function reorderResumeExpressions(input: {
  itemId: string;
  orderedIds: string[];
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await variantsFor(user.id).reorderExpressions(
      requireId(input?.itemId, "ITEM_NOT_FOUND"),
      requireIdList(input?.orderedIds),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to reorder expressions.");
  }
}

export async function replaceResumeExpressionEvidence(input: {
  expressionId: string;
  evidenceIds: string[];
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    const data = await provenanceFor(user.id).replaceExpressionEvidence({
      expressionId: requireId(input?.expressionId, "EXPRESSION_NOT_FOUND"),
      evidenceIds: requireIdList(input?.evidenceIds ?? []),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update evidence links.");
  }
}

export async function listResumeCareerMaterials(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    const rows = await materialsFor(user.id).list();
    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      evidence: (row.evidence ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
      })),
    }));
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to list career materials.");
  }
}
