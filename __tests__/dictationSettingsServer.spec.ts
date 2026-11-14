// AWU-DICTATION server-side config resolution: the dictation settings
// document picks provider/model/credential mode independently of chat BYOK,
// and credential resolution goes through the shared protected store.
const resolveApiKeySecret = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/credential-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/credential-store")>();
  return { ...actual, resolveApiKeySecret };
});
vi.mock("@/lib/db", () => ({ default: {} }));

import {
  credentialProviderFor,
  dictationSettingsFromDocument,
  resolveDictationConfig,
} from "@/lib/dictation/settings.server";
import { DICTATION_ERROR_CODES } from "@/lib/dictation/config";

const CONFIGURED = {
  dictation: { provider: "openai", model: "gpt-transcribe" },
};

function db(overrides: {
  settings?: string | null;
  keyRow?: { encryptedKey: string; iv: string } | null;
} = {}) {
  const apiKeyFindFirst = vi.fn(async () => overrides.keyRow ?? null);
  return {
    store: {
      userSettings: {
        findUnique: vi.fn(async () =>
          overrides.settings === undefined
            ? { settings: JSON.stringify(CONFIGURED) }
            : overrides.settings === null
              ? null
              : { settings: overrides.settings },
        ),
      },
      apiKey: { findFirst: apiKeyFindFirst },
    },
    apiKeyFindFirst,
  };
}

beforeEach(() => {
  resolveApiKeySecret.mockReset();
  resolveApiKeySecret.mockResolvedValue("sk-live");
});

describe("dictationSettingsFromDocument", () => {
  it("reads a valid dictation namespace", () => {
    expect(
      dictationSettingsFromDocument(JSON.stringify(CONFIGURED)),
    ).toEqual({
      provider: "openai",
      model: "gpt-transcribe",
      credentialMode: "shared",
    });
  });

  it.each([
    ["not json", "not json"],
    ["empty document", "{}"],
    ["dictation not an object", JSON.stringify({ dictation: 5 })],
    ["missing model", JSON.stringify({ dictation: { provider: "openai" } })],
    [
      "unknown provider",
      JSON.stringify({ dictation: { provider: "ollama", model: "x" } }),
    ],
    [
      "oversized model",
      JSON.stringify({ dictation: { provider: "openai", model: "x".repeat(200) } }),
    ],
  ])("treats %s as not configured", (_name, raw) => {
    expect(dictationSettingsFromDocument(raw)).toBeNull();
  });

  it("keeps an explicit dedicated credential mode", () => {
    const doc = JSON.stringify({
      dictation: {
        provider: "gemini",
        model: "gemini-2.5-flash",
        credentialMode: "dedicated",
      },
    });
    expect(dictationSettingsFromDocument(doc)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      credentialMode: "dedicated",
    });
  });
});

describe("credentialProviderFor", () => {
  it("points shared mode at the provider's BYOK row", () => {
    expect(
      credentialProviderFor({
        provider: "openai",
        model: "m",
        credentialMode: "shared",
      }),
    ).toBe("openai");
  });

  it("points dedicated mode at the dictation-namespaced row", () => {
    expect(
      credentialProviderFor({
        provider: "openai",
        model: "m",
        credentialMode: "dedicated",
      }),
    ).toBe("dictation-openai");
  });
});

describe("resolveDictationConfig", () => {
  it("resolves settings plus the shared BYOK key", async () => {
    const { store, apiKeyFindFirst } = db({
      keyRow: { encryptedKey: "enc", iv: "os:v1:x" },
    });
    const result = await resolveDictationConfig("u1", store as never);
    expect(result.settings.model).toBe("gpt-transcribe");
    expect(result.apiKey).toBe("sk-live");
    expect(apiKeyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", provider: "openai" },
      }),
    );
  });

  it("reads the dictation-namespaced row in dedicated mode", async () => {
    const { store, apiKeyFindFirst } = db({
      settings: JSON.stringify({
        dictation: {
          provider: "openai",
          model: "gpt-transcribe",
          credentialMode: "dedicated",
        },
      }),
      keyRow: { encryptedKey: "enc", iv: "os:v1:x" },
    });
    await resolveDictationConfig("u1", store as never);
    expect(apiKeyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", provider: "dictation-openai" },
      }),
    );
  });

  it("rejects as NOT_CONFIGURED when no dictation settings exist", async () => {
    for (const settings of [null, "{}", "garbage"]) {
      const { store } = db({ settings });
      await expect(
        resolveDictationConfig("u1", store as never),
      ).rejects.toMatchObject({
        code: DICTATION_ERROR_CODES.NOT_CONFIGURED,
      });
    }
  });

  it("rejects as CREDENTIAL_UNAVAILABLE when the key row is missing", async () => {
    const { store } = db({ keyRow: null });
    await expect(
      resolveDictationConfig("u1", store as never),
    ).rejects.toMatchObject({
      code: DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
    });
  });

  it("rejects as CREDENTIAL_UNAVAILABLE when the sealed key cannot be read", async () => {
    resolveApiKeySecret.mockRejectedValue(new Error("foreign machine"));
    const { store } = db({ keyRow: { encryptedKey: "enc", iv: "os:v1:x" } });
    await expect(
      resolveDictationConfig("u1", store as never),
    ).rejects.toMatchObject({
      code: DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
    });
  });
});
