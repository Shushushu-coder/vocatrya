// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
import { getInterviewModel } from "@/lib/interview/getInterviewModel";
import { INTERVIEW_ADAPTER_ERROR_CODES } from "@/lib/interview/errors";
import { VocatryaInterviewModelResolver } from "@/lib/interview/interviewModelResolver";

const NOT_CONFIGURED =
  INTERVIEW_ADAPTER_ERROR_CODES.INTERVIEW_MODEL_NOT_CONFIGURED;

function settingsJson(ai: unknown): string {
  return JSON.stringify({ ai, display: { theme: "system" } });
}

describe("getInterviewModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("missing interview config throws WITHOUT calling getModel", async () => {
    const getModelFn = vi.fn();
    const err = await getInterviewModel("user-1", {
      loadSettingsJson: async () =>
        settingsJson({ provider: "openai", model: "gpt-4o" }),
      getModelFn,
    }).catch((e) => e);
    expect(err?.code).toBe(NOT_CONFIGURED);
    expect(getModelFn).not.toHaveBeenCalled();
  });

  it("missing provider throws WITHOUT calling getModel", async () => {
    const getModelFn = vi.fn();
    const err = await getInterviewModel("user-1", {
      loadSettingsJson: async () =>
        settingsJson({ interview: { model: "gpt-4o" } }),
      getModelFn,
    }).catch((e) => e);
    expect(err?.code).toBe(NOT_CONFIGURED);
    expect(getModelFn).not.toHaveBeenCalled();
  });

  it("missing model throws WITHOUT calling getModel", async () => {
    const getModelFn = vi.fn();
    const err = await getInterviewModel("user-1", {
      loadSettingsJson: async () =>
        settingsJson({ interview: { provider: "openai" } }),
      getModelFn,
    }).catch((e) => e);
    expect(err?.code).toBe(NOT_CONFIGURED);
    expect(getModelFn).not.toHaveBeenCalled();
  });

  it("unknown provider throws WITHOUT calling getModel", async () => {
    const getModelFn = vi.fn();
    const err = await getInterviewModel("user-1", {
      loadSettingsJson: async () =>
        settingsJson({ interview: { provider: "nope", model: "x" } }),
      getModelFn,
    }).catch((e) => e);
    expect(err?.code).toBe(NOT_CONFIGURED);
    expect(getModelFn).not.toHaveBeenCalled();
  });

  it("configured provider/model calls getModel and propagates userId", async () => {
    const fakeModel = { __fake: "model" };
    const getModelFn = vi.fn().mockResolvedValue(fakeModel);
    const handle = await getInterviewModel("user-42", {
      loadSettingsJson: async () =>
        settingsJson({
          provider: "ollama",
          model: "llama3.2",
          interview: { provider: "openai", model: "gpt-4o-mini" },
        }),
      getModelFn,
    });
    expect(getModelFn).toHaveBeenCalledTimes(1);
    expect(getModelFn).toHaveBeenCalledWith("openai", "gpt-4o-mini", "user-42");
    expect(handle.provider).toBe("openai");
    expect(handle.modelName).toBe("gpt-4o-mini");
    expect(handle.model).toBe(fakeModel);
    // Global config must not leak into the interview resolution.
    expect(handle.provider).not.toBe("ollama");
  });

  it("returns provenance only, never credentials", async () => {
    const getModelFn = vi.fn().mockResolvedValue({ __fake: "m" });
    const handle = await getInterviewModel("user-9", {
      loadSettingsJson: async () =>
        settingsJson({ interview: { provider: "gemini", model: "gemini-2.0-flash" } }),
      getModelFn,
    });
    expect(handle.provenance).toEqual({
      provider: "gemini",
      model: "gemini-2.0-flash",
    });
    const serialized = JSON.stringify(handle);
    expect(serialized).not.toMatch(/apiKey|api_key|credential|baseUrl|secret|token/i);
    expect(Object.keys(handle.provenance).sort()).toEqual(["model", "provider"]);
  });
});

describe("VocatryaInterviewModelResolver (Phase 1 contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves provider/model and generates strict JSON", async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ feedbackItems: [{ problemLabel: "x" }] }),
    });
    const resolver = new VocatryaInterviewModelResolver(async () => ({
      model: { __fake: "sdk-model" } as never,
      provider: "openrouter",
      modelName: "anthropic/claude-3.5-sonnet",
      provenance: {
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
      },
    }));
    const resolved = await resolver.resolve("user-7");
    expect(resolved.provider).toBe("openrouter");
    expect(resolved.model).toBe("anthropic/claude-3.5-sonnet");
    const out = await resolved.generateJson({
      system: "sys",
      prompt: "prompt",
    });
    expect(out).toEqual({ feedbackItems: [{ problemLabel: "x" }] });
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = (generateText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("sys");
    expect(call.prompt).toBe("prompt");
  });

  it("propagates model-not-configured without touching the SDK", async () => {
    const resolver = new VocatryaInterviewModelResolver(async () => {
      throw Object.assign(new Error("nope"), { code: NOT_CONFIGURED });
    });
    const err = await resolver.resolve("user-7").catch((e) => e);
    expect(err?.code ?? err?.message).toBeTruthy();
    expect(generateText).not.toHaveBeenCalled();
  });
});
