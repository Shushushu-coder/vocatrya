import { AGENT_ROLES, type AgentRole } from "./agentRoles";
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
  badge: {
    insight: "agent.roles.insight.badge",
    pilot: "agent.roles.pilot.badge",
    reflect: "agent.roles.reflect.badge",
    general: "agent.roles.general.badge",
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
  "agent.roles.insight.name": { "zh-CN": "职业顾问", en: "Career Advisor" },
  "agent.roles.pilot.name": { "zh-CN": "执行助手", en: "Action Pilot" },
  "agent.roles.reflect.name": { "zh-CN": "复盘教练", en: "Reflection Coach" },
  "agent.roles.general.name": { "zh-CN": "通用", en: "General" },
  "agent.roles.insight.badge": { "zh-CN": "Insight", en: "Insight" },
  "agent.roles.pilot.badge": { "zh-CN": "Pilot", en: "Pilot" },
  "agent.roles.reflect.badge": { "zh-CN": "Reflect", en: "Reflect" },
  "agent.roles.general.badge": { "zh-CN": "", en: "" },
  "agent.roles.insight.subtitle": {
    "zh-CN": "职位与简历分析",
    en: "Job & resume analysis",
  },
  "agent.roles.pilot.subtitle": {
    "zh-CN": "职位记录、待办与扩展操作",
    en: "Job tracking, to-dos & actions",
  },
  "agent.roles.reflect.subtitle": {
    "zh-CN": "面试复盘与策略陪聊",
    en: "Interview reflection & strategy",
  },
  "agent.roles.general.subtitle": {
    "zh-CN": "通用助手",
    en: "General assistant",
  },
  "agent.roleSwitcher.label": { "zh-CN": "切换助手", en: "Switch assistant" },
  "agent.suggestRoleBetterFit": {
    "zh-CN": "这个问题 {name} 处理更合适。",
    en: "{name} is the better fit for this.",
  },
  "agent.suggestRoleCta": {
    "zh-CN": "带这个问题去问 {name}",
    en: "Take this to {name}",
  },
  "agent.roster.ask": {
    "zh-CN": "咨询 {name} —— {duty}",
    en: "Ask {name} — {duty}",
  },
  "agent.roster.legend": {
    "zh-CN": "一个对话自动调度：执行助手帮你做 · 职业顾问帮你看 · 复盘教练陪你聊",
    en: "One unified chat: Pilot acts · Insight analyzes · Reflect coaches — routed automatically",
  },
  "agent.roster.unifiedLead": {
    "zh-CN": "直接说出你想做的事，我会按你的意图自动安排最合适的助手来回应。",
    en: "Tell me what you need — I will route your request to the right specialist automatically.",
  },
  "agent.roster.unifiedHandoff": {
    "zh-CN": "先分析再行动也能在同一次回复里接力完成；写操作与待办都会先经你确认。",
    en: "Multi-step analysis and actions run seamlessly in one turn, with confirmation before any write.",
  },
  "agent.roster.insight.duty": {
    "zh-CN": "帮你看看职位要什么人、简历怎么改",
    en: "what the job wants, how to fix your resume",
  },
  "agent.roster.insight.selfLead": {
    "zh-CN": "我帮你看清楚：职位要什么人、简历怎么改、和你有多匹配。",
    en: "I read jobs and resumes and tell you how well they fit — match checks, resume reviews.",
  },
  "agent.roster.insight.selfHandoff": {
    "zh-CN": "需要记职位或更新待办时，执行助手会自动承接。",
    en: "When you need job or to-do writes, Pilot steps in automatically.",
  },
  "agent.roster.pilot.duty": {
    "zh-CN": "帮你记职位、管待办、执行操作，动手前先给你确认",
    en: "log jobs, manage to-dos, run actions — always confirms first",
  },
  "agent.roster.pilot.selfLead": {
    "zh-CN": "我帮你打理职位和待办：查、记、跟进，动数据前都先给你确认。",
    en: "I keep your jobs and to-dos in shape — look up, log, and always confirm before touching your data.",
  },
  "agent.roster.pilot.selfHandoff": {
    "zh-CN": "想分析匹配度或诊断简历时，职业顾问会自动接手。",
    en: "For match checks or resume reviews, Insight steps in automatically.",
  },
  "agent.roster.reflect.duty": {
    "zh-CN": "陪你聊聊面试、捋捋下一步",
    en: "talk through interviews and next steps",
  },
  "agent.roster.reflect.selfLead": {
    "zh-CN": "我陪你捋：面试聊得咋样、机会怎么选、下周干啥。",
    en: "I help you think it through — how the interview went, which offer to pick, what next.",
  },
  "agent.roster.reflect.selfHandoff": {
    "zh-CN": "需要记职位或深度分析时，对应助手会在同一对话里承接。",
    en: "When you need job writes or deep analysis, the right specialist steps in within the same thread.",
  },
};

/**
 * One roster entry per role. name/subtitle reuse the existing keys.
 * duty is the short spoken responsibility shared by the homepage entry
 * and the prompt awareness block. selfLead/selfHandoff are the empty
 * state's first-person form of that same entry. Icons name the header
 * switcher (Insight telescope, Pilot compass, Reflect chat) so refusal
 * copy can point at a real control. No extension or tool names live here.
 */
export const AGENT_ROSTER: Record<
  AgentRole,
  {
    nameKey: string;
    subtitleKey: string;
    dutyKey: string;
    selfLeadKey: string;
    selfHandoffKey: string;
    icon: "telescope" | "compass" | "chat";
  }
