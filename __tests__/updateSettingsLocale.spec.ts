import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_CONFLICT,
  USER_SETTINGS_CAS_MAX_RETRIES,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";

/**
 * Same deterministic CAS harness as userSettingsAtomicPatch.spec.ts: an
 * in-memory row behind the prisma-facing store contract plus deferred
 * gates, so competing writers interleave at exact points -- no random
 * delays, no probabilistic loops. Duplicated here because specs are
 * self-contained; the action under test is the SET-02 locale entry.
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
  getUserSettings,
  updateDisplaySettings,
  updateSettingsLocale,
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

  constructor(seed: string | null = null) {
    this.row = seed === null ? null : { settings: seed };
  }

  /** Gate the Nth updateMany call: signal when entered, wait for release. */
  armUpdateMany(callIndex: number): void {
    this.updateManyEntered[callIndex] = deferred();
    this.updateManyRelease[callIndex] = deferred();
  }

  updateManyEntry(callIndex: number): Promise<void> {
    return this.updateManyEntered[callIndex].promise;
  }

  releaseUpdateMany(callIndex: number): void {
    this.updateManyRelease[callIndex]?.resolve();
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

describe("updateSettingsLocale", () => {
  beforeEach(() => {
    harness.store = new ControllableStore(null);
    harness.user = { id: "user-1" };
  });

  it("persists zh-CN through the atomic patch path", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    const result = await updateSettingsLocale("zh-CN");
    expect(result.success).toBe(true);
    expect(result.data.userId).toBe("user-1");
    expect(result.data.settings.settings.general.locale).toBe("zh-CN");
    expect(harness.store.document).toMatchObject({
      ai: { provider: "ollama", model: "llama" },
      display: { theme: "system" },
      settings: { general: { locale: "zh-CN" } },
    });
    // Exactly one CAS write; no read-modify-write upsert pair.
    expect(harness.store.counts).toEqual({
      findUnique: 1,
      updateMany: 1,
      create: 0,
    });
  });

  it("persists en through the atomic patch path", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"dark"}}',
    );
    const result = await updateSettingsLocale("en");
    expect(result.success).toBe(true);
    expect(result.data.settings.settings.general.locale).toBe("en");
    expect(harness.store.document).toMatchObject({
      display: { theme: "dark" },
      settings: { general: { locale: "en" } },
    });
  });

  it("delegates to settings.general.locale in a single CAS write", async () => {
    const seed =
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}';
    harness.store = new ControllableStore(seed);
    const result = await updateSettingsLocale("en");
    expect(result.success).toBe(true);
    expect(harness.store.updateManyArgs).toHaveLength(1);
    const args = harness.store.updateManyArgs[0];
    // The CAS token is the exact document string that was read.
    expect(args.where.settings).toBe(seed);
    expect(args.where.userId).toBe("user-1");
    const written = JSON.parse(args.data.settings) as Record<string, unknown>;
    const ns = written.settings as Record<string, unknown>;
    const general = ns.general as Record<string, unknown>;
    expect(general.locale).toBe("en");
    // Only settings.general.locale was added; every prior key survived.
    expect(written.ai).toEqual({ provider: "ollama" });
    expect(written.display).toEqual({ theme: "system" });
  });

  it("rejects invalid locales honestly with zero database writes", async () => {
    for (const bad of [
      null,
      undefined,
      "",
      "fr",
      "zh",
      "zh-cn",
      "EN",
      " en ",
      42,
      true,
      {},
      [],
      ["en"],
    ]) {
      const result = await updateSettingsLocale(bad as never);
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.message).toBe("Locale must be zh-CN or en.");
    }
    // Rejection precedes requireUser/prisma: not even a read happened.
    expect(harness.store.counts).toEqual({
      findUnique: 0,
      updateMany: 0,
      create: 0,
    });
  });

  it("maps an exhausted CAS budget to SETTINGS_CONFLICT, not a fake success", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    harness.store.hooks.updateMany = (n) => {
      harness.store.row = {
        settings: JSON.stringify({ display: { theme: "light" }, race: n }),
      };
    };
    const result = await updateSettingsLocale("en");
    expect(result).toMatchObject({
      success: false,
      code: SETTINGS_CONFLICT,
      message: "Settings changed while saving. Please retry.",
    });
    expect(result.data).toBeUndefined();
    expect(harness.store.counts.updateMany).toBe(
      USER_SETTINGS_CAS_MAX_RETRIES + 1,
    );
    // The rejected intent never landed: no locale was persisted.
    expect(harness.store.document.settings).toBeUndefined();
  });

  it("surfaces persistence failures via handleError, not a fake success", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    harness.store.failAt.updateMany = {
      0: new Error("database unavailable"),
    };
    const result = await updateSettingsLocale("zh-CN");
    expect(result.success).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.message).toBe("database unavailable");
    expect(result.data).toBeUndefined();
    expect(harness.store.counts.updateMany).toBe(1);
    expect(harness.store.document.settings).toBeUndefined();
  });

  it("fails honestly when unauthenticated", async () => {
    harness.user = null;
    const result = await updateSettingsLocale("en");
    expect(result.success).toBe(false);
    expect(result.message).toBe("Not authenticated");
    expect(harness.store.counts.findUnique).toBe(0);
  });
  it("preserves ai, display, careerProfile and sibling settings.* fields", async () => {
    harness.store = new ControllableStore(
      JSON.stringify({
        ai: {
          provider: "openai",
          model: "gpt-4o",
          interview: { provider: "gemini", model: "g-2" },
        },
        display: { theme: "dark" },
        careerProfile: { education: [{ school: "x" }] },
        settings: { experimental: { flag: true } },
        futureNs: { deep: { keep: [1, 2] } },
      }),
    );
    const result = await updateSettingsLocale("en");
    expect(result.success).toBe(true);
    expect(harness.store.document).toEqual({
      ai: {
        provider: "openai",
        model: "gpt-4o",
        interview: { provider: "gemini", model: "g-2" },
      },
      display: { theme: "dark" },
      careerProfile: { education: [{ school: "x" }] },
      settings: {
        experimental: { flag: true },
        general: { locale: "en" },
      },
      futureNs: { deep: { keep: [1, 2] } },
    });
  });

  it("coexists with sequential display.theme writes without losing either", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    expect((await updateSettingsLocale("zh-CN")).success).toBe(true);
    expect(
      (await updateDisplaySettings({ theme: "dark" })).success,
    ).toBe(true);
    expect(harness.store.document).toMatchObject({
      display: { theme: "dark" },
      settings: { general: { locale: "zh-CN" } },
    });
  });

  it("re-merges onto a winning display.theme write after a CAS conflict", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    harness.store.armUpdateMany(0);

    // The locale write reads the row, then stalls inside its first CAS.
    const writerA = updateSettingsLocale("en");
    await harness.store.updateManyEntry(0);

    // The theme write completes a full read-merge-CAS cycle first.
    const resultB = await updateDisplaySettings({ theme: "dark" });
    expect(resultB.success).toBe(true);

    // First CAS misses (count=0) -> re-reads the winning document,
    // re-merges the locale patch onto it, second CAS (ungated) succeeds.
    harness.store.releaseUpdateMany(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    expect(harness.store.counts.updateMany).toBe(3); // locale x2 + theme x1
    expect(harness.store.document).toMatchObject({
      ai: { provider: "ollama", model: "llama" },
      display: { theme: "dark" },
      settings: { general: { locale: "en" } },
    });
    // Echo semantics: the caller sees the persisted document, including
    // the winning theme write.
    expect(resultA.data.settings.display.theme).toBe("dark");
    expect(resultA.data.settings.settings.general.locale).toBe("en");
  });

  it("re-setting the same locale is a no-op that preserves other fields", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"dark"},"settings":{"general":{"locale":"en"},"experimental":{"x":1}}}',
    );
    const result = await updateSettingsLocale("en");
    expect(result.success).toBe(true);
    // Identical merged document -> echo without touching the row.
    expect(harness.store.counts.findUnique).toBe(1);
    expect(harness.store.counts.updateMany).toBe(0);
    expect(harness.store.counts.create).toBe(0);
    expect(harness.store.document).toEqual({
      ai: { provider: "ollama" },
      display: { theme: "dark" },
      settings: { general: { locale: "en" }, experimental: { x: 1 } },
    });
  });

  it("repeating a persisted locale write keeps every field intact", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"dark"}}',
    );
    expect((await updateSettingsLocale("en")).success).toBe(true);
    expect(harness.store.counts.updateMany).toBe(1);
    // Second identical write short-circuits on the unchanged document.
    expect((await updateSettingsLocale("en")).success).toBe(true);
    expect(harness.store.counts.updateMany).toBe(1);
    expect(harness.store.document).toEqual({
      ai: { provider: "ollama" },
      display: { theme: "dark" },
      settings: { general: { locale: "en" } },
    });
  });

  it("keeps the established action contract: echo + getUserSettings passthrough", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"},"settings":{"general":{"locale":"en"}}}',
    );
    const echo = await updateSettingsLocale("en");
    expect(echo).toMatchObject({
      success: true,
      data: { userId: "user-1" },
    });
    const read = await getUserSettings();
    expect(read.success).toBe(true);
    // The read surface SET-02 consumes: data.settings.settings.general.locale
    expect(read.data.settings.settings.general.locale).toBe("en");
    expect(read.data.settings.display.theme).toBe("system");
    expect(read.data.settings.ai.provider).toBe("ollama");
  });
});