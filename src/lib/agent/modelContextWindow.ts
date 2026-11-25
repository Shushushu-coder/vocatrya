import { APP_CONSTANTS } from "@/lib/constants";

/**
 * Dynamic model context window resolver & cost-capped Career Dialogue budgets.
 *
 * Pure module (no `server-only`, no DB/network calls). Estimates a model's
 * effective context window from explicit metadata, provider runtime limits
 * (e.g., Ollama's `AGENT_CHAT_NUM_CTX`), or a conservative catalog table, then
 * scales assembly budgets with a hard cost-control ceiling (`80_000` tokens).
 */

export const CAREER_DIALOGUE_DEFAULT_CONTEXT_WINDOW = 32_000;
export const CAREER_DIALOGUE_MIN_CONTEXT_WINDOW = 8_192;
export const CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS = 80_000;
export const CAREER_DIALOGUE_AUTO_COMPACT_RATIO = 0.78;
export const CAREER_DIALOGUE_BUSINESS_ANCHOR_TOKENS = 800;

export type CareerDialogueContextBudgets = {
  dynamicTokens: number;
  explicitContextTokens: number;
  historyTokens: number;
  maxRecentTurns: number;
  summaryTokens: number;
  handoffTokens: number;
  businessAnchorTokens: number;
  historicalToolTokens: number;
  currentUserTokens: number;
  assembledInputTokens: number;
};

export type ModelContextWindowSource = "metadata" | "catalog" | "default";

export type ModelContextWindowResolution = {
  contextWindowTokens: number;
  source: ModelContextWindowSource;
  matchedRule?: string;
};

export type CareerDialogueBudgetInput = {
  model?: string | null;
  upstreamModelId?: string | null;
  provider?: string | null;
  backendKind?: string | null;
  contextWindowTokens?: number | null;
  overrides?: Partial<CareerDialogueContextBudgets>;
};

export type ResolvedCareerDialogueBudgets = {
  budgets: CareerDialogueContextBudgets;
  contextWindowTokens: number;
  contextWindowSource: ModelContextWindowSource;
  assembledCapTokens: number;
  autoCompactTriggerTokens: number;
};

const CATALOG_RULES: ReadonlyArray<{
  rule: string;
  pattern: RegExp;
  windowTokens: number;
}> = [
  { rule: "claude-1m", pattern: /^claude-.*1m/, windowTokens: 1_000_000 },
  {
    rule: "claude-200k",
    pattern: /^claude-(?:3|4|sonnet|opus|haiku)/,
    windowTokens: 200_000,
  },
  { rule: "gemini-1m", pattern: /^gemini-(?:1\.5|2|3)/, windowTokens: 1_000_000 },
  { rule: "gpt-4.1", pattern: /^gpt-4\.1/, windowTokens: 1_000_000 },
  { rule: "gpt-5-6", pattern: /^gpt-(?:5|6)/, windowTokens: 400_000 },
  {
    rule: "openai-reasoning",
    pattern: /(?:^|-)o(?:1|3|4)(?:-|$)/,
    windowTokens: 200_000,
  },
  {
    rule: "gpt-4o-turbo-codex",
    pattern: /gpt-4o|gpt-4-turbo|codex/,
    windowTokens: 128_000,
  },
  { rule: "gpt-4-classic", pattern: /^gpt-4(?:-|$)/, windowTokens: 8_192 },
  { rule: "gpt-3.5", pattern: /^gpt-3\.5/, windowTokens: 16_384 },
  {
    rule: "deepseek-128k",
    pattern: /^deepseek-(?:chat|reasoner|v3|r1)/,
    windowTokens: 128_000,
  },
  { rule: "deepseek-base", pattern: /^deepseek/, windowTokens: 64_000 },
  { rule: "grok-4", pattern: /^grok-4/, windowTokens: 256_000 },
  { rule: "grok-2-3", pattern: /^grok-(?:2|3)/, windowTokens: 128_000 },
  {
    rule: "qwen-128k",
    pattern: /^qwen(?:3|2\.5|-max|-plus|-turbo)/,
    windowTokens: 128_000,
  },
  { rule: "moonshot-8k", pattern: /^moonshot-v1-8k/, windowTokens: 8_192 },
  { rule: "moonshot-32k", pattern: /^moonshot-v1-32k/, windowTokens: 32_000 },
  { rule: "moonshot-kimi-128k", pattern: /moonshot|kimi/, windowTokens: 128_000 },
  { rule: "glm-128k", pattern: /^glm-(?:4|5)|^chatglm/, windowTokens: 128_000 },
  { rule: "minimax-128k", pattern: /^minimax/, windowTokens: 128_000 },
  {
    rule: "llama-128k",
    pattern: /^llama-?(?:3\.[123]|4)/,
    windowTokens: 128_000,
  },
];

function normalizeModelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/:(?:free|extended|nitro|online|beta|thinking)$/i, "");
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveModelContextWindow(input?: {
  model?: string | null;
  upstreamModelId?: string | null;
  provider?: string | null;
  backendKind?: string | null;
  contextWindowTokens?: number | null;
}): ModelContextWindowResolution {
  const provider = input?.provider?.trim().toLowerCase() ?? "";
  const explicit = input?.contextWindowTokens;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 4_096) {
    return {
      contextWindowTokens: Math.floor(explicit),
      source: "metadata",
    };
  }

  // Local Ollama turns pass `num_ctx: AGENT_CHAT_NUM_CTX`, which bounds the
  // effective window regardless of model architecture.
  if (provider === "ollama") {
    return {
      contextWindowTokens: APP_CONSTANTS.AGENT_CHAT_NUM_CTX,
      source: "catalog",
      matchedRule: "ollama-num-ctx",
    };
  }

  const candidates = [input?.upstreamModelId, input?.model].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const normalized = normalizeModelId(candidate);
    if (!normalized) continue;
    for (const entry of CATALOG_RULES) {
      if (entry.pattern.test(normalized)) {
        return {
          contextWindowTokens: entry.windowTokens,
          source: "catalog",
          matchedRule: entry.rule,
        };
      }
    }
  }

  return {
    contextWindowTokens: CAREER_DIALOGUE_DEFAULT_CONTEXT_WINDOW,
    source: "default",
  };
}

export function resolveCareerDialogueBudgets(
  input?: CareerDialogueBudgetInput,
): ResolvedCareerDialogueBudgets {
  const resolution = resolveModelContextWindow(input);
  const windowTokens = Math.max(
    CAREER_DIALOGUE_MIN_CONTEXT_WINDOW,
    resolution.contextWindowTokens,
  );

  const assembledInputTokens = clamp(
    roundTo(windowTokens * 0.75, 500),
    6_000,
    CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
  );
  const dynamicTokens = clamp(
    roundTo(assembledInputTokens * 0.78, 500),
    4_000,
    Math.max(4_000, assembledInputTokens - 4_000),
  );
  const historyTokens = clamp(roundTo(dynamicTokens * 0.65, 500), 3_000, 42_000);
  const historicalToolTokens = clamp(
    roundTo(assembledInputTokens * 0.22, 500),
    2_000,
    16_000,
  );
  const explicitContextTokens = clamp(
    roundTo(assembledInputTokens * 0.12, 500),
    2_000,
    8_000,
  );
  const summaryTokens = clamp(
    roundTo(1_200 + assembledInputTokens * 0.015, 200),
    1_200,
    2_400,
  );
  const currentUserTokens = clamp(
    roundTo(assembledInputTokens * 0.25, 500),
    6_000,
    16_000,
  );
  const maxRecentTurns = clamp(Math.round(assembledInputTokens / 2_500), 8, 32);

  const baseBudgets: CareerDialogueContextBudgets = {
    dynamicTokens,
    explicitContextTokens,
    historyTokens,
    maxRecentTurns,
    summaryTokens,
    handoffTokens: APP_CONSTANTS.AGENT_TASK_HANDOFF_TOKENS,
    businessAnchorTokens: CAREER_DIALOGUE_BUSINESS_ANCHOR_TOKENS,
    historicalToolTokens,
    currentUserTokens,
    assembledInputTokens,
  };

  const budgets: CareerDialogueContextBudgets = input?.overrides
    ? { ...baseBudgets, ...input.overrides }
    : baseBudgets;

  const autoCompactTriggerTokens = clamp(
    roundTo(budgets.assembledInputTokens * CAREER_DIALOGUE_AUTO_COMPACT_RATIO, 500),
    4_500,
    Math.max(4_500, budgets.assembledInputTokens - 1_000),
  );

  return {
    budgets,
    contextWindowTokens: resolution.contextWindowTokens,
    contextWindowSource: resolution.source,
    assembledCapTokens: CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
    autoCompactTriggerTokens,
  };
}
