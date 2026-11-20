"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import { assertCareerDataWritable } from "@/lib/career/access";
import {
  ResumeEvidenceSaveError,
  buildResumeEvidenceSavePlan,
  previewResumeEvidenceSavePlan,
  saveResumeEvidencePlan,
  type ResumeEvidenceSavePreview,
} from "@/lib/career/resumeEvidenceSave";
import type { ActionResult } from "@/models/action.model";

// User-initiated UI save for a Resume Evidence draft (D4/D5/D7). This is a
// server action behind a button, not a model tool: it is not registered with
// the agent and Pilot's tool whitelist is untouched. The draft is re-validated
// here on every call.

const APPLICATION_PATH = "/dashboard/profile/application";

export type ResumeEvidenceSaveFailure = {
  success: false;
  message: string;
  code?: string;
  /** Draft detail field to fix (invalid_detail). */
  field?: string;
};
type SaveResult<T> = Extract<ActionResult<T>, { success: true }> | ResumeEvidenceSaveFailure;

function fail(error: unknown, fallback: string): ResumeEvidenceSaveFailure {
  if (error instanceof ResumeEvidenceSaveError) {
    return {
      success: false,
      message: error.message,
      code: error.code,
      field: error.field,
    };
  }
  return handleError(error, fallback) as ResumeEvidenceSaveFailure;
}

export async function previewResumeEvidenceSave(
  draft: unknown,
): Promise<SaveResult<ResumeEvidenceSavePreview>> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const plan = buildResumeEvidenceSavePlan(draft);
    return {
      success: true,
      data: await previewResumeEvidenceSavePlan(prisma as never, user.id, plan),
    };
  } catch (error) {
    return fail(error, "Failed to preview save.");
  }
}

export async function confirmResumeEvidenceSave(
  draft: unknown,
  previewDigest: string,
): Promise<
  SaveResult<{ materialId: string; evidenceCount: number; alreadySaved: boolean }>
> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    const plan = buildResumeEvidenceSavePlan(draft);
    // The digest check runs inside the write transaction (it covers the
    // resolved field changes), so a stale preview writes nothing.
    const result = await saveResumeEvidencePlan(prisma as never, user.id, plan, {
      expectedDigest: previewDigest,
    });
    if (!result.alreadySaved) revalidatePath(APPLICATION_PATH);
    return {
      success: true,
      data: {
        materialId: result.materialId,
        evidenceCount: result.evidenceIds.length,
        alreadySaved: result.alreadySaved,
      },
    };
  } catch (error) {
    return fail(error, "Failed to save to career materials.");
  }
}
