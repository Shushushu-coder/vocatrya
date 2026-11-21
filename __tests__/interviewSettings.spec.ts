// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AiProvider } from "@/models/ai.model";
import { defaultUserSettings } from "@/models/userSettings.model";
import {
  getInterviewConfig,
  hasInterviewConfig,
  mergeAiSettingsForUpdate,
  parseUserSettingsJson,
} from "@/lib/interview/interviewSettings";

describe("interview settings contract", () => {
  it("legacy settings without ai.interview parse normally", () => {
    const raw = JSON.stringify({
      ai: { provider: "openai", model: "gpt-4o" },
      display: { theme: "dark" },
    });
    const parsed = parseUserSettingsJson(raw);
    expect(parsed.ai.provider).toBe("openai");
    expect(parsed.ai.model).toBe("gpt-4o");
    expect(parsed.ai.interview).toBeUndefined();
    expect(getInterviewConfig(parsed)).toBeUndefined();
    expect(hasInterviewConfig(parsed)).toBe(false);
  });

  it("configured ai.interview parses", () => {
    const raw = JSON.stringify({
      ai: {
        provider: "ollama",
        model: "llama3.2",
        interview: { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
      },
      display: { theme: "system" },
    });
    const parsed = parseUserSettingsJson(raw);
    expect(getInterviewConfig(parsed)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(hasInterviewConfig(parsed)).toBe(true);
  });

  it("global AI does not populate the interview config", () => {
    const parsed = parseUserSettingsJson(
      JSON.stringify({
        ai: { provider: "openai", model: "gpt-4o-mini" },
        display: { theme: "light" },
      }),
    );
    expect(parsed.ai.provider).toBe("openai");
    expect(getInterviewConfig(parsed)).toBeUndefined();
    // Even when the global model looks usable, there is no silent promotion.
    expect(hasInterviewConfig({ ai: parsed.ai })).toBe(false);
  });

  it("Ollama fallback does not occur", () => {
    expect(getInterviewConfig({ ai: { ...defaultUserSettings.ai } })).toBeUndefined();
    const parsed = parseUserSettingsJson(JSON.stringify(defaultUserSettings));
    expect(parsed.ai.interview).toBeUndefined();
    expect(hasInterviewConfig(parsed)).toBe(false);
  });

  it("incomplete interview blocks count as missing", () => {
    expect(getInterviewConfig({ ai: { interview: undefined } })).toBeUndefined();
    expect(getInterviewConfig({ ai: { interview: {} } })).toBeUndefined();
    expect(
      getInterviewConfig({ ai: { interview: { provider: "openrouter" } } }),
    ).toBeUndefined();
    expect(
      getInterviewConfig({ ai: { interview: { model: "x" } } }),
    ).toBeUndefined();
    expect(
      getInterviewConfig({
        ai: { interview: { provider: "  ", model: "  " } },
      }),
    ).toBeUndefined();
  });

  it("invalid JSON yields defaults with no interview", () => {
    const parsed = parseUserSettingsJson("{nope");
    expect(parsed.ai.provider).toBe(AiProvider.OLLAMA);
    expect(parsed.ai.interview).toBeUndefined();
    expect(hasInterviewConfig(parsed)).toBe(false);
  });

  it("merge preserves interview across global-ai updates", () => {
    const current = {
      provider: AiProvider.OLLAMA,
      model: "llama3.2",
      interview: { provider: "openai", model: "gpt-4o" },
    };
    const merged = mergeAiSettingsForUpdate(
      current,
      { provider: AiProvider.DEEPSEEK as never },
      false,
    );
    expect(merged.provider).toBe(AiProvider.DEEPSEEK);
    expect(merged.interview).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("explicit interview update replaces the pair", () => {
    const current = {
      provider: AiProvider.OLLAMA,
      model: undefined,
      interview: { provider: "openai", model: "gpt-4o" },
    };
    const merged = mergeAiSettingsForUpdate(
      current,
      { interview: { provider: "gemini", model: "gemini-2.0-flash" } },
      true,
    );
    expect(merged.interview).toEqual({
      provider: "gemini",
      model: "gemini-2.0-flash",
    });
  });

  it("explicit undefined interview clears the config", () => {
    const current = {
      provider: AiProvider.OLLAMA,
      model: undefined,
      interview: { provider: "openai", model: "gpt-4o" },
    };
    const merged = mergeAiSettingsForUpdate(
      current,
      { interview: undefined },
      true,
    );
    expect(merged.interview).toBeUndefined();
  });
});
