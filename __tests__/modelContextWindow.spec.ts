import { APP_CONSTANTS } from "@/lib/constants";
import {
  CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
  CAREER_DIALOGUE_DEFAULT_CONTEXT_WINDOW,
  resolveCareerDialogueBudgets,
  resolveModelContextWindow,
} from "@/lib/agent/modelContextWindow";

describe("model context window & dynamic budgets", () => {
  it("resolves known cloud model families and strips OpenRouter vendor prefixes and tags", () => {
    expect(resolveModelContextWindow({ model: "deepseek-chat", provider: "DEEPSEEK" })).toMatchObject({
      contextWindowTokens: 128_000,
      source: "catalog",
    });
    expect(
      resolveModelContextWindow({ model: "anthropic/claude-sonnet-4:free", provider: "OPENROUTER" }),
    ).toMatchObject({
      contextWindowTokens: 200_000,
      source: "catalog",
    });
    expect(
      resolveModelContextWindow({ model: "gemini-2.5-pro", provider: "GEMINI" }),
    ).toMatchObject({
      contextWindowTokens: 1_000_000,
      source: "catalog",
    });
    expect(
      resolveModelContextWindow({ model: "gpt-4.1-mini", provider: "OPENAI" }),
    ).toMatchObject({
      contextWindowTokens: 1_000_000,
      source: "catalog",
    });
    expect(
      resolveModelContextWindow({ model: "qwen3-coder-plus", provider: "OPENROUTER" }),
    ).toMatchObject({
      contextWindowTokens: 128_000,
      source: "catalog",
    });
  });

  it("prefers explicit metadata window and Managed upstreamModelId", () => {
    expect(
      resolveModelContextWindow({
        model: "vocatrya-fast",
        upstreamModelId: "deepseek/deepseek-reasoner",
      }),
    ).toMatchObject({
      contextWindowTokens: 128_000,
      source: "catalog",
    });
    expect(
      resolveModelContextWindow({
        model: "unknown-custom-model",
        contextWindowTokens: 64_000,
      }),
    ).toMatchObject({
      contextWindowTokens: 64_000,
      source: "metadata",
    });
  });

  it("bounds Ollama turns by AGENT_CHAT_NUM_CTX and falls back safely for unknown models", () => {
    expect(
      resolveModelContextWindow({ model: "qwen3.5:9b", provider: "ollama" }),
    ).toMatchObject({
      contextWindowTokens: APP_CONSTANTS.AGENT_CHAT_NUM_CTX,
      source: "catalog",
      matchedRule: "ollama-num-ctx",
    });
    expect(
      resolveModelContextWindow({ model: "custom-obscure-model", provider: "OPENROUTER" }),
    ).toEqual({
      contextWindowTokens: CAREER_DIALOGUE_DEFAULT_CONTEXT_WINDOW,
      source: "default",
    });
  });

  it("scales budgets above legacy 16k/6-turn limits and enforces the 80k cost cap", () => {
    const defaultResolved = resolveCareerDialogueBudgets({ model: "unknown-model" });
    expect(defaultResolved.budgets.assembledInputTokens).toBe(24_000);
    expect(defaultResolved.budgets.maxRecentTurns).toBe(10);
    expect(defaultResolved.autoCompactTriggerTokens).toBeLessThan(
      defaultResolved.budgets.assembledInputTokens,
    );

    const claudeResolved = resolveCareerDialogueBudgets({
      model: "claude-sonnet-4",
      provider: "ANTHROPIC",
    });
    expect(claudeResolved.budgets.assembledInputTokens).toBe(
      CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
    );
    expect(claudeResolved.budgets.maxRecentTurns).toBe(32);
    expect(claudeResolved.budgets.historicalToolTokens).toBe(16_000);
    expect(claudeResolved.budgets.summaryTokens).toBe(2_400);

    const geminiResolved = resolveCareerDialogueBudgets({
      model: "gemini-2.5-pro",
      provider: "GEMINI",
    });
    expect(geminiResolved.budgets.assembledInputTokens).toBe(
      CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
    );
  });
});
