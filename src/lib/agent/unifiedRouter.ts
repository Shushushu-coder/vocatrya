import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { isAgentRole, type AgentRole } from "./agentRoles";
import {
  readMessageAgentRole,
  roleAttributionTag,
  type StepHandoffPayload,
} from "./unifiedChatTypes";

export type PlannedRouteStep = {
  role: AgentRole;
  objective: string;
};

export type RoutePlan = {
  layer: "layer0" | "layer1";
  reason: string;
  steps: PlannedRouteStep[];
  truncatedExtraGoals?: boolean;
};

export type Layer0Input = {
  operation: "send" | "regenerate" | "approval" | "retry_step" | "reanswer";
  userText: string;
  activeRole: AgentRole | null;
  hasHistory: boolean;
  forcedRole?: AgentRole | null;
  approvalRole?: AgentRole | null;
  hasActiveTask?: boolean;
};

// Conservative pure-continuation phrases (D01): short, strongly referential,
// zero cross-role action verbs or domain write/evaluation entities.
const PURE_CONTINUATION_RE =
  /^(?:[嗯哦好行对是]+[,，、\s]*)?(继续|接着说|接着讲|展开|展开说说|详细说说|再详细点|展开第[一二三四五1-5][条个点]?|第[一二三四五1-5][条个点]?展开|把第[一二三四五1-5][条个点]?展开|那第[一二三四五1-5][条个点]呢|第[一二三四五1-5][条个点]呢|为什么|怎么理解|举个例子|具体说说|再说详细些|还有吗|还有呢|continue|go on|keep going|elaborate|more details|explain more|why\??|give an example|tell me more)[。.!！?？]*$/i;

// Action/domain tokens that indicate a potential role boundary crossing —
// whenever present, Layer 0 MUST NOT short-circuit; hand off to Layer 1.
const CROSS_ROLE_SIGNAL_RE =
  /(待办|清单|计划|to-?do|加进|加入|列入|列成|记录|录入|添加职位|加个职位|保存|写入|notion|飞书|feishu|匹配|打分|评估|诊断|改简历|简历评估|offer对比|谈薪|复盘|面试表现|面试挂|心态|焦虑|反思)/i;

/**
 * Layer 0 deterministic fast-path (D01: 0ms, 0 tokens).
 * Only fires for explicit entries, flow-locked states, and conservatively
 * verified pure continuations. Everything else falls through to Layer 1.
 */
export function evaluateLayer0Route(
  input: Layer0Input,
): { hit: true; plan: RoutePlan } | { hit: false } {
  if (input.operation === "reanswer" && input.forcedRole) {
    return {
      hit: true,
      plan: {
        layer: "layer0",
        reason: "explicit_reanswer",
        steps: [{ role: input.forcedRole, objective: "Re-answer from the requested perspective" }],
      },
    };
  }
  if (input.operation === "retry_step" && input.forcedRole) {
    return {
      hit: true,
      plan: {
        layer: "layer0",
        reason: "explicit_retry_step",
        steps: [{ role: input.forcedRole, objective: "Retry the failed step" }],
      },
    };
  }
  if (input.operation === "approval") {
    const role = input.approvalRole ?? input.activeRole ?? "pilot";
    return {
      hit: true,
      plan: {
        layer: "layer0",
        reason: "approval_continuation",
        steps: [{ role, objective: "Continue after user approval decision" }],
      },
    };
  }
  if (input.hasActiveTask) {
    return {
      hit: true,
      plan: {
        layer: "layer0",
        reason: "task_session_locked",
        steps: [{ role: "pilot", objective: "Advance bound agent task" }],
      },
    };
  }
  const trimmed = input.userText.trim();
  const compactLen = trimmed.replace(/\s+/g, "").length;
  if (
    input.hasHistory &&
    input.activeRole &&
    compactLen > 0 &&
    compactLen <= 18 &&
    PURE_CONTINUATION_RE.test(trimmed) &&
    !CROSS_ROLE_SIGNAL_RE.test(trimmed)
  ) {
    return {
      hit: true,
      plan: {
        layer: "layer0",
        reason: "pure_continuation",
        steps: [{ role: input.activeRole, objective: trimmed }],
      },
    };
  }
  return { hit: false };
}

export const LAYER1_ROUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps", "truncatedExtraGoals"],
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "objective"],
        properties: {
          role: { type: "string", enum: ["pilot", "insight", "reflect"] },
          objective: { type: "string" },
        },
      },
    },
    truncatedExtraGoals: { type: "boolean" },
  },
} as const;

