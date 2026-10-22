import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiProvider } from "@/models/ai.model";
import {
  mergeSettingsDocument,
  parseSettingsDocument,
  patchUserSettings,
  prepareSettingsPatch,
  SETTINGS_CONFLICT,
  SETTINGS_INVALID,
  USER_SETTINGS_CAS_MAX_RETRIES,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";

/**
 * Deterministic store: implements the same compare-and-swap semantics as
 * `updateMany({ where: { userId, settings: <read raw> } })` over an
 * in-memory row, plus explicit deferred gates so competing writers can be
 * interleaved at exact points — no random delays, no probabilistic loops.
 */
const harness = vi.hoisted(() => ({
  store: null as unknown as ControllableStore,
  user: { id: "user-1" } as { id: string } | null,
}));

vi.mock("@/lib/db", () => ({
  default: {
    userSettings: {
      findUnique: (args: unknown) => harness.store.findUnique(args),
      updateMany: (args: unknown) => harness.store.updateMany(args),
      create: (args: unknown) => harness.store.create(args),
    },
  },
}));

vi.mock("@/actions/shared", () => ({
  requireUser: async () => {
    if (!harness.user) throw new Error("Not authenticated");
    return harness.user;
  },
}));

import {
  clearInterviewAiSettings,
  getUserSettings,
  updateDisplaySettings,
  updateInterviewAiSettings,
  updateUserSettings,
} from "@/actions/userSettings.actions";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function p2002(): Error & { code: string } {
  return Object.assign(
    new Error("Unique constraint failed on the fields: (`userId`)"),
    { code: "P2002" },
  );
}

type StoreHook = (callIndex: number) => void | Promise<void>;

class ControllableStore implements UserSettingsStore {
  row: { settings: string } | null;
  counts = { findUnique: 0, updateMany: 0, create: 0 };
  updateManyArgs: Array<{
    where: { userId: string; settings: string };
    data: { settings: string };
  }> = [];
  hooks: {
    findUnique?: StoreHook;
    updateMany?: StoreHook;
    create?: StoreHook;
  } = {};
  failAt: {
    findUnique?: Record<number, unknown>;
    updateMany?: Record<number, unknown>;
    create?: Record<number, unknown>;
  } = {};
  private updateManyEntered: Deferred[] = [];
  private updateManyRelease: Array<Deferred | undefined> = [];
  private createEntered: Deferred[] = [];
  private createRelease: Array<Deferred | undefined> = [];

  constructor(seed: string | null = null) {
    this.row = seed === null ? null : { settings: seed };
  }

  /** Gate the Nth updateMany call: signal when entered, wait for release. */
  armUpdateMany(callIndex: number): void {
    this.updateManyEntered[callIndex] = deferred();
    this.updateManyRelease[callIndex] = deferred();
  }

  armCreate(callIndex: number): void {
    this.createEntered[callIndex] = deferred();
    this.createRelease[callIndex] = deferred();
  }

  updateManyEntry(callIndex: number): Promise<void> {
    return this.updateManyEntered[callIndex].promise;
  }

  releaseUpdateMany(callIndex: number): void {
    this.updateManyRelease[callIndex]?.resolve();
  }

  createEntry(callIndex: number): Promise<void> {
    return this.createEntered[callIndex].promise;
  }

  releaseCreate(callIndex: number): void {
    this.createRelease[callIndex]?.resolve();
  }

  private throwIfFailed(
    op: "findUnique" | "updateMany" | "create",
    callIndex: number,
  ): void {
    const failure = this.failAt[op]?.[callIndex];
    if (failure) throw failure;
  }

  async findUnique(_args?: unknown): Promise<{ settings: string } | null> {
    const n = this.counts.findUnique++;
    await this.hooks.findUnique?.(n);
    this.throwIfFailed("findUnique", n);
    return this.row === null ? null : { settings: this.row.settings };
  }

  async updateMany(args: unknown): Promise<{ count: number }> {
    const a = args as {
      where: { userId: string; settings: string };
      data: { settings: string };
    };
    const n = this.counts.updateMany++;
    this.updateManyArgs.push(a);
    this.updateManyEntered[n]?.resolve();
    await this.updateManyRelease[n]?.promise;
    await this.hooks.updateMany?.(n);
    this.throwIfFailed("updateMany", n);
    if (this.row !== null && this.row.settings === a.where.settings) {
      this.row = { settings: a.data.settings };
      return { count: 1 };
    }
    return { count: 0 };
  }

  async create(args: unknown): Promise<{ settings: string }> {
    const a = args as { data: { userId: string; settings: string } };
    const n = this.counts.create++;
    this.createEntered[n]?.resolve();
    await this.createRelease[n]?.promise;
    await this.hooks.create?.(n);
    this.throwIfFailed("create", n);
    if (this.row !== null) throw p2002();
    this.row = { settings: a.data.settings };
    return { settings: a.data.settings };
  }

  get document(): Record<string, unknown> {
    return this.row === null
      ? {}
      : (JSON.parse(this.row.settings) as Record<string, unknown>);
  }
}

describe("parseSettingsDocument", () => {
  it("tolerates missing, corrupt and non-object payloads", () => {
    for (const raw of [
      "{corrupt",
      "",
      null,
      undefined,
      "[]",
      "5",
      '"str"',
      "null",
    ]) {
      expect(parseSettingsDocument(raw)).toEqual({});
    }
  });

  it("preserves unknown top-level fields verbatim", () => {
    expect(
      parseSettingsDocument(
        '{"ai":{"provider":"ollama"},"careerProfile":{"edu":[1]},"misc":7}',
      ),
    ).toEqual({
      ai: { provider: "ollama" },
      careerProfile: { edu: [1] },
      misc: 7,
    });
  });
});

describe("prepareSettingsPatch", () => {
  const expectInvalid = (input: unknown) => {
    const result = prepareSettingsPatch(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(SETTINGS_INVALID);
  };

  it("rejects non-object roots", () => {
    for (const input of [null, undefined, 5, "x", true, [1, 2]]) {
      expectInvalid(input);
    }
  });

  it("rejects prototype-pollution keys at any depth", () => {
    for (const input of [
      JSON.parse('{"display":{"theme":"dark"},"__proto__":{"x":1}}'),
      JSON.parse('{"careerProfile":{"edu":{"__proto__":{"x":1}}}}'),
      JSON.parse('{"settings":{"list":[{"constructor":{"x":1}}]}}'),
      JSON.parse('{"settings":{"deep":{"prototype":1}}}'),
    ]) {
      expectInvalid(input);
    }
  });

  it("rejects unregistered top-level namespaces", () => {
    expectInvalid({ bogus: { a: 1 } });
    expectInvalid({ notifications: { enabled: true } });
  });

  it("validates display.theme against the enum", () => {
    expectInvalid({ display: { theme: "neon" } });
    expectInvalid({ display: { theme: 5 } });
    expectInvalid({ display: { theme: null } });
    expect(prepareSettingsPatch({ display: { theme: "dark" } })).toEqual({
      ok: true,
      patch: { display: { theme: "dark" } },
    });
  });

  it("validates ai.provider and ai.model", () => {
    expectInvalid({ ai: { provider: "not-a-provider" } });
    expectInvalid({ ai: { provider: 42 } });
    expectInvalid({ ai: { model: 42 } });
    expect(
      prepareSettingsPatch({
        ai: { provider: AiProvider.OPENAI, model: "gpt-4o" },
      }),
    ).toEqual({
      ok: true,
      patch: { ai: { provider: "openai", model: "gpt-4o" } },
    });
  });

  it("rejects unknown ai/display subkeys", () => {
    expectInvalid({ ai: { temperature: 0.5 } });
    expectInvalid({ display: { fontSize: 14 } });
  });

  it("drops undefined scalars on ai keys (preserve semantics)", () => {
    expect(
      prepareSettingsPatch({
        ai: { provider: undefined, model: undefined },
      }),
    ).toEqual({ ok: true, patch: {} });
  });

  it("normalizes ai.interview and maps unusable values to delete", () => {
    expect(
      prepareSettingsPatch({
        ai: { interview: { provider: " openai ", model: " gpt-4o " } },
      }),
    ).toEqual({
      ok: true,
      patch: { ai: { interview: { provider: "openai", model: "gpt-4o" } } },
    });

    const unusable = prepareSettingsPatch({
      ai: { interview: { provider: "", model: "" } },
    });
    expect(unusable.ok).toBe(true);
    if (unusable.ok) {
      const ai = unusable.patch.ai as Record<string, unknown>;
      expect(
        Object.prototype.hasOwnProperty.call(ai, "interview") &&
          ai.interview === undefined,
      ).toBe(true);
    }
  });

  it("keeps a top-level namespace key set to undefined as a no-op", () => {
    expect(
      prepareSettingsPatch({ ai: undefined, display: { theme: "dark" } }),
    ).toEqual({ ok: true, patch: { display: { theme: "dark" } } });
  });

  it("rejects namespace values that are not objects", () => {
    expectInvalid({ ai: 5 });
    expectInvalid({ display: "dark" });
    expectInvalid({ careerProfile: [1, 2] });
  });

  it("rejects non-JSON-safe payloads", () => {
    expectInvalid({ careerProfile: { when: new Date(0) } });
    expectInvalid({ settings: { n: Number.NaN } });
    expectInvalid({ settings: { n: Number.POSITIVE_INFINITY } });
    expectInvalid({ settings: { fn: () => undefined } });
    expectInvalid({ settings: { list: [undefined] } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectInvalid({ careerProfile: cyclic });
  });
});

describe("mergeSettingsDocument", () => {
  it("deep-merges nested objects without mutating the input", () => {
    const doc = {
      settings: { general: { locale: "zh-CN", keep: true } },
      ai: { provider: "ollama" },
    };
    const next = mergeSettingsDocument(doc, {
      settings: { general: { locale: "en" } },
    });
    expect(next.settings).toEqual({
      general: { locale: "en", keep: true },
    });
    expect(next.ai).toEqual({ provider: "ollama" });
    expect(doc.settings.general.locale).toBe("zh-CN");
  });

  it("replaces arrays and scalars wholesale; objects merge recursively", () => {
    const doc = { careerProfile: { tags: [1, 2, 3], meta: { a: 1, b: 2 } } };
    const next = mergeSettingsDocument(doc, {
      careerProfile: { tags: [9], meta: { b: 3 } },
    });
    expect(next.careerProfile).toEqual({
      tags: [9],
      meta: { a: 1, b: 3 },
    });
  });

  it("deletes a subtree on undefined and stores explicit null", () => {
    const doc = { ai: { interview: { provider: "x" }, provider: "ollama" } };
    const next = mergeSettingsDocument(doc, {
      ai: { interview: undefined },
      settings: { flag: null },
    });
    const ai = next.ai as Record<string, unknown>;
    expect("interview" in ai).toBe(false);
    expect(ai.provider).toBe("ollama");
    expect((next.settings as Record<string, unknown>).flag).toBeNull();
  });

  it("replaces an object target with a patch scalar and vice versa", () => {
    const doc = { settings: { general: { locale: "en" }, level: 5 } };
    const next = mergeSettingsDocument(doc, {
      settings: { general: "reset", level: { v: 1 } },
    });
    expect(next.settings).toEqual({ general: "reset", level: { v: 1 } });
  });

  it("preserves unknown document fields untouched", () => {
    const doc = {
      ai: { provider: "ollama" },
      futureNs: { deep: { keep: [1, 2] } },
    };
    const next = mergeSettingsDocument(doc, { display: { theme: "dark" } });
    expect(next.futureNs).toEqual({ deep: { keep: [1, 2] } });
    expect(next.display).toEqual({ theme: "dark" });
  });
});

describe("patchUserSettings CAS executor", () => {
  it("writes through CAS and echoes the persisted document", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"},"future":{"x":1}}',
    );
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result).toMatchObject({ success: true });
    if (result.success) {
      expect(result.settings.display).toEqual({ theme: "dark" });
    }
    expect(store.document.future).toEqual({ x: 1 });
    expect(store.counts).toEqual({ findUnique: 1, updateMany: 1, create: 0 });
  });

  it("creates the row with defaults ⊕ patch when it is missing", async () => {
    const store = new ControllableStore(null);
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result.success).toBe(true);
    expect(store.document).toEqual({
      ai: { provider: "ollama" },
      display: { theme: "dark" },
    });
    expect(store.counts).toEqual({ findUnique: 1, updateMany: 0, create: 1 });
  });

  it("two writers on different namespaces do not lose updates", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    store.armUpdateMany(0);

    // Writer A reads the row, then stalls inside its first CAS attempt.
    const writerA = patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    await store.updateManyEntry(0);

    // Writer B completes a full read→merge→CAS cycle first.
    const resultB = await patchUserSettings(
      "user-1",
      { ai: { provider: AiProvider.OPENAI, model: "gpt-4o" } },
      store,
    );
    expect(resultB.success).toBe(true);

    // A's first CAS misses (count=0) → re-reads B's document, re-merges,
    // second CAS (ungated) succeeds.
    store.releaseUpdateMany(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    expect(store.counts.updateMany).toBe(3); // A×2 + B×1
    expect(store.document.ai).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(store.document.display).toEqual({ theme: "dark" });
  });

  it("same-namespace nested fields from competing writers both survive", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    store.armUpdateMany(0);

    const writerA = patchUserSettings(
      "user-1",
      { ai: { provider: AiProvider.OPENAI } },
      store,
    );
    await store.updateManyEntry(0);

    const resultB = await patchUserSettings(
      "user-1",
      { ai: { interview: { provider: "gemini", model: "g-2" } } },
      store,
    );
    expect(resultB.success).toBe(true);

    store.releaseUpdateMany(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    expect(store.document.ai).toEqual({
      provider: "openai",
      model: "llama",
      interview: { provider: "gemini", model: "g-2" },
    });
  });

  it("re-reads the winner's document before retrying (no stale merge)", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    store.armUpdateMany(0);

    const writerA = patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    await store.updateManyEntry(0);

    const resultB = await patchUserSettings(
      "user-1",
      { ai: { provider: AiProvider.GEMINI } },
      store,
    );
    expect(resultB.success).toBe(true);

    store.releaseUpdateMany(0);
    await writerA;

    // A's second CAS was conditioned on the string B actually persisted —
    // proof of a real re-read, not a blind rewrite of A's stale snapshot.
    const bPersistedRaw = store.updateManyArgs[1].data.settings;
    expect(store.updateManyArgs[2].where.settings).toBe(bPersistedRaw);
    const merged = JSON.parse(store.updateManyArgs[2].data.settings);
    expect(merged.ai.provider).toBe("gemini");
    expect(merged.display.theme).toBe("dark");
  });

  it("returns SETTINGS_CONFLICT after the retry budget is exhausted", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    // Every CAS misses because a competing write always lands first.
    store.hooks.updateMany = (n) => {
      store.row = {
        settings: JSON.stringify({ display: { theme: "light" }, race: n }),
      };
    };
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result).toMatchObject({
      success: false,
      code: SETTINGS_CONFLICT,
    });
    // Initial attempt + USER_SETTINGS_CAS_MAX_RETRIES retries.
    expect(store.counts.updateMany).toBe(USER_SETTINGS_CAS_MAX_RETRIES + 1);
    expect(store.counts.findUnique).toBe(USER_SETTINGS_CAS_MAX_RETRIES + 1);
  });

  it("does not misclassify non-conflict persistence failures", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    store.failAt.updateMany = { 0: new Error("database is locked") };
    await expect(
      patchUserSettings("user-1", { display: { theme: "dark" } }, store),
    ).rejects.toThrow("database is locked");
    expect(store.counts.updateMany).toBe(1); // no retry on real errors

    const store2 = new ControllableStore(null);
    store2.failAt.findUnique = { 0: new Error("connection reset") };
    await expect(
      patchUserSettings("user-1", { display: { theme: "dark" } }, store2),
    ).rejects.toThrow("connection reset");

    // P2003 (FK) is not a unique violation → propagates, never a conflict.
    const store3 = new ControllableStore(null);
    store3.failAt.create = {
      0: Object.assign(new Error("fk violated"), { code: "P2003" }),
    };
    await expect(
      patchUserSettings("user-1", { display: { theme: "dark" } }, store3),
    ).rejects.toThrow("fk violated");
  });

  it("settles a first-create race without losing either write", async () => {
    const store = new ControllableStore(null);
    store.armCreate(0);

    // Writer A sees no row and stalls inside create.
    const writerA = patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    await store.createEntry(0);

    // Writer B also sees no row, then creates first and wins.
    const resultB = await patchUserSettings(
      "user-1",
      { ai: { provider: AiProvider.DEEPSEEK } },
      store,
    );
    expect(resultB.success).toBe(true);

    // A's create loses → P2002 → re-read B's row → CAS merge succeeds.
    store.releaseCreate(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    expect(store.counts).toEqual({ findUnique: 3, updateMany: 1, create: 2 });
    expect(store.document.display).toEqual({ theme: "dark" });
    expect(store.document.ai).toEqual({ provider: "deepseek" });
  });

  it("falls back to create when the row disappears mid-conflict", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    store.hooks.updateMany = (n) => {
      if (n === 0) store.row = null; // concurrent delete
    };
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result.success).toBe(true);
    expect(store.counts.create).toBe(1);
    expect(store.document.display).toEqual({ theme: "dark" });
  });

  it("rejects invalid patches with zero database writes", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    for (const bad of [
      { display: { theme: "neon" } },
      { unregistered: { a: 1 } },
      "not-an-object",
      JSON.parse('{"careerProfile":{"__proto__":{"x":1}}}'),
    ]) {
      const result = await patchUserSettings("user-1", bad, store);
      expect(result).toMatchObject({ success: false, code: SETTINGS_INVALID });
    }
    expect(store.counts).toEqual({ findUnique: 0, updateMany: 0, create: 0 });
  });

  it("a no-op patch echoes the stored document without writing", async () => {
    const store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"dark"}}',
    );
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result.success).toBe(true);
    expect(store.counts.updateMany).toBe(0);
    expect(store.counts.create).toBe(0);
  });
});

