// @vitest-environment node
/**
 * P-TZ persistence acceptance on an isolated SQLite database.
 *
 * The @/lib/db mock delegates to a swappable PrismaClient, so "app exit
 * and reopen" is exercised as a real disconnect + fresh connection on
 * the same database file — the durable row, not an in-memory echo, has
 * to carry the zone across.
 */
import { PrismaClient } from "@prisma/client";
import {
  makeTestDbUrl,
  pushSchema,
  seedAccount,
} from "./helpers/backupTestDb";
import { parseSettingsDocument } from "@/lib/userSettings/patch";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir, client: null as PrismaClient | null, userId: "" };
});

// Every access goes through ctx.client: the persistence spec swaps the
// client to prove a reopened connection sees the same stored document.
vi.mock("@/lib/db", () => ({
  default: {
    get userSettings() {
      if (!ctx.client) throw new Error("test client not initialized");
      return ctx.client.userSettings;
    },
  },
}));

vi.mock("@/actions/shared", () => ({
  requireUser: async () => ({ id: ctx.userId }),
}));

import {
  getUserSettings,
  updateDisplaySettings,
  updateSettingsLocale,
  updateSettingsTimeZone,
} from "@/actions/userSettings.actions";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";

const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function storedDoc() {
  return ctx.client!.userSettings
    .findUnique({ where: { userId: ctx.userId } })
    .then((row) => (row ? parseSettingsDocument(row.settings) : null));
}

/** Disconnect and reopen: the DB-level half of an app restart. */
async function reopen() {
  await ctx.client!.$disconnect();
  ctx.client = new PrismaClient({ datasources: { db: { url: ctx.url } } });
}

beforeAll(async () => {
  ctx.client = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  ctx.userId = await seedAccount(ctx.client, "p-tz@example.com");
}, 180_000);

afterAll(async () => {
  await ctx.client?.$disconnect();
  try {
    const fs = await import("node:fs");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

beforeEach(async () => {
  await ctx.client!.userSettings.deleteMany();
});

describe("P-TZ isolated-database persistence", () => {
  it("persists a selected zone and serves it back through every read path", async () => {
    const write = await updateSettingsTimeZone("Asia/Shanghai");
    expect(write.success).toBe(true);
    expect(write.data.settings.settings.general.timeZone).toBe(
      "Asia/Shanghai",
    );

    // The durable row carries the zone — not just the action's echo.
    const doc = await storedDoc();
    expect(doc).toMatchObject({
      settings: { general: { timeZone: "Asia/Shanghai" } },
    });

    await expect(getUserTimeZone(ctx.userId)).resolves.toBe(
      "Asia/Shanghai",
    );
    const read = await getUserSettings();
    expect(read.data.settings.settings.general.timeZone).toBe(
      "Asia/Shanghai",
    );
  });

  it("keeps the zone across a simulated app exit and reopen", async () => {
    expect((await updateSettingsTimeZone("Asia/Tokyo")).success).toBe(true);
    await reopen();
    await expect(getUserTimeZone(ctx.userId)).resolves.toBe("Asia/Tokyo");
    const read = await getUserSettings();
    expect(read.data.settings.settings.general.timeZone).toBe("Asia/Tokyo");
  });

  it("resolves to the runtime zone when unset and never writes it back", async () => {
    await expect(getUserTimeZone(ctx.userId)).resolves.toBe(RUNTIME_ZONE);
    // Resolution is read-time only — no settings row is materialized.
    expect(await storedDoc()).toBeNull();
  });

  it("deletes the key on clear and stays deleted after reopen", async () => {
    expect((await updateSettingsTimeZone("Asia/Shanghai")).success).toBe(
      true,
    );
    expect((await updateSettingsTimeZone(undefined)).success).toBe(true);
    const doc = await storedDoc();
    const general = (doc?.settings as Record<string, unknown> | undefined)
      ?.general as Record<string, unknown> | undefined;
    expect(general === undefined || !("timeZone" in general)).toBe(true);

    await reopen();
    await expect(getUserTimeZone(ctx.userId)).resolves.toBe(RUNTIME_ZONE);
  });

  it("rejects invalid input without touching the stored document", async () => {
    expect((await updateSettingsTimeZone("Asia/Shanghai")).success).toBe(
      true,
    );
    for (const bad of ["+08:00", "CST", "", "Mars/Olympus", 42, null]) {
      const result = await updateSettingsTimeZone(bad as never);
      expect(result.success).toBe(false);
    }
    const doc = await storedDoc();
    expect(doc).toMatchObject({
      settings: { general: { timeZone: "Asia/Shanghai" } },
    });
    await expect(getUserTimeZone(ctx.userId)).resolves.toBe(
      "Asia/Shanghai",
    );
  });

  it("survives a hand-edited dirty zone by falling back instead of crashing", async () => {
    expect((await updateSettingsTimeZone("Asia/Shanghai")).success).toBe(
      true,
    );
    // Simulate a hand-edited/restored document no writer produced.
    await ctx.client!.userSettings.update({
      where: { userId: ctx.userId },
      data: {
        settings: JSON.stringify({
          settings: { general: { timeZone: "+08:00" } },
        }),
      },
    });
    await expect(getUserTimeZone(ctx.userId)).resolves.toBe(RUNTIME_ZONE);
    const read = await getUserSettings();
    expect(read.success).toBe(true);
    // getUserSettings passes the document through verbatim; readers apply
    // the unset fallback, the surface stays honest about what is stored.
    expect(read.data.settings.settings.general.timeZone).toBe("+08:00");
  });

  it("keeps locale and display settings intact across timeZone writes", async () => {
    expect((await updateSettingsLocale("en")).success).toBe(true);
    expect(
      (await updateDisplaySettings({ theme: "dark" })).success,
    ).toBe(true);
    expect((await updateSettingsTimeZone("Europe/Berlin")).success).toBe(
      true,
    );

    const doc = await storedDoc();
    expect(doc).toMatchObject({
      display: { theme: "dark" },
      settings: {
        general: { locale: "en", timeZone: "Europe/Berlin" },
      },
    });

    await reopen();
    const read = await getUserSettings();
    expect(read.data.settings.settings.general).toEqual({
      locale: "en",
      timeZone: "Europe/Berlin",
    });
    expect(read.data.settings.display.theme).toBe("dark");
  });
});