function compactRecentContext(
  messages: UIMessage[],
  fallbackRole: AgentRole | null,
): string {
  const recent = messages.slice(-4);
  const lines: string[] = [];
  for (const msg of recent) {
    const text = (msg.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 180);
    if (!text) continue;
    if (msg.role === "user") {
      lines.push(`User: ${text}`);
    } else if (msg.role === "assistant") {
      const tag = roleAttributionTag(readMessageAgentRole(msg, fallbackRole));
      lines.push(`Assistant${tag ? ` ${tag}` : ""}: ${text}`);
    }
  }
  return lines.join("\n").slice(0, 600);
}

/**
 * Minimal Layer 1 classifier prompt (D01 + D02 + D03):
 * Tiny context, sticky-role bias, high threshold for 2-step chaining,
 * strict JSON output only.
 */
export function buildLayer1RouterPrompt(input: {
  activeRole: AgentRole | null;
  hasHistory: boolean;
  messages: UIMessage[];
  userText: string;
  hasPendingTodoDraft?: boolean;
}): string {
  const recent = compactRecentContext(input.messages, input.activeRole);
  const currentRole = input.activeRole ?? "none (new session — default fallback is pilot)";
  return [
    "You are Vocatrya's silent intent router. Output ONE JSON object ONLY. No markdown fences, no prose, no explanations.",
    'Output schema: {"steps":[{"role":"pilot"|"insight"|"reflect","objective":"short goal"}],"truncatedExtraGoals":false}',
    "Role boundaries (D02):",
    "- All 3 roles can chat, explain, and use ALL read-only tools (jobs, resumes, today's plan read, Notion/Feishu read, web search). Do NOT switch roles just to explain or read data.",
    '- "pilot" (执行助手): ONLY role for writing/managing to-do lists (today_plan), logging jobs (add_job), and writing to Notion/Feishu. Cold-start default for general/ambiguous requests.',
    '- "insight" (职业顾问): ONLY role for deep job match analysis (match_job), resume review/scoring (review_resume), offer comparison, and career/salary strategy.',
    '- "reflect" (复盘教练): Interview & application debriefing, root-cause takeaways, growth pacing, and mindset/anxiety coaching (read-only).',
    "Routing rules (D01 + D03):",
    "1. Sticky preference: If activeRole can handle the request with general dialogue or read-only tools, KEEP activeRole (1 step).",
    "2. Only switch roles when the user's goal clearly requires another role's exclusive capability.",
    "3. Compound 2-step chaining (HIGH threshold, MAX 2 steps): ONLY output 2 steps when the user EXPLICITLY asks for two distinct goals AND Step 2 requires a DIFFERENT role's exclusive capability (e.g. insight evaluates job/resume -> pilot creates today's to-do draft; reflect debriefs interview -> pilot creates today's to-do draft; pilot logs a job -> insight runs match_job). Pure analysis + text suggestions MUST stay 1 step.",
    "4. Never invent unrequested steps. If the user asks for 3+ cross-role goals, pick the 2 core steps and set truncatedExtraGoals=true.",
    `Current activeRole: ${currentRole}`,
    ...(input.hasPendingTodoDraft ? ["State: There is an unadopted to-do draft card in this conversation."] : []),
    ...(recent ? [`Recent context:\n${recent}`] : []),
    `Current user input:\n${input.userText.slice(0, 1200)}`,
    "Router JSON:",
  ].join("\n");
}

function fallbackRoute(input: {
  activeRole: AgentRole | null;
  hasHistory: boolean;
  userText: string;
  reason: string;
}): RoutePlan {
  const role: AgentRole =
    input.hasHistory && input.activeRole ? input.activeRole : "pilot";
  return {
    layer: "layer1",
    reason: input.reason,
    steps: [{ role, objective: input.userText.trim().slice(0, 160) || "Respond to user" }],
  };
}

/**
 * Parses and enforces D03 invariants on Layer 1 output:
 * - Strictly 1 or 2 steps;
 * - Duplicate consecutive roles collapse to 1 step;
 * - Invalid JSON falls back without questioning the user (inherit activeRole or pilot).
 */
