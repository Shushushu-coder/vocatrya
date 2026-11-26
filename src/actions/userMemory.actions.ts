"use server";
import { requireUser } from "./shared";
import { updateUserSettings } from "./userSettings.actions";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import {
  clearUserMemoryEntries,
  deleteUserMemoryEntry,
  listUserMemoryEntries,
  refreshManagedMemoryBlocksForUser,
  updateUserMemoryEntry,
  upsertUserMemoryEntry,
  UserMemoryConflictError,
  UserMemoryStoreFullError,
} from "@/lib/agent/longTermMemory.server";

type MemoryResult =
  | { success: true; message?: string }
  | { success: false; message: string };

function failure(error: unknown): MemoryResult {
  if (error instanceof UserMemoryConflictError) {
    return { success: false, message: "conflict" };
  }
  if (error instanceof UserMemoryStoreFullError) {
    return { success: false, message: "store_full" };
  }
  return {
    success: false,
    message: error instanceof Error ? error.message : "Memory operation failed",
  };
}

/**
 * M2.1: a user's own memory write is a named refresh event of the
 * session-frozen block — every managed-path conversation re-reads the
 * store so the next turn's prefix matches what the user just edited.
 * Best-effort: a missed refresh leaves a stale block, not a failed save.
 */
async function refreshSessionMemorySnapshots(userId: string): Promise<void> {
  await refreshManagedMemoryBlocksForUser(userId).catch(() => 0);
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
    await refreshSessionMemorySnapshots(user.id);
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
    await refreshSessionMemorySnapshots(user.id);
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

export async function removeUserMemoryEntry(input: { id: string }): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    const removed = await deleteUserMemoryEntry({ userId: user.id, id: input.id });
    if (removed) await refreshSessionMemorySnapshots(user.id);
    return removed ? { success: true } : { success: false, message: "not_found" };
  } catch (error) {
    return failure(error);
  }
}

export async function clearAllUserMemory(): Promise<MemoryResult> {
  const user = await requireUser();
  try {
    await clearUserMemoryEntries(user.id);
    await refreshSessionMemorySnapshots(user.id);
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
    if (result?.success === false) {
      return { success: false, message: result.message ?? "Save failed" };
    }
    await refreshSessionMemorySnapshots(user.id);
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}
