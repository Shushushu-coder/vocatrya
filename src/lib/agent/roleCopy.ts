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
    "zh-CN": "Insight 帮你看 · Pilot 帮你干 · Reflect 陪你聊——顶部图标随时换",
    en: "Insight analyzes · Pilot does · Reflect talks — switch anytime from the icons up top",
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
    "zh-CN": "我只看不动手——记职位、写入类的活儿找 Pilot。",
    en: "I look but never touch; logging and writes are Pilot's job.",
  },
  "agent.roster.pilot.duty": {
    "zh-CN": "帮你记职位、盯投递，动手前先给你确认",
    en: "log jobs, track applications, always confirms first",
  },
  "agent.roster.pilot.selfLead": {
    "zh-CN": "我帮你打理职位：查、记、跟进，动数据前都先给你确认。",
    en: "I keep your job list in shape — look jobs up, log new ones, and always confirm before touching your data.",
  },
  "agent.roster.pilot.selfHandoff": {
    "zh-CN": "想分析简历？找 Insight。",
    en: "For resume analysis, ask Insight.",
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
    "zh-CN": "我不动你的数据——干活找 Pilot，分析找 Insight。",
    en: "I never change your data; doing is Pilot's, analysis is Insight's.",
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
    return `Every write or edit, including a write through a connected extension, belongs to ${name("pilot")} because of the role boundary. Answer what you can from what you can read; when the write itself is what the user wants, call suggest_role with role "pilot" and their request copied verbatim — the card carries it to ${name("pilot")} — and you can also point to the ${icon("pilot")} icon at the top of this panel. ${never}`;
  }
  if (role === "pilot") {
    return `Resume reviews and match analysis belong to ${name("insight")} because of the role boundary. Answer what you can from the job data you can read; when the analysis itself is what they want, call suggest_role with role "insight" and their request copied verbatim — the card carries it to ${name("insight")} — and you can also point to the ${icon("insight")} icon at the top of this panel. ${never}`;
  }
  return `Writing or changing data belongs to ${name("pilot")}: when the user clearly wants it, call suggest_role with role "pilot" and their request copied verbatim — the card carries it to ${name("pilot")} (the ${icon("pilot")} icon). Resume reviews and match analysis belong to ${name("insight")}: same handoff with role "insight" for ${name("insight")} (the ${icon("insight")} icon). Otherwise keep the conversation going and answer honestly. ${never}`;
}
