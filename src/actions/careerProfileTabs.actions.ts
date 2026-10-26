"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  assertCareerDataReadable,
  assertCareerDataWritable,
} from "@/lib/career/access";
import {
  parseSettingsDocument,
  patchUserSettings,
  SETTINGS_CONFLICT,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";
import {
  isCareerProfileTabId,
  normalizeTabVisibility,
  type CareerProfileTabVisibility,
} from "@/components/career/application-profile/careerProfileTabs";
import type { ActionResult } from "@/models/action.model";

// Structural adapter so the patch primitive never imports @/lib/db itself —
// identical contract to the one in userSettings.actions.ts.
const userSettingsStore: UserSettingsStore = {
  findUnique: (args) => prisma.userSettings.findUnique(args),
  updateMany: (args) => prisma.userSettings.updateMany(args),
  create: (args) => prisma.userSettings.create(args),
};

function persistedTabVisibility(
  doc: Record<string, unknown>,
): CareerProfileTabVisibility {
  const careerProfile = doc.careerProfile;
  const raw =
    careerProfile !== null && typeof careerProfile === "object"
      ? (careerProfile as Record<string, unknown>).tabVisibility
      : undefined;
  return normalizeTabVisibility(raw);
}

/**
 * CP-UI: read the user's tab-visibility preference for the career profile
 * workspace. Missing or malformed payloads resolve to "all seven tabs
 * visible", the contract default.
 */
export async function getCareerProfileTabVisibility(): Promise<
  ActionResult<CareerProfileTabVisibility>
> {
  try {
    const user = await requireUser();
    await assertCareerDataReadable(prisma as never);
    const row = await prisma.userSettings.findUnique({
      where: { userId: user.id },
      select: { settings: true },
    });
    const doc = parseSettingsDocument(row?.settings);
    return { success: true, data: persistedTabVisibility(doc) };
  } catch (error) {
    return handleError(error, "Failed to load tab settings.");
  }
}

/**
 * CP-UI: persist one tab's visibility through the atomic CAS patch path.
 * The patch only touches `careerProfile.tabVisibility.<tabId>`; sibling
 * keys and other namespaces are preserved by the deep-merge contract.
 * Returns the full normalized visibility so the client can converge on
 * exactly what was stored.
 */
export async function setCareerProfileTabVisible(input: {
  tabId: string;
  visible: boolean;
}): Promise<ActionResult<CareerProfileTabVisibility>> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    if (
      !isCareerProfileTabId(input?.tabId) ||
      typeof input?.visible !== "boolean"
    ) {
      return { success: false, message: "Invalid tab visibility." };
    }
    const result = await patchUserSettings(
      user.id,
      { careerProfile: { tabVisibility: { [input.tabId]: input.visible } } },
      userSettingsStore,
    );
    if (!result.success) {
      return {
        success: false,
        code: result.code,
        message:
          result.code === SETTINGS_CONFLICT
            ? "Settings changed while saving. Please retry."
            : result.message,
      };
    }
    return { success: true, data: persistedTabVisibility(result.settings) };
  } catch (error) {
    return handleError(error, "Failed to save tab settings.");
  }
}
