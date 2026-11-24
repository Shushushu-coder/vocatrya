/**
 * Deterministic Career Dialogue router.
 *
 * No model call. A false FAST_CHAT (a tool request answered with no tool)
 * is the failure this table is built to avoid. A false AGENT only costs
 * the existing structured-decision turn.
 *
 * Page context and prior tool results do not force AGENT. The latest user
 * utterance does. Approval continuations are AGENT because they resume a
 * tool the model already proposed.
 */

export type CareerDialogueRoute = "FAST_CHAT" | "AGENT";

export type CareerDialogueRouteReason =
  | "GREETING"
  | "GENERAL_EXPLANATION"
  | "REFLECTION"
  | "FOLLOWUP_CLARIFICATION"
  | "EXPLICIT_TOOL_INTENT"
  | "JOB_DATA_INTENT"
  | "RESUME_DATA_INTENT"
  | "WRITE_ACTION_INTENT"
  | "AMBIGUOUS"
  | "APPROVAL_CONTINUATION";

export type CareerDialogueRouteDecision = {
  route: CareerDialogueRoute;
  reason: CareerDialogueRouteReason;
};

export type CareerDialogueRouteMessage = {
  role?: string;
  parts?: Array<{
    type?: string;
    text?: string;
    state?: string;
  }>;
};

export type CareerDialogueRouteInput = {
  messages: CareerDialogueRouteMessage[];
  /**
   * Accepted so callers can pass the turn's page context without a second
   * code path. Routing ignores it: a context chip is not a tool request.
   */
  pageContext?: unknown;
};

const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "你好",
  "您好",
  "谢谢",
  "谢谢你",
  "感谢",
  "thanks",
  "thank you",
  "你是什么模型",
  "你是哪个模型",
  "what model are you",
  "which model are you",
  "who are you",
  "你是谁",
]);

const FOLLOWUPS = new Set([
  "为什么",
  "为何",
  "why",
  "举个例子",
  "举一个例子",
  "给个例子",
  "for example",
  "give me an example",
  "再详细一点",
  "详细一点",
  "more detail",
  "more details",
  "我没明白",
  "我没听懂",
  "没明白",
  "i don't understand",
  "i did not understand",
  "换一种说法",
  "换个说法",
  "say it differently",
  "rephrase",
  "rephrase that",
  "总结一下",
  "总结一下刚才的建议",
  "summarize",
  "summarize that",
  "can you explain that again",
  "explain that again",
  "解释一下",
  "再解释一下",
  "你能再解释清楚一点吗",
  "can you explain that",
]);

// Requests to execute a product write now. Checked before softer data reads.
const WRITE_PATTERNS: RegExp[] = [
  /帮我.{0,16}(添加|保存|加到|加入|修改|写入|创建)/,
  /请.{0,6}(添加|保存|修改|创建)(这个|该|此)?(职位|岗位)/,
  /(添加|保存)(这个|该|此)(职位|岗位)/,
  /把这个(职位|岗位).{0,12}(加入|保存|添加)/,
  /加入我的(职位|岗位)/,
  /加到(我的)?(职位|岗位)/,
  /(修改|更新|改一下)我的简历/,
  /\b(add|save)\s+(this|the|that)\s+job\b/,
  /\bplease\s+(add|save)\b/,
];

const RESUME_PATTERNS: RegExp[] = [
  /查看我的简历/,
  /看一下我的简历/,
  /看看我的简历/,
  /给我看我的简历/,
  /分析我的(当前)?简历/,
  /点评我的简历/,
  /审核我的简历/,
  /基于我的简历/,
  /根据我的简历/,
  /我的(当前)?简历/,
  /\b(show me|review|read|open|analyze|analyse)\s+my\s+resume\b/,
  /\bmy resume\b/,
];

const JOB_OR_TOOL_PATTERNS: Array<{ pattern: RegExp; reason: CareerDialogueRouteReason }> = [
  { pattern: /今天(该|要|应该)?做什么|今日(计划|清单|待办)|今天.*(清单|待办)|把.+(移到明天|移入今天)/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /\b(what should i do today|how should i plan today|today.s (plan|checklist)|to[ -]?do list)\b/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /查看我保存的(职位|岗位)/, reason: "JOB_DATA_INTENT" },
  { pattern: /我保存的(职位|岗位)/, reason: "JOB_DATA_INTENT" },
  { pattern: /\b(show|list|open)\s+my\s+saved\s+jobs?\b/, reason: "JOB_DATA_INTENT" },
  { pattern: /\bmy saved jobs?\b/, reason: "JOB_DATA_INTENT" },
  { pattern: /\bthis saved job\b/, reason: "JOB_DATA_INTENT" },
  { pattern: /这个(岗位|职位)的(要求|描述|内容|职责)/, reason: "JOB_DATA_INTENT" },
  { pattern: /我的经历是否适合/, reason: "JOB_DATA_INTENT" },
  { pattern: /分析我和这个(岗位|职位)/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /匹配(这个|我和|度)/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /\bmatch me\b/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /\bmatch (this|the) (job|jd)\b/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /根据这个(职位|岗位).{0,8}(写|生成)/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /给这个.{0,16}(写|生成).{0,16}(求职信|cover letter)/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /(写|生成).{0,8}求职信/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /\b(generate|write)\s+a\s+cover\s+letter\b/, reason: "EXPLICIT_TOOL_INTENT" },
  { pattern: /\bcover\s+letter\s+for\b/, reason: "EXPLICIT_TOOL_INTENT" },
];

