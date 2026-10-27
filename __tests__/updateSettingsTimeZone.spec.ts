import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_CONFLICT,
  USER_SETTINGS_CAS_MAX_RETRIES,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";

/**
 * Same deterministic CAS harness as updateSettingsLocale.spec.ts: an
 * in-memory row behind the prisma-facing store contract plus deferred
 * gates, so competing writers interleave at exact points -- no random
 * delays, no probabilistic loops. Duplicated here because specs are
 * self-contained; the action under test is the P-TZ timeZone entry.
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
  updateSettingsTimeZone,
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

describe("updateSettingsTimeZone", () => {
  beforeEach(() => {
    harness.store = new ControllableStore(null);
    harness.user = { id: "user-1" };
  });

  it("persists a canonical IANA zone through the atomic patch path", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    const result = await updateSettingsTimeZone("Asia/Shanghai");
    expect(result.success).toBe(true);
    expect(result.data.userId).toBe("user-1");
    expect(result.data.settings.settings.general.timeZone).toBe(
      "Asia/Shanghai",
    );
    expect(harness.store.document).toMatchObject({
      ai: { provider: "ollama", model: "llama" },
      display: { theme: "system" },
      settings: { general: { timeZone: "Asia/Shanghai" } },
    });
    // Exactly one CAS write; no read-modify-write upsert pair.
    expect(harness.store.counts).toEqual({
      findUnique: 1,
      updateMany: 1,
      create: 0,
    });
  });

  it("delegates to settings.general.timeZone in a single CAS write", async () => {
    const seed =
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}';
    harness.store = new ControllableStore(seed);
    const result = await updateSettingsTimeZone("Europe/Berlin");
    expect(result.success).toBe(true);
    expect(harness.store.updateManyArgs).toHaveLength(1);
    const args = harness.store.updateManyArgs[0];
    // The CAS token is the exact document string that was read.
    expect(args.where.settings).toBe(seed);
    const written = JSON.parse(args.data.settings) as Record<string, unknown>;
    const ns = written.settings as Record<string, unknown>;
    expect((ns.general as Record<string, unknown>).timeZone).toBe(
      "Europe/Berlin",
    );
    expect(written.ai).toEqual({ provider: "ollama" });
    expect(written.display).toEqual({ theme: "system" });
  });

  it("rejects non-IANA input honestly with zero database writes", async () => {
    for (const bad of [
      "CST",
      "PST",
      "+08:00",
      "-05:00",
      "GMT",
      "zulu",
      "Hongkong",
      "PRC",
      "",
      " Asia/Shanghai",
      "Mars/Olympus",
      "8",
      null,
      42,
      true,
      {},
      [],
    ]) {
      const result = await updateSettingsTimeZone(bad as never);
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.message).toBe(
        "Time zone must be a valid IANA time zone.",
      );
    }
    // Rejection precedes requireUser/prisma: not even a read happened.
    expect(harness.store.counts).toEqual({
      findUnique: 0,
      updateMany: 0,
      create: 0,
    });
  });

  it("leaves the stored value untouched when rejecting invalid input", async () => {
    harness.store = new ControllableStore(
      '{"settings":{"general":{"timeZone":"Asia/Shanghai","locale":"zh-CN"}}}',
    );
    const result = await updateSettingsTimeZone("+08:00");
    expect(result.success).toBe(false);
    expect(harness.store.document).toEqual({
      settings: {
        general: { timeZone: "Asia/Shanghai", locale: "zh-CN" },
      },
    });
  });

  it("clears the key on undefined — back to follow-system, no literal stored", async () => {
    harness.store = new ControllableStore(
      '{"display":{"theme":"dark"},"settings":{"general":{"timeZone":"Asia/Shanghai","locale":"en"}}}',
    );
    const result = await updateSettingsTimeZone(undefined);
    expect(result.success).toBe(true);
    const general = harness.store.document.settings as Record<string, unknown>;
    expect(
      (general.general as Record<string, unknown>).timeZone,
    ).toBeUndefined();
    // The key is deleted from the stored document — no "system" literal.
    expect(
      "timeZone" in (general.general as Record<string, unknown>),
    ).toBe(false);
    // Sibling keys survive the deletion.
    expect(harness.store.document).toMatchObject({
      display: { theme: "dark" },
      settings: { general: { locale: "en" } },
    });
  });

  it("clearing when nothing was stored writes no timeZone key", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"dark"}}',
    );
    const result = await updateSettingsTimeZone(undefined);
    expect(result.success).toBe(true);
    // The merge may materialize an empty settings.general subtree, but it
    // must never fabricate a timeZone value.
    const general = (
      harness.store.document.settings as
        | Record<string, unknown>
        | undefined
    )?.general as Record<string, unknown> | undefined;
    expect(general === undefined || !("timeZone" in general)).toBe(true);
    expect(harness.store.document.ai).toEqual({ provider: "ollama" });
    expect(harness.store.document.display).toEqual({ theme: "dark" });
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
    const result = await updateSettingsTimeZone("Asia/Shanghai");
    expect(result).toMatchObject({
      success: false,
      code: SETTINGS_CONFLICT,
      message: "Settings changed while saving. Please retry.",
    });
    expect(harness.store.counts.updateMany).toBe(
      USER_SETTINGS_CAS_MAX_RETRIES + 1,
    );
    expect(harness.store.document.settings).toBeUndefined();
  });

  it("surfaces persistence failures via handleError, not a fake success", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    harness.store.failAt.updateMany = {
      0: new Error("database unavailable"),
    };
    const result = await updateSettingsTimeZone("Asia/Shanghai");
    expect(result.success).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.message).toBe("database unavailable");
    expect(harness.store.document.settings).toBeUndefined();
  });

  it("fails honestly when unauthenticated", async () => {
    harness.user = null;
    const result = await updateSettingsTimeZone("Asia/Shanghai");
    expect(result.success).toBe(false);
    expect(result.message).toBe("Not authenticated");
    expect(harness.store.counts.findUnique).toBe(0);
  });

  it("preserves locale, ai, display and sibling keys when writing timeZone", async () => {
    harness.store = new ControllableStore(
      JSON.stringify({
        ai: {
          provider: "openai",
          model: "gpt-4o",
          interview: { provider: "gemini", model: "g-2" },
        },
        display: { theme: "dark" },
        careerProfile: { education: [{ school: "x" }] },
        settings: {
          general: { locale: "en" },
          experimental: { flag: true },
        },
      }),
    );
    const result = await updateSettingsTimeZone("America/New_York");
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
        general: { locale: "en", timeZone: "America/New_York" },
        experimental: { flag: true },
      },
    });
  });

  it("coexists with sequential locale and theme writes without losing any", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"}}',
    );
    expect((await updateSettingsTimeZone("Asia/Shanghai")).success).toBe(true);
    expect((await updateSettingsLocale("en")).success).toBe(true);
    expect(
      (await updateDisplaySettings({ theme: "dark" })).success,
    ).toBe(true);
    expect((await updateSettingsTimeZone(undefined)).success).toBe(true);
    expect(harness.store.document).toMatchObject({
      ai: { provider: "ollama" },
      display: { theme: "dark" },
      settings: { general: { locale: "en" } },
    });
    const general = (
      harness.store.document.settings as Record<string, unknown>
    ).general as Record<string, unknown>;
    expect("timeZone" in general).toBe(false);
  });

  it("re-merges onto a winning display.theme write after a CAS conflict", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama","model":"llama"},"display":{"theme":"system"}}',
    );
    harness.store.armUpdateMany(0);

    // The timeZone write reads the row, then stalls inside its first CAS.
    const writerA = updateSettingsTimeZone("Asia/Tokyo");
    await harness.store.updateManyEntry(0);

    // The theme write completes a full read-merge-CAS cycle first.
    const resultB = await updateDisplaySettings({ theme: "dark" });
    expect(resultB.success).toBe(true);

    harness.store.releaseUpdateMany(0);
    const resultA = await writerA;
    expect(resultA.success).toBe(true);
    expect(harness.store.counts.updateMany).toBe(3);
    expect(harness.store.document).toMatchObject({
      ai: { provider: "ollama", model: "llama" },
      display: { theme: "dark" },
      settings: { general: { timeZone: "Asia/Tokyo" } },
    });
    expect(resultA.data.settings.settings.general.timeZone).toBe(
      "Asia/Tokyo",
    );
  });

  it("keeps the established action contract: echo + getUserSettings passthrough", async () => {
    harness.store = new ControllableStore(
      '{"ai":{"provider":"ollama"},"display":{"theme":"system"},"settings":{"general":{"locale":"zh-CN"}}}',
    );
    const echo = await updateSettingsTimeZone("Asia/Shanghai");
    expect(echo).toMatchObject({
      success: true,
      data: { userId: "user-1" },
    });
    const read = await getUserSettings();
    expect(read.success).toBe(true);
    expect(read.data.settings.settings.general.timeZone).toBe(
      "Asia/Shanghai",
    );
    expect(read.data.settings.settings.general.locale).toBe("zh-CN");
    expect(read.data.settings.display.theme).toBe("system");
  });
});