export function parseLayer1RouteDecision(
  rawText: string,
  fallbackInput: {
    activeRole: AgentRole | null;
    hasHistory: boolean;
    userText: string;
  },
): RoutePlan {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return fallbackRoute({ ...fallbackInput, reason: "layer1_parse_fallback" });
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      steps?: unknown;
      truncatedExtraGoals?: unknown;
    };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return fallbackRoute({ ...fallbackInput, reason: "layer1_empty_fallback" });
    }
    const valid: PlannedRouteStep[] = [];
    for (const item of parsed.steps) {
      if (!item || typeof item !== "object") continue;
      const role = (item as { role?: unknown }).role;
      const objective = (item as { objective?: unknown }).objective;
      if (!isAgentRole(role)) continue;
      const cleanObjective =
        typeof objective === "string" && objective.trim()
          ? objective.trim().slice(0, 200)
          : fallbackInput.userText.trim().slice(0, 160);
      // D03: two steps must have distinct roles — collapse same-role steps.
      if (valid.length > 0 && valid[valid.length - 1].role === role) continue;
      valid.push({ role, objective: cleanObjective });
      if (valid.length >= 2) break;
    }
    if (valid.length === 0) {
      return fallbackRoute({ ...fallbackInput, reason: "layer1_invalid_role_fallback" });
    }
    const truncated =
      parsed.truncatedExtraGoals === true || parsed.steps.length > 2;
    return {
      layer: "layer1",
      reason: valid.length === 2 ? "layer1_compound_2step" : "layer1_single_role",
      steps: valid,
      ...(truncated ? { truncatedExtraGoals: true } : {}),
    };
  } catch {
    return fallbackRoute({ ...fallbackInput, reason: "layer1_json_fallback" });
  }
}

/**
 * Deterministic Step 1 -> Step 2 handoff payload builder (D03 §2.5.2: 0 extra LLM calls).
 * Extracts ONLY verified entity IDs and committed outcomes from Step 1's actual tool parts.
 */
export function buildStepHandoffPayload(input: {
  step1Role: AgentRole;
  step1Objective: string;
  step2Objective: string;
  step1Message: UIMessage | undefined;
}): StepHandoffPayload {
  const jobIds = new Set<string>();
  const matchAnalysisIds = new Set<string>();
  const resumeVersionIds = new Set<string>();
  const outcomes: Array<{ tool: string; status: string }> = [];

  for (const part of input.step1Message?.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    const tool = getToolName(part);
    if (part.state !== "output-available") {
      outcomes.push({ tool, status: part.state });
      continue;
    }
    const out = part.output as Record<string, unknown> | undefined;
    const status =
      typeof out?.status === "string"
        ? out.status
        : out?.created === true
          ? "created"
          : out?.saved === true
            ? "saved"
            : "completed";
    outcomes.push({ tool, status });
    if (out && typeof out === "object") {
      for (const key of ["jobId", "jobOpportunityId"] as const) {
        if (typeof out[key] === "string" && out[key]) jobIds.add(out[key] as string);
      }
      if (typeof out.matchAnalysisId === "string" && out.matchAnalysisId) {
        matchAnalysisIds.add(out.matchAnalysisId);
      }
      if (typeof out.resumeVersionId === "string" && out.resumeVersionId) {
        resumeVersionIds.add(out.resumeVersionId);
      }
      if (typeof out.id === "string" && out.id) {
        if (tool === "add_job" && out.created === true) jobIds.add(out.id);
        if (tool === "match_job" && status === "completed") matchAnalysisIds.add(out.id);
      }
    }
  }

  return {
    step1Role: input.step1Role,
    step1Objective: input.step1Objective,
    step2Objective: input.step2Objective,
    verifiedEntities: {
      jobIds: [...jobIds],
      matchAnalysisIds: [...matchAnalysisIds],
      resumeVersionIds: [...resumeVersionIds],
      outcomes,
    },
  };
}

export function formatStepHandoffInstruction(payload: StepHandoffPayload): string {
  const entityBits: string[] = [];
  if (payload.verifiedEntities.jobIds.length) {
    entityBits.push(`Verified Job IDs: ${payload.verifiedEntities.jobIds.join(", ")}`);
  }
  if (payload.verifiedEntities.matchAnalysisIds.length) {
    entityBits.push(`Verified MatchAnalysis IDs: ${payload.verifiedEntities.matchAnalysisIds.join(", ")}`);
  }
  if (payload.verifiedEntities.resumeVersionIds.length) {
    entityBits.push(`Verified ResumeVersion IDs: ${payload.verifiedEntities.resumeVersionIds.join(", ")}`);
  }
  if (payload.verifiedEntities.outcomes.length) {
    entityBits.push(
      `Step 1 tool outcomes: ${payload.verifiedEntities.outcomes.map((o) => `${o.tool}=${o.status}`).join("; ")}`,
    );
  }
  return [
    "\n[COMPOUND TURN STEP 2 HANDOFF]",
    `Step 1 (${roleAttributionTag(payload.step1Role)}) completed objective: ${payload.step1Objective}`,
    `Your Step 2 objective: ${payload.step2Objective}`,
    ...(entityBits.length ? entityBits : ["No business write entity IDs were produced in Step 1."]),
    "CRITICAL (D06): If creating to-do items derived from Step 1's analysis/debrief, you MUST call today_plan with action=\"suggest\" so the user reviews and adopts the draft card — never use action=\"add\". Never claim unexecuted or failed actions succeeded.",
  ].join("\n");
}