> = {
  insight: {
    nameKey: AGENT_ROLE_KEYS.name.insight,
    subtitleKey: AGENT_ROLE_KEYS.subtitle.insight,
    dutyKey: "agent.roster.insight.duty",
    selfLeadKey: "agent.roster.insight.selfLead",
    selfHandoffKey: "agent.roster.insight.selfHandoff",
    icon: "telescope",
  },
  pilot: {
    nameKey: AGENT_ROLE_KEYS.name.pilot,
    subtitleKey: AGENT_ROLE_KEYS.subtitle.pilot,
    dutyKey: "agent.roster.pilot.duty",
    selfLeadKey: "agent.roster.pilot.selfLead",
    selfHandoffKey: "agent.roster.pilot.selfHandoff",
    icon: "compass",
  },
  reflect: {
    nameKey: AGENT_ROLE_KEYS.name.reflect,
    subtitleKey: AGENT_ROLE_KEYS.subtitle.reflect,
    dutyKey: "agent.roster.reflect.duty",
    selfLeadKey: "agent.roster.reflect.selfLead",
    selfHandoffKey: "agent.roster.reflect.selfHandoff",
    icon: "chat",
  },
};

export const AGENT_ROSTER_ASK_KEY = "agent.roster.ask";
export const AGENT_ROSTER_LEGEND_KEY = "agent.roster.legend";

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

type RosterLocale = "zh-CN" | "en";

/** English/Chinese fallback for a roster key. Prompts read the English side. */
export function rosterFallback(key: string, locale: RosterLocale): string {
  const entry = AGENT_ROLE_FALLBACKS[key];
  return entry?.[locale] ?? key;
}

export function rosterDuty(role: AgentRole, locale: RosterLocale): string {
  return rosterFallback(AGENT_ROSTER[role].dutyKey, locale);
}

/** The other two roles, in header order. Not stored on the roster. */
export function rosterSiblings(role: AgentRole): AgentRole[] {
  return AGENT_ROLES.filter((item) => item !== role);
}

/** Homepage single line: 「咨询 Voca X —— 口头职责」. */
export function rosterAskLine(
  role: AgentRole,
  copy: (key: string) => string,
): string {
  const entry = AGENT_ROSTER[role];
  return copy(AGENT_ROSTER_ASK_KEY)
    .replaceAll("{name}", copy(entry.nameKey))
    .replaceAll("{duty}", copy(entry.dutyKey));
}

/** Empty-state self-intro, two lines, from the same roster entry as duty. */
export function rosterSelfLines(
  role: AgentRole,
  copy: (key: string) => string,
): { lead: string; handoff: string } {
  const entry = AGENT_ROSTER[role];
  return {
    lead: copy(entry.selfLeadKey),
    handoff: copy(entry.selfHandoffKey),
  };
}

/**
 * Awareness block for the current role. Sibling duties come from rosterDuty
 * so a roster edit reaches the prompt without a second copy.
 */
export function buildRoleAwarenessBlock(role: AgentRole): string {
  const siblingLines = rosterSiblings(role).map((sibling) => {
    const entry = AGENT_ROSTER[sibling];
    const name = rosterFallback(entry.nameKey, "en");
    return `${name} (the ${entry.icon} icon): ${rosterDuty(sibling, "en")}.`;
  });
  return [
    "You share this workspace with two sibling assistants. The user can reach either from the role icons at the top of this panel at any time. In order they are the telescope icon, the compass icon, and the chat icon.",
    siblingLines.join(" "),
    "Always answer the user's request as far as your own capabilities reach — never refuse outright. When the request clearly belongs to a sibling — a write or edit you do not perform, an analysis you do not run, or an extension capability this session did not register for you — give the best useful answer your own tools allow, then call suggest_role with that sibling's role and the user's request copied verbatim. The app turns that call into a handoff card that carries their request to that assistant in one tap. Never describe the request as impossible, broken, unconnected, or unavailable in this app, and never claim to have done work your tools cannot do.",
  ].join(" ");
}

/** One extra limitations sentence: the boundary, the handoff tool, and the header icon. */
export function roleHandoffHint(role: AgentRole): string {
  const name = (item: AgentRole) => rosterFallback(AGENT_ROSTER[item].nameKey, "en");
  const icon = (item: AgentRole) => AGENT_ROSTER[item].icon;
  const never =
    "Do not describe the request as impossible, broken, unconnected, or unavailable in this app.";
  if (role === "insight") {
    return `You can directly manage your own conversation's to-do list. Job writes and writes through a connected extension belong to ${name("pilot")} because of the role boundary. Answer what you can from what you can read; when such a job or extension write is what the user wants, call suggest_role with role "pilot" and their request copied verbatim — the card carries it to ${name("pilot")} — and you can also point to the ${icon("pilot")} icon at the top of this panel. ${never}`;
  }
  if (role === "pilot") {
    return `Resume reviews and match analysis belong to ${name("insight")} because of the role boundary. Answer what you can from the job data you can read; when the analysis itself is what they want, call suggest_role with role "insight" and their request copied verbatim — the card carries it to ${name("insight")} — and you can also point to the ${icon("insight")} icon at the top of this panel. ${never}`;
  }
  return `You can directly manage your own conversation's to-do list. Job writes and connected-extension writes belong to ${name("pilot")}: when the user clearly wants such a write, call suggest_role with role "pilot" and their request copied verbatim — the card carries it to ${name("pilot")} (the ${icon("pilot")} icon). Resume reviews and match analysis belong to ${name("insight")}: same handoff with role "insight" for ${name("insight")} (the ${icon("insight")} icon). Otherwise keep the conversation going and answer honestly. ${never}`;
}
