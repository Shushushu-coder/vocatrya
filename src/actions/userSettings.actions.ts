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
  mergeAiSettingsForUpdate,
  normalizeInterviewInput,
} from "@/lib/interview/interviewSettings";

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

    const existingSettings = await prisma.userSettings.findUnique({
      where: { userId: user.id },
    });

    let mergedSettings: UserSettingsData;

    if (existingSettings) {
      const currentSettings: UserSettingsData = JSON.parse(
        existingSettings.settings,
      );
      const currentAi: AiSettings = {
        ...defaultUserSettings.ai,
        ...currentSettings.ai,
      };
      const updateHasInterviewKey =
        settings.ai !== undefined &&
        Object.prototype.hasOwnProperty.call(settings.ai, "interview");
      const mergedAi = mergeAiSettingsForUpdate(
        currentAi,
        (settings.ai ?? {}) as Partial<AiSettings> & {
          interview?: InterviewAiSettings | undefined;
        },
        updateHasInterviewKey,
      );
      mergedSettings = {
        ...defaultUserSettings,
        ...currentSettings,
        ...settings,
        ai: mergedAi,
        display: {
          ...defaultUserSettings.display,
          ...currentSettings.display,
          ...settings.display,
        },
      };
    } else {
      const updateHasInterviewKey =
        settings.ai !== undefined &&
        Object.prototype.hasOwnProperty.call(settings.ai, "interview");
      const mergedAi = mergeAiSettingsForUpdate(
        { ...defaultUserSettings.ai },
        (settings.ai ?? {}) as Partial<AiSettings> & {
          interview?: InterviewAiSettings | undefined;
        },
        updateHasInterviewKey,
      );
      mergedSettings = {
        ...defaultUserSettings,
        ...settings,
        ai: mergedAi,
        display: { ...defaultUserSettings.display, ...settings.display },
      };
    }

    const userSettings = await prisma.userSettings.upsert({
      where: { userId: user.id },
      update: {
        settings: JSON.stringify(mergedSettings),
      },
      create: {
        userId: user.id,
        settings: JSON.stringify(mergedSettings),
      },
    });

    const parsedSettings: UserSettingsData = JSON.parse(userSettings.settings);

    return {
      success: true,
      data: {
        userId: user.id,
        settings: parsedSettings,
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
