"use server";
import { requireUser } from "./shared";
import { updateUserSettings } from "./userSettings.actions";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import {
  clearUserMemoryEntries,
  deleteUserMemoryEntry,
  listUserMemoryEntries,
  updateUserMemoryEntry,
  upsertUserMemoryEntry,
  UserMemoryConflictError,
} from "@/lib/agent/longTermMemory.server";

type MemoryResult =
  | { success: true; message?: string }
  | { success: false; message: string };

function failure(error: unknown): MemoryResult {
  if (error instanceof UserMemoryConflictError) {
    return { success: false, message: "conflict" };
  }
  return {
    success: false,
    message: error instanceof Error ? error.message : "Memory operation failed",
  };
}

export async function getUserMemoryEntries() {
  const user = await requireUser();
  return listUserMemoryEntries(user.id);
}

export async function saveUserMemoryEntry(input: {
  category: string;
  key: string;
  content: string;
}): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    await upsertUserMemoryEntry({ userId: user.id, ...input });
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

export async function editUserMemoryEntry(input: {
  id: string;
  category?: string;
  key?: string;
  content?: string;
}): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    await updateUserMemoryEntry({ userId: user.id, ...input });
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

export async function removeUserMemoryEntry(input: { id: string }): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    const removed = await deleteUserMemoryEntry({ userId: user.id, id: input.id });
    return removed ? { success: true } : { success: false, message: "not_found" };
  } catch (error) {
    return failure(error);
  }
}

export async function clearAllUserMemory(): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    await clearUserMemoryEntries(user.id);
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Master switch write. Merges over the current agent document inside the
 * same CAS-merged settings tree so a toggle can never clobber sibling
 * preferences another tab just saved.
 */
export async function setLongTermMemoryEnabled(enabled: boolean): Promise<MemoryResult> {
  const user = await requireUser();
  if (typeof enabled !== "boolean") {
    return { success: false, message: "Invalid value" };
  }
  try {
    const preferences = await loadAgentPreferences(user.id);
    const result = await updateUserSettings({
      settings: {
        general: {
          agent: { ...preferences, longTermMemoryEnabled: enabled },
        },
      },
    });
    return result?.success === false
      ? { success: false, message: result.message ?? "Save failed" }
      : { success: true };
  } catch (error) {
    return failure(error);
  }
}
