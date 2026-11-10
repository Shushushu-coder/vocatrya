import type { AgentRole } from "./agentRoles";
import { AGENT_SUGGESTION_FALLBACKS } from "./roleSuggestions";

/**
 * Multi-agent copy. The i18n keys land in src/i18n/messages through the
 * Main integration owner — this module carries the same strings as a
 * built-in fallback so a missing key never renders raw key text. Look up
 * via roleCopy(t)(key): the translated value wins when the key exists, the
 * fallback when t() returned the key itself.
 */
export const AGENT_ROLE_KEYS = {
  name: {
    insight: "agent.roles.insight.name",
    pilot: "agent.roles.pilot.name",
    reflect: "agent.roles.reflect.name",
    general: "agent.roles.general.name",
  },
  subtitle: {
    insight: "agent.roles.insight.subtitle",
    pilot: "agent.roles.pilot.subtitle",
    reflect: "agent.roles.reflect.subtitle",
    general: "agent.roles.general.subtitle",
  },
  switcherLabel: "agent.roleSwitcher.label",
} as const;

export const AGENT_ROLE_FALLBACKS: Record<string, { "zh-CN": string; en: string }> = {
  "agent.roles.insight.name": { "zh-CN": "Voca Insight", en: "Voca Insight" },
  "agent.roles.pilot.name": { "zh-CN": "Voca Pilot", en: "Voca Pilot" },
  "agent.roles.reflect.name": { "zh-CN": "Voca Reflect", en: "Voca Reflect" },
  "agent.roles.general.name": { "zh-CN": "通用", en: "General" },
  "agent.roles.insight.subtitle": {
    "zh-CN": "求职分析师",
    en: "Job analyst",
  },
  "agent.roles.pilot.subtitle": {
    "zh-CN": "工作台助手",
    en: "Workspace assistant",
  },
  "agent.roles.reflect.subtitle": {
    "zh-CN": "对话教练",
    en: "Conversation coach",
  },
  "agent.roles.general.subtitle": {
    "zh-CN": "通用助手",
    en: "General assistant",
  },
  "agent.roleSwitcher.label": { "zh-CN": "切换助手", en: "Switch assistant" },
};

type T = (key: string) => string;

const FALLBACKS = { ...AGENT_ROLE_FALLBACKS, ...AGENT_SUGGESTION_FALLBACKS };

/** t() wins when the key exists; otherwise the zh/en fallback string. */
export function copyFor(t: T, locale: string) {
  return (key: string): string => {
    const translated = t(key);
    if (translated && translated !== key) return translated;
    const entry = FALLBACKS[key];
    return entry?.[locale === "en" ? "en" : "zh-CN"] ?? key;
  };
}

/** Role display name — NULL rows show 通用. */
export function roleNameKey(role: AgentRole | null): string {
  return role ? AGENT_ROLE_KEYS.name[role] : AGENT_ROLE_KEYS.name.general;
}

export function roleSubtitleKey(role: AgentRole | null): string {
  return role ? AGENT_ROLE_KEYS.subtitle[role] : AGENT_ROLE_KEYS.subtitle.general;
}