// "不要真的保存" / "如果我要保存，该怎么操作" — talk about an action,
// do not ask for one. These override a later action phrase. An action
// phrase that appears first still wins ("帮我保存，顺便解释一下").
const NEGATION_OR_HOWTO: RegExp[] = [
  /不要真的/,
  /别真的/,
  /我只是想知道/,
  /只是想了解/,
  /不是要你/,
  /不是让你/,
  /don'?t actually/,
  /do not actually/,
  /i (just|only) want to know/,
  /如果我要/,
  /假如我/,
  /要是我/,
  /if i (want|wanted|were) to/,
  /该怎么操作/,
  /怎么操作/,
  /如何操作/,
  /how (?:do|would|can) i /,
];

const REFLECTION_PATTERNS: RegExp[] = [
  /我应该怎么/,
  /我应该如何/,
  /这句话听起来/,
  /怎么准备/,
  /如何准备/,
  /how should i prepare/,
  /how should (?:a |an )?(?:student|i)\b/,
];

const EXPLANATION_PATTERNS: RegExp[] = [
  /^什么是/,
  /^what is\b/,
  /^what are\b/,
  /behavioral interview/,
  /行为面试/,
  /解释一下/,
  /explain (that|this|it|again)/,
  /what does /,
  /是什么意思/,
  /什么意思/,
  /what is the meaning/,
];

function canonical(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/["“”「」『』'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[?？!！.。,，~～]+$/g, "")
    .trim();
}

function earliest(text: string, patterns: RegExp[]): number {
  let found = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;
    if (found === -1 || match.index < found) found = match.index;
  }
  return found;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function latestUserText(messages: CareerDialogueRouteMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return (message.parts ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isApprovalContinuation(messages: CareerDialogueRouteMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return (last.parts ?? []).some(
    (part) =>
      part.state === "approval-responded" &&
      typeof part.type === "string" &&
      part.type.startsWith("tool-"),
  );
}

function agent(reason: CareerDialogueRouteReason): CareerDialogueRouteDecision {
  return { route: "AGENT", reason };
}

function fast(reason: CareerDialogueRouteReason): CareerDialogueRouteDecision {
  return { route: "FAST_CHAT", reason };
}

export function routeCareerDialogueTurn(
  input: CareerDialogueRouteInput,
): CareerDialogueRouteDecision {
  if (isApprovalContinuation(input.messages)) {
    return agent("APPROVAL_CONTINUATION");
  }

  const text = canonical(latestUserText(input.messages));
  if (!text) return agent("AMBIGUOUS");

  const negationAt = earliest(text, NEGATION_OR_HOWTO);
  const writeAt = earliest(text, WRITE_PATTERNS);
  const resumeAt = earliest(text, RESUME_PATTERNS);
  let toolAt = -1;
  let toolReason: CareerDialogueRouteReason = "EXPLICIT_TOOL_INTENT";
  for (const entry of JOB_OR_TOOL_PATTERNS) {
    const match = entry.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    if (toolAt === -1 || match.index < toolAt) {
      toolAt = match.index;
      toolReason = entry.reason;
    }
  }
  const actionAt = [writeAt, resumeAt, toolAt]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;

  // How-to / "don't actually" beats an action phrase that follows it.
  // An action phrase that leads the utterance stays on the agent path.
  if (negationAt >= 0 && (actionAt < 0 || negationAt < actionAt)) {
    return fast("GENERAL_EXPLANATION");
  }

  if (writeAt >= 0 && (actionAt < 0 || writeAt === actionAt)) {
    return agent("WRITE_ACTION_INTENT");
  }
  if (resumeAt >= 0 && resumeAt === actionAt) {
    return agent("RESUME_DATA_INTENT");
  }
  if (toolAt >= 0 && toolAt === actionAt) {
    return agent(toolReason);
  }

  if (GREETINGS.has(text)) return fast("GREETING");
  if (FOLLOWUPS.has(text)) return fast("FOLLOWUP_CLARIFICATION");
  if (/^为什么/.test(text) && text.length <= 24) {
    return fast("FOLLOWUP_CLARIFICATION");
  }
  if (/^why\b/.test(text) && text.length <= 40) {
    return fast("FOLLOWUP_CLARIFICATION");
  }

  if (matchesAny(text, REFLECTION_PATTERNS)) return fast("REFLECTION");
  if (matchesAny(text, EXPLANATION_PATTERNS)) return fast("GENERAL_EXPLANATION");

  return agent("AMBIGUOUS");
}

export function careerDialogueObservabilityFields(input: {
  decision: CareerDialogueRouteDecision;
  routerDurationMs: number;
  conversationId: string;
  connectionId: string;
  model: string | null;
}): Record<string, string | number | null> {
  return {
    route: input.decision.route,
    reasonCode: input.decision.reason,
    routerDurationMs: Math.round(input.routerDurationMs * 1000) / 1000,
    conversationId: input.conversationId,
    connectionId: input.connectionId,
    model: input.model,
  };
}
