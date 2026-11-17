"use server";
import { requireUser } from "./shared";
import { updateUserSettings } from "./userSettings.actions";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import { validateAgentPreferences } from "@/lib/agent/preferences";

export async function getAgentPreferences() {
  const user = await requireUser();
  return loadAgentPreferences(user.id);
}
export async function saveAgentPreferences(value: unknown) {
  await requireUser();
  if (!validateAgentPreferences(value)) return { success: false, message: "Invalid Agent preferences" };
  return updateUserSettings({ settings: { general: { agent: value } } });
}