describe("userSettings.actions over the CAS primitive", () => {
  beforeEach(() => {
    harness.store = new ControllableStore(null);
    harness.user = { id: "user-1" };
  });

  it("updateDisplaySettings echoes the persisted document", async () => {
    const result = await updateDisplaySettings({ theme: "dark" });
    expect(result.success).toBe(true);
    expect(result.data.userId).toBe("user-1");
    expect(result.data.settings.display.theme).toBe("dark");
    // Create materializes the same defaults the old upsert did.
    expect(harness.store.document.ai).toEqual({ provider: "ollama" });
  });

  it("updateInterviewAiSettings stores the normalized pair; clear removes it", async () => {
    const set = await updateInterviewAiSettings({
      provider: " openai ",
      model: " gpt-4o ",
    });
    expect(set.success).toBe(true);
    let ai = harness.store.document.ai as Record<string, unknown>;
    expect(ai.interview).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(ai.provider).toBe("ollama");

    const cleared = await clearInterviewAiSettings();
    expect(cleared.success).toBe(true);
    ai = harness.store.document.ai as Record<string, unknown>;
    expect("interview" in ai).toBe(false);
    expect(ai.provider).toBe("ollama");
    expect(harness.store.document.display).toEqual({ theme: "system" });
  });

  it("updateInterviewAiSettings rejects incomplete pairs before any write", async () => {
    const result = await updateInterviewAiSettings({
      provider: "",
      model: "",
    });
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("required");
    expect(harness.store.counts.updateMany).toBe(0);
    expect(harness.store.counts.create).toBe(0);
  });

  it("maps exhausted CAS retries to SETTINGS_CONFLICT", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    harness.store.hooks.updateMany = (n) => {
      harness.store.row = {
        settings: JSON.stringify({ display: { theme: "light" }, race: n }),
      };
    };
    const result = await updateDisplaySettings({ theme: "dark" });
    expect(result).toMatchObject({
      success: false,
      code: SETTINGS_CONFLICT,
    });
    expect(result.data).toBeUndefined();
    expect(harness.store.counts.updateMany).toBe(
      USER_SETTINGS_CAS_MAX_RETRIES + 1,
    );
  });

  it("non-conflict persistence failures stay honest via handleError", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    harness.store.failAt.updateMany = {
      0: new Error("database unavailable"),
    };
    const result = await updateDisplaySettings({ theme: "dark" });
    expect(result.success).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.message).toBe("database unavailable");
    expect(harness.store.counts.updateMany).toBe(1);
  });

  it("rejects an invalid theme with SETTINGS_INVALID and zero writes", async () => {
    const result = await updateDisplaySettings({ theme: "neon" } as never);
    expect(result).toMatchObject({ success: false, code: SETTINGS_INVALID });
    expect(harness.store.counts.updateMany).toBe(0);
    expect(harness.store.counts.create).toBe(0);
  });

  it("fails honestly when unauthenticated", async () => {
    harness.user = null;
    const result = await updateDisplaySettings({ theme: "dark" });
    expect(result.success).toBe(false);
    expect(result.message).toBe("Not authenticated");
    expect(harness.store.counts.findUnique).toBe(0);
  });

  it("getUserSettings preserves unknown namespaces and normalizes interview", async () => {
    harness.store = new ControllableStore(
      JSON.stringify({
        ai: {
          provider: "openai",
          model: "m",
          interview: { provider: "gemini", model: "g" },
          legacyExtra: "keep",
        },
        careerProfile: { education: [{ school: "x" }] },
      }),
    );
    const result = await getUserSettings();
    expect(result.success).toBe(true);
    expect(result.data.settings.careerProfile).toEqual({
      education: [{ school: "x" }],
    });
    expect(result.data.settings.ai.legacyExtra).toBe("keep");
    expect(result.data.settings.ai.interview).toEqual({
      provider: "gemini",
      model: "g",
    });
    // Missing display falls back to the read-side default.
    expect(result.data.settings.display.theme).toBe("system");
  });

  it("getUserSettings returns defaults when the row is missing", async () => {
    const result = await getUserSettings();
    expect(result.data.settings.ai.provider).toBe("ollama");
    expect(result.data.settings.display.theme).toBe("system");
    expect(result.data.settings.ai.interview).toBeUndefined();
  });

  it("concurrent display + ai patches through actions do not lose updates", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    harness.store.armUpdateMany(0);

    const writerA = updateDisplaySettings({ theme: "dark" });
    await harness.store.updateManyEntry(0);

    const resultB = await updateUserSettings({
      ai: { provider: AiProvider.OPENAI, model: "gpt-4o" },
    });
    expect(resultB.success).toBe(true);

    harness.store.releaseUpdateMany(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    // The UI "saved" signal still comes from the persisted echo.
    expect(resultA.data.settings.display.theme).toBe("dark");
    expect(harness.store.document.ai).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });
});

