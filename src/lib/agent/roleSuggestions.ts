import { normalizeAgentRole, type AgentRole } from "./agentRoles";

/**
 * Per-role suggestion keys — four static items each, resolved through
 * copyFor(t, locale) so a missing messages entry falls back to the strings
 * below. Clicking a suggestion only fills the composer: no /api/ai/chat
 * request, no conversation creation, no model call (D8). `fill` defaults
 * to the label when absent; the add-job suggestion deliberately fills an
 * open-ended prompt instead of a canned exchange.
 */
export type RoleSuggestion = {
  label: string;
  fill?: string;
};

export const AGENT_SUGGESTION_FALLBACKS: Record<
  string,
  { "zh-CN": string; en: string }
> = {
  // Insight — analyst. D5: the match item reads 运行匹配分析 under the
  // canonical runtime; the legacy runtime keeps the old free-running
  // semantics and gets the older wording instead.
  "agent.suggest.insight.match": {
    "zh-CN": "运行匹配分析",
    en: "Run match analysis",
  },
  "agent.suggest.insight.matchLegacy": {
    "zh-CN": "看看我和这个职位的匹配度",
    en: "Check my match for this job",
  },
  "agent.suggest.insight.review": {
    "zh-CN": "评审我的简历",
    en: "Review my resume",
  },
  "agent.suggest.insight.job": {
    "zh-CN": "总结这个职位的要求",
    en: "Summarize this job's requirements",
  },
  "agent.suggest.insight.chat": {
    "zh-CN": "聊聊我的求职方向",
    en: "Help me think through my job search",
  },
  // Pilot — workbench. The add-job item fills an instructional prompt so
  // the user continues with the posting text — never a canned exchange.
  "agent.suggest.pilot.add": {
    "zh-CN": "添加一个职位",
    en: "Add a job",
  },
  "agent.suggest.pilot.addFill": {
    "zh-CN": "帮我把这条招聘帖加入我的职位：",
    en: "Add this job posting to my jobs: ",
  },
  "agent.suggest.pilot.list": {
    "zh-CN": "我有哪些进行中的职位？",
    en: "List my saved jobs",
  },
  "agent.suggest.pilot.job": {
    "zh-CN": "这个职位的关键信息是什么？",
    en: "What are this job's key details?",
  },
  "agent.suggest.pilot.chat": {
    "zh-CN": "帮我理一下这周要投哪些职位",
    en: "Help me prioritize this week's applications",
  },
  // Reflect — honest dialogue coach. No capability item pretends a saved
  // reflection or review can be read back.
  "agent.suggest.reflect.interview": {
    "zh-CN": "聊聊这次面试的表现",
    en: "Talk through how that interview went",
  },
  "agent.suggest.reflect.weigh": {
    "zh-CN": "几个机会之间怎么权衡",
    en: "Help me weigh my options",
  },
  "agent.suggest.reflect.job": {
    "zh-CN": "这个职位值得继续跟吗？",
    en: "Is this job worth pursuing?",
  },
  "agent.suggest.reflect.chat": {
    "zh-CN": "理一理这周求职的进展",
    en: "Help me review this week's progress",
  },
};

export function suggestionsForRole(
  role: AgentRole | null | undefined,
  options?: { freshNativeFull?: boolean },
): RoleSuggestion[] {
  const resolved = normalizeAgentRole(role) ?? "pilot";
  if (resolved === "insight") {
    return [
      {
        label: options?.freshNativeFull
          ? "agent.suggest.insight.match"
          : "agent.suggest.insight.matchLegacy",
      },
      { label: "agent.suggest.insight.review" },
      { label: "agent.suggest.insight.job" },
      { label: "agent.suggest.insight.chat" },
    ];
  }
  if (resolved === "pilot") {
    return [
      {
        label: "agent.suggest.pilot.add",
        fill: "agent.suggest.pilot.addFill",
      },
      { label: "agent.suggest.pilot.list" },
      { label: "agent.suggest.pilot.job" },
      { label: "agent.suggest.pilot.chat" },
    ];
  }
  return [
    { label: "agent.suggest.reflect.interview" },
    { label: "agent.suggest.reflect.weigh" },
    { label: "agent.suggest.reflect.job" },
    { label: "agent.suggest.reflect.chat" },
  ];
}
