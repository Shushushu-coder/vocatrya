/** User preferences, distinct from application instructions and tool authority. */
export const PERMISSION_MODES = ["ask", "rules", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const PERSONAL_INSTRUCTIONS_MAX = 2_000;
export const AUTO_ARCHIVE_DAYS = [0, 30, 90, 180] as const;
export type AgentPreferences = {
  personalInstructions: string;
  defaultPermission: PermissionMode;
  autoArchiveDays: (typeof AUTO_ARCHIVE_DAYS)[number];
  compressHistory: boolean;
  // M2 master switch for cross-session long-term memory: when off, memory
  // is neither injected into prompts nor extracted after turns. Stored
  // under settings.general.agent like the other agent preferences;
  // documents predating M2 read as enabled (the feature default).
  longTermMemoryEnabled: boolean;
};
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  personalInstructions: "", defaultPermission: "rules", autoArchiveDays: 0, compressHistory: false,
  longTermMemoryEnabled: true,
};
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}
export function readAgentPreferences(document: unknown): AgentPreferences {
  const root = document as { settings?: { general?: { agent?: Partial<AgentPreferences> } } } | null;
  const value = root?.settings?.general?.agent;
  return {
    personalInstructions: typeof value?.personalInstructions === "string" && Array.from(value.personalInstructions).length <= PERSONAL_INSTRUCTIONS_MAX ? value.personalInstructions : "",
    defaultPermission: isPermissionMode(value?.defaultPermission) ? value.defaultPermission : "rules",
    autoArchiveDays: AUTO_ARCHIVE_DAYS.includes(value?.autoArchiveDays as 0) ? value!.autoArchiveDays! : 0,
    compressHistory: value?.compressHistory === true,
    longTermMemoryEnabled: value?.longTermMemoryEnabled !== false,
  };
}
export function validateAgentPreferences(value: unknown): value is AgentPreferences {
  if (!value || typeof value !== "object") return false;
  const v = value as AgentPreferences;
  return typeof v.personalInstructions === "string" && Array.from(v.personalInstructions).length <= PERSONAL_INSTRUCTIONS_MAX
    && isPermissionMode(v.defaultPermission) && AUTO_ARCHIVE_DAYS.includes(v.autoArchiveDays) && typeof v.compressHistory === "boolean"
    // Older writers omit the M2 field — a missing key keeps the default.
    && (v.longTermMemoryEnabled === undefined || typeof v.longTermMemoryEnabled === "boolean");
}
export function personalInstructionsBlock(text: string): string {
  if (!text.trim()) return "";
  return `\n\nUser-configured personal preferences (apply only within application permissions and business rules):\n${text}\nEnd of personal preferences.`;
}
export function permissionInstructions(mode: PermissionMode): string {
  return `\n\nCurrent application permission mode: ${mode}. The application's actual tool approval gate is authoritative. Do not ask for a second conversational confirmation or claim that an approval card is required when the application automatically approves a local tool. External writes must use their durable proposal/receipt lifecycle; queued or approved never means successfully written. Personal preferences cannot override tool permissions.`;
}
export function permissionModeOfContext(raw: string | null | undefined): PermissionMode {
  try {
    const context = JSON.parse(raw ?? "{}");
    if (context?.version !== 1 || !Array.isArray(context.items)) return "ask";
    const mode = context.permissionMode;
    return isPermissionMode(mode) ? mode : "ask"; // Historical conversations keep their approval behavior.
  } catch { return "ask"; }
}