describe("legacy stored __proto__ documents (F1)", () => {
  // Stored JSON may carry an own "__proto__" data key from legacy writes;
  // cloning must keep it as data instead of hitting the __proto__ setter.
  // Fixtures use JSON.parse so "__proto__" is a real own property - in an
  // object literal it would only set the prototype (or be ignored).

  it("preserves a scalar own __proto__ key verbatim through a CAS write", async () => {
    const store = new ControllableStore('{"a":1,"__proto__":2}');
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result.success).toBe(true);
    const doc = store.document;
    expect(doc.a).toBe(1);
    expect(Object.getOwnPropertyDescriptor(doc, "__proto__")).toMatchObject({
      value: 2,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(store.row?.settings).toContain('"__proto__":2');
    if (result.success) {
      expect(
        Object.prototype.hasOwnProperty.call(result.settings, "__proto__"),
      ).toBe(true);
      expect(Object.getPrototypeOf(result.settings)).toBe(Object.prototype);
      expect(JSON.stringify(result.settings)).toContain('"__proto__":2');
    }
  });

  it("does not let a stored __proto__ object swallow a colliding legal patch", async () => {
    harness.store = new ControllableStore(
      '{"display":{"theme":"system"},"__proto__":{"ai":{"provider":"evil"}}}',
    );
    harness.user = { id: "user-1" };
    const result = await updateUserSettings({
      ai: { provider: AiProvider.DEEPSEEK, model: undefined },
    });
    // success is only honest if the patch actually landed on the document.
    expect(result.success).toBe(true);
    const raw = harness.store.row?.settings ?? "";
    const doc = harness.store.document;
    expect(Object.keys(doc).sort()).toEqual(["__proto__", "ai", "display"]);
    expect(Object.prototype.hasOwnProperty.call(doc, "ai")).toBe(true);
    expect(doc.ai).toEqual({ provider: "deepseek" });
    expect(doc.display).toEqual({ theme: "system" });
    expect(Object.getOwnPropertyDescriptor(doc, "__proto__")?.value).toEqual({
      ai: { provider: "evil" },
    });
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(raw).toContain('"__proto__":{"ai":{"provider":"evil"}}');
    expect(raw).toContain('"ai":{"provider":"deepseek"}');
    // The echoed settings carry the update as an own field too.
    expect(result.data.settings.ai.provider).toBe("deepseek");
  });

  it("never reduces a __proto__-only stored document to {}", async () => {
    const store = new ControllableStore('{"__proto__":{"x":1}}');
    const result = await patchUserSettings(
      "user-1",
      { display: { theme: "dark" } },
      store,
    );
    expect(result.success).toBe(true);
    const raw = store.row?.settings ?? "";
    expect(raw).not.toBe("{}");
    expect(raw).toContain('"__proto__":{"x":1}');
    const doc = store.document;
    expect(doc.display).toEqual({ theme: "dark" });
    expect(Object.getOwnPropertyDescriptor(doc, "__proto__")?.value).toEqual({
      x: 1,
    });
    expect(store.counts).toEqual({ findUnique: 1, updateMany: 1, create: 0 });
  });

  it("recursively preserves nested __proto__ keys without mutating inputs", () => {
    const doc = JSON.parse(
      '{"settings":{"__proto__":{"polluted":true},"general":{"locale":"en"}},"legacy":{"__proto__":[1,2]}}',
    ) as Record<string, unknown>;
    const patch = { settings: { general: { locale: "de" } } };
    const docSnapshot = JSON.stringify(doc);
    const patchSnapshot = JSON.stringify(patch);
    const next = mergeSettingsDocument(doc, patch);
    const settings = next.settings as Record<string, unknown>;
    expect(
      Object.getOwnPropertyDescriptor(settings, "__proto__")?.value,
    ).toEqual({ polluted: true });
    expect(settings.general).toEqual({ locale: "de" });
    const legacy = next.legacy as Record<string, unknown>;
    expect(
      Object.getOwnPropertyDescriptor(legacy, "__proto__")?.value,
    ).toEqual([1, 2]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
    expect(JSON.stringify(doc)).toBe(docSnapshot);
    expect(JSON.stringify(patch)).toBe(patchSnapshot);
  });

  it("still rejects pollution keys in new patches at any depth with zero writes", async () => {
    const store = new ControllableStore('{"a":1,"__proto__":2}');
    for (const bad of [
      JSON.parse('{"display":{"theme":"dark"},"__proto__":{"x":1}}'),
      JSON.parse('{"ai":{"provider":"openai","__proto__":{}}}'),
      JSON.parse('{"settings":{"list":[{"constructor":{"x":1}}]}}'),
      JSON.parse('{"careerProfile":{"deep":{"prototype":1}}}'),
    ]) {
      const result = await patchUserSettings("user-1", bad, store);
      expect(result).toMatchObject({ success: false, code: SETTINGS_INVALID });
    }
    expect(store.counts).toEqual({ findUnique: 0, updateMany: 0, create: 0 });
    // The stored legacy document is left byte-for-byte intact.
    expect(store.row?.settings).toBe('{"a":1,"__proto__":2}');
  });
});
