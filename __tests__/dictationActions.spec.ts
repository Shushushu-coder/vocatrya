// AWU-DICTATION settings actions: validation, the dictation settings
// namespace write, and the two credential paths — "shared" delegates to
// the existing BYOK save (keeping its AIConnection projection in sync),
// "dedicated" seals onto a dictation-namespaced ApiKey row that BYOK
// surfaces never resolve.
const requireUser = vi.hoisted(() => vi.fn(async () => ({ id: "user-1" })));
vi.mock("@/actions/shared", () => ({ requireUser }));

const saveApiKey = vi.hoisted(() => vi.fn());
vi.mock("@/actions/apiKey.actions", () => ({ saveApiKey }));

const sealApiKeySecret = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/credential-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/credential-store")>();
  return { ...actual, sealApiKeySecret };
});

const prisma = vi.hoisted(() => ({
  userSettings: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  apiKey: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ default: prisma }));

import {
  deleteDictationKey,
  getDictationSettings,
  saveDictationKey,
  updateDictationSettings,
} from "@/actions/dictation.actions";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.userSettings.findUnique.mockResolvedValue(null);
  prisma.userSettings.create.mockResolvedValue({});
  prisma.apiKey.findMany.mockResolvedValue([]);
  prisma.apiKey.upsert.mockResolvedValue({
    last4: "wxyz",
    iv: "os:v1:abc",
    encryptedKey: "enc",
  });
  prisma.apiKey.deleteMany.mockResolvedValue({ count: 1 });
  sealApiKeySecret.mockResolvedValue({ encryptedKey: "enc", iv: "os:v1:abc" });
});

describe("updateDictationSettings", () => {
  it("rejects unknown providers and missing fields before any write", async () => {
    for (const input of [
      { provider: "ollama", model: "x", credentialMode: "shared" },
      // N-2: a previously selectable provider is now refused as well.
      { provider: "openai", model: "x", credentialMode: "shared" },
      { provider: "gemini", model: "", credentialMode: "shared" },
      { provider: "gemini", model: "x", credentialMode: "bogus" },
      { provider: "gemini", model: "x".repeat(200), credentialMode: "shared" },
    ]) {
      const result = await updateDictationSettings(input);
      expect(result.success).toBe(false);
    }
    expect(prisma.userSettings.findUnique).not.toHaveBeenCalled();
  });

  it("persists the dictation namespace through the CAS patch path", async () => {
    prisma.userSettings.findUnique.mockResolvedValue({
      settings: JSON.stringify({ ai: { provider: "ollama" } }),
    });
    prisma.userSettings.updateMany.mockResolvedValue({ count: 1 });
    const result = await updateDictationSettings({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      credentialMode: "shared",
    });
    expect(result.success).toBe(true);
    const write = prisma.userSettings.updateMany.mock.calls[0]![0] as {
      data: { settings: string };
    };
    const doc = JSON.parse(write.data.settings);
    expect(doc.dictation).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      credentialMode: "shared",
    });
    // The chat AI selection is untouched by the dictation write.
    expect(doc.ai).toEqual({ provider: "ollama" });
  });
});

describe("saveDictationKey", () => {
  it("rejects unknown providers and empty keys", async () => {
    for (const input of [
      { provider: "ollama", credentialMode: "dedicated", key: "x" },
      { provider: "openai", credentialMode: "dedicated", key: "x" },
      { provider: "gemini", credentialMode: "dedicated", key: "  " },
    ]) {
      expect((await saveDictationKey(input)).success).toBe(false);
    }
    expect(saveApiKey).not.toHaveBeenCalled();
    expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
  });

  it("delegates shared keys to the existing BYOK save path", async () => {
    saveApiKey.mockResolvedValue({
      success: true,
      data: { last4: "1234", protection: "os" },
    });
    const result = await saveDictationKey({
      provider: "gemini",
      credentialMode: "shared",
      key: "AIza-new",
    });
    expect(result.success).toBe(true);
    expect(saveApiKey).toHaveBeenCalledWith({
      provider: "gemini",
      key: "AIza-new",
    });
    // No direct write — the BYOK path owns the row and its projection.
    expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
  });

  it("seals dedicated keys onto a dictation-namespaced row", async () => {
    const result = await saveDictationKey({
      provider: "gemini",
      credentialMode: "dedicated",
      key: "AIza-dict",
    });
    expect(result.success).toBe(true);
    expect(saveApiKey).not.toHaveBeenCalled();
    const upsert = prisma.apiKey.upsert.mock.calls[0]![0] as {
      where: { userId_provider: { userId: string; provider: string } };
      create: { provider: string };
    };
    expect(upsert.where.userId_provider.provider).toBe("dictation-gemini");
    expect(upsert.create.provider).toBe("dictation-gemini");
    expect(result.data).toMatchObject({ last4: "wxyz", protection: "os" });
  });
});

describe("deleteDictationKey", () => {
  it("refuses to delete shared BYOK keys", async () => {
    const result = await deleteDictationKey({
      provider: "gemini",
      credentialMode: "shared",
    });
    expect(result.success).toBe(false);
    expect(prisma.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only the dictation-namespaced row", async () => {
    const result = await deleteDictationKey({
      provider: "gemini",
      credentialMode: "dedicated",
    });
    expect(result.success).toBe(true);
    expect(prisma.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "dictation-gemini" },
    });
  });
});

describe("getDictationSettings", () => {
  it("returns config plus per-provider credential metadata, never key material", async () => {
    prisma.userSettings.findUnique.mockResolvedValue({
      settings: JSON.stringify({
        dictation: {
          provider: "gemini",
          model: "gemini-3.5-flash-lite",
          credentialMode: "dedicated",
        },
      }),
    });
    prisma.apiKey.findMany.mockResolvedValue([
      { provider: "gemini", last4: "aaaa", iv: "os:v1:x", encryptedKey: "ENC1" },
      {
        provider: "dictation-gemini",
        last4: "bbbb",
        iv: "",
        encryptedKey: "ENC2",
      },
    ]);
    const result = await getDictationSettings();
    expect(result.success).toBe(true);
    expect(result.data?.config).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      credentialMode: "dedicated",
    });
    expect(result.data?.credentials.gemini).toEqual({
      shared: { last4: "aaaa", protection: "os" },
      dedicated: { last4: "bbbb", protection: "none" },
    });
    expect(result.data?.credentials).not.toHaveProperty("openai");
    expect(JSON.stringify(result)).not.toContain("ENC");
  });
});
