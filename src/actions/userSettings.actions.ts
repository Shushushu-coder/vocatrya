"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  UserSettingsData,
  defaultUserSettings,
  AiSettings,
  DisplaySettings,
} from "@/models/userSettings.model";
import { getInterviewConfig } from "@/lib/interview/interviewSettings";
import {
  patchUserSettings,
  SETTINGS_CONFLICT,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";
import { isValidLocale, type Locale } from "@/i18n/config";
import { isSupportedTimeZone } from "@/lib/userSettings/timeZone";
import { isNotificationLeadMinutes } from "@/lib/reminders/shared";

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

export const updateDisplaySettings = async (
  displaySettings: DisplaySettings,
): Promise<any | undefined> => {
  return updateUserSettings({ display: displaySettings });
};

/**
 * SET-02 write entry: persist the account-level language preference at
 * `settings.general.locale` via the atomic patch path. The value is
 * validated at runtime so non-Locale inputs are honestly rejected before
 * any database write.
 */
export const updateSettingsLocale = async (
  locale: Locale,
): Promise<any | undefined> => {
  if (!isValidLocale(locale)) {
    return {
      success: false,
      message: "Locale must be zh-CN or en.",
    };
  }
  return updateUserSettings({ settings: { general: { locale } } });
};

/**
 * P-TZ write entry: persist the account-level IANA time zone at
 * `settings.general.timeZone` via the atomic patch path. Passing
 * `undefined` deletes the key — the account then follows the runtime
 * zone (no "system" literal is ever stored). Validation rejects
 * anything that is not an IANA Area/Location identifier or "UTC"
 * (see isSupportedTimeZone) before any write, so invalid input
 * leaves the stored value untouched.
 */
export const updateSettingsTimeZone = async (
  timeZone: string | undefined,
): Promise<any | undefined> => {
  if (timeZone !== undefined && !isSupportedTimeZone(timeZone)) {
    return {
      success: false,
      message: "Time zone must be a valid IANA time zone.",
    };
  }
  return updateUserSettings({ settings: { general: { timeZone } } });
};

/**
 * REM-V1 write entry: persist notification preferences at
 * `settings.notifications.*` via the same atomic patch path. Only the two
 * supported keys are writable and both are validated before any write, so a
 * bad input leaves the stored document untouched.
 */
export const updateNotificationSettings = async (input: {
  enabled?: boolean;
  leadMinutes?: number;
}): Promise<any | undefined> => {
  const notifications: { enabled?: boolean; leadMinutes?: number } = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      return {
        success: false,
        message: "Notification switch must be a boolean.",
      };
    }
    notifications.enabled = input.enabled;
  }
  if (input.leadMinutes !== undefined) {
    if (!isNotificationLeadMinutes(input.leadMinutes)) {
      return {
        success: false,
        message: "Lead time must be one of the supported minute presets.",
      };
    }
    notifications.leadMinutes = input.leadMinutes;
  }
  return updateUserSettings({ settings: { notifications } });
};
