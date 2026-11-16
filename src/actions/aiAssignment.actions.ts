"use server";

import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  AssignmentWriteError,
  clearBusinessAssignment,
  listBusinessAssignmentsForUser,
  resolveBusinessAIConfig,
  setBusinessAssignment,
  type BusinessAssignmentSummary,
} from "@/lib/ai/assignments";

/**
 * Lists the user's business AI assignments with the bound connection's
 * display metadata — no credentials, no profile paths.
 */
export async function listBusinessAiAssignments(): Promise<{
  success: boolean;
  data?: BusinessAssignmentSummary[];
  message?: string;
}> {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: await listBusinessAssignmentsForUser(user.id),
    };
  } catch (error) {
    return handleError(error, "Failed to fetch AI assignments") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Saves a purpose → {connectionId, model} pair atomically. Ownership,
 * archive state, provider/backend pairing, and a non-empty model are all
 * validated server-side; a non-CONNECTED connection may still be assigned
 * (the resolver reports its state at execution time).
 *
 * INTERVIEW is accepted here like any other purpose — interview sessions
 * created afterwards lock onto the assigned connection/model and run on
 * the account runtime (TEXT_ONLY one-shot); existing sessions keep
 * whatever they were locked to at creation.
 */
export async function setBusinessAiAssignment(input: {
  purpose: string;
  connectionId: string;
  model: string;
}): Promise<{
  success: boolean;
  data?: BusinessAssignmentSummary;
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    const data = await setBusinessAssignment({
      userId: user.id,
      purpose: input?.purpose ?? "",
      connectionId: input?.connectionId ?? "",
      model: input?.model ?? "",
    });
    return { success: true, data };
  } catch (error) {
    if (error instanceof AssignmentWriteError) {
      return { success: false, code: error.code, message: error.message };
    }
    return handleError(error, "Failed to save AI assignment") as {
      success: boolean;
      message: string;
    };
  }
}

export async function clearBusinessAiAssignment(input: {
  purpose: string;
}): Promise<{
  success: boolean;
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    await clearBusinessAssignment({
      userId: user.id,
      purpose: input?.purpose ?? "",
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AssignmentWriteError) {
      return { success: false, code: error.code, message: error.message };
    }
    return handleError(error, "Failed to clear AI assignment") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Read-only resolution preview for the settings UI — reports what a purpose
 * would resolve to today (including the legacy interview coexistence state)
 * without executing anything.
 */
export async function resolveBusinessAiConfig(input: {
  purpose: string;
}): Promise<{
  success: boolean;
  data?: {
    status: string;
    source?: string;
    code?: string;
    provider?: string;
    model?: string;
    connectionId?: string;
  };
  message?: string;
}> {
  try {
    const user = await requireUser();
    const resolution = await resolveBusinessAIConfig({
      userId: user.id,
      purpose: input?.purpose ?? "",
    });
    switch (resolution.status) {
      case "RESOLVED":
        return {
          success: true,
          data: {
            status: "RESOLVED",
            source: resolution.source,
            provider: resolution.provider,
            model: resolution.model,
            connectionId: resolution.connectionId,
          },
        };
      case "INVALID_ASSIGNMENT":
        return {
          success: true,
          data: {
            status: "INVALID_ASSIGNMENT",
            source: resolution.source,
            code: resolution.code,
            connectionId: resolution.connectionId,
          },
        };
      case "LEGACY_INTERVIEW_CONFIG":
        return {
          success: true,
          data: {
            status: "LEGACY_INTERVIEW_CONFIG",
            provider: resolution.provider,
            model: resolution.model,
          },
        };
      default:
        return { success: true, data: { status: "NOT_CONFIGURED" } };
    }
  } catch (error) {
    return handleError(error, "Failed to resolve AI assignment") as {
      success: boolean;
      message: string;
    };
  }
}
