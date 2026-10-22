"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  UserSettingsData,
  defaultUserSettings,
  AiSettings,
  DisplaySettings,
  InterviewAiSettings,
} from "@/models/userSettings.model";
import {
  getInterviewConfig,
  normalizeInterviewInput,
} from "@/lib/interview/interviewSettings";
import {
  patchUserSettings,
  SETTINGS_CONFLICT,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";

// Structural adapter so the patch primitive never imports @/lib/db itself —
// the store is injected, keeping the CAS loop testable in isolation.
const userSettingsStore: UserSettingsStore = {
  findUnique: (args) => prisma.userSettings.findUnique(args),
  updateMany: (args) => prisma.userSettings.updateMany(args),
  create: (args) => prisma.userSettings.create(args),
};

export const getUserSettings = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: user.id },
    });

    if (!userSettings) {
      return {
        success: true,
        data: {
          userId: user.id,
          settings: defaultUserSettings,
        },
      };
    }

    const settings: UserSettingsData = JSON.parse(userSettings.settings);

    // Shallow merge: a legacy payload without `ai.interview` keeps parsing
    // and yields no interview config (no global/Ollama fallback). A payload
    // carrying `ai.interview` passes it through verbatim.
    const interview = getInterviewConfig(settings);
    const mergedAi: AiSettings = {
      ...defaultUserSettings.ai,
      ...settings.ai,
      ...(interview ? { interview } : { interview: undefined }),
    };
    if (!interview) {
      delete mergedAi.interview;
    }

    return {
      success: true,
      data: {
        userId: user.id,
        settings: {
          ...defaultUserSettings,
          ...settings,
          ai: mergedAi,
        },
      },
    };
  } catch (error) {
    const msg = "Failed to fetch user settings.";
    return handleError(error, msg);
  }
};

export const updateUserSettings = async (
  settings: Partial<UserSettingsData>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // Atomic CAS patch: re-reads and re-merges on conflict instead of
    // overwriting a concurrent writer's document with a stale snapshot.
    const result = await patchUserSettings(
      user.id,
      settings,
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

    return {
      success: true,
      data: {
        userId: user.id,
        settings: result.settings,
      },
    };
  } catch (error) {
    const msg = "Failed to update user settings.";
    return handleError(error, msg);
  }
};

export const updateAiSettings = async (
  aiSettings: AiSettings,
): Promise<any | undefined> => {
  return updateUserSettings({ ai: aiSettings });
};

/**
 * Phase 2: set (or replace) the independent interview provider/model pair.
 * Global AI settings are preserved. Validation rejects empty provider/model
 * without writing. Clearing uses `clearInterviewAiSettings()`.
 */
export const updateInterviewAiSettings = async (
  interview: InterviewAiSettings,
): Promise<any | undefined> => {
  const normalized = normalizeInterviewInput(interview);
  if (!normalized) {
    return {
      success: false,
      message: "Interview provider and model are both required.",
    };
  }
  return updateUserSettings({
    ai: { interview: normalized } as Partial<AiSettings> & {
      interview: InterviewAiSettings;
    } as AiSettings,
  });
};

/** Phase 2: clear the interview config; global AI settings are preserved. */
export const clearInterviewAiSettings = async (): Promise<any | undefined> => {
  return updateUserSettings({
    ai: { interview: undefined } as unknown as AiSettings,
  });
};

export const updateDisplaySettings = async (
  displaySettings: DisplaySettings,
): Promise<any | undefined> => {
  return updateUserSettings({ display: displaySettings });
};
