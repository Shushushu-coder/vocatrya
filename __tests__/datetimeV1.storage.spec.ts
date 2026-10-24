// @vitest-environment node
/**
 * Storage-behavior probe on a SYNTHETIC disposable SQLite database.
 * No real user database is read or written. The point is to record exactly
 * what Prisma writes into DATETIME columns and how legacy-shaped raw values
 * read back — evidence for the DateTime V1 matrix and contract.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import {
  makeTestDbUrl,
  pushSchema,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const dbFile = ctx.url.slice("file:".length);

let userId: string;

beforeAll(async () => {
  pushSchema(ctx.url);
  userId = await seedAccount(prisma, `dtv1-${Date.now()}@example.com`);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

describe("Prisma/SQLite DATETIME wire format (observed)", () => {
  it("records the exact text Prisma writes and reads back", async () => {
    const due = new Date("2026-10-25T14:30:00.000Z");
    const task = await prisma.task.create({
      data: { userId, title: "probe", dueDate: due },
    });

    // Raw file inspection via node:sqlite bypasses Prisma's type coercion.
    const raw = new DatabaseSync(dbFile);
    try {
      const row = raw
        .prepare(`SELECT "dueDate", typeof("dueDate") AS t FROM "Task" WHERE id = ?`)
        .get(task.id) as { dueDate: unknown; t: string };
      console.log("PRISMA_STORED_DUE_DATE_RAW", JSON.stringify(row));
      // Observed on this baseline: Prisma writes DATETIME as INTEGER epoch
      // milliseconds (UTC instant), not text.
      expect(row.t).toBe("integer");
      expect(row.dueDate).toBe(Date.parse("2026-10-25T14:30:00.000Z"));
    } finally {
      raw.close();
    }

    const readBack = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(readBack.dueDate?.toISOString()).toBe("2026-10-25T14:30:00.000Z");
  });

  it("probes how legacy-shaped raw values read back through Prisma", async () => {
    const shapes: Record<string, string | number> = {
      isoZ: "2026-10-25T14:30:00.000Z",
      isoSpaceUtc: "2026-10-25 14:30:00",
      isoSpaceOffset: "2026-10-25 14:30:00 +08:00",
      bareDateOnly: "2026-10-25",
      epochMillis: 1792938600000, // 2026-10-25T14:30:00.000Z
      epochSeconds: 1792938600,
    };
    const observations: Record<string, unknown> = {};
    for (const [label, raw] of Object.entries(shapes)) {
      const id = `probe-${label}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","userId","title","dueDate","createdAt","updatedAt")
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        label,
        raw,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      let observed: unknown;
      try {
        const found = await prisma.task.findUniqueOrThrow({ where: { id } });
        observed = {
          ok: true,
          iso:
            found.dueDate instanceof Date && !Number.isNaN(found.dueDate.getTime())
              ? found.dueDate.toISOString()
              : String(found.dueDate),
        };
      } catch (e) {
        observed = { ok: false, error: String(e).slice(0, 300) };
      }
      observations[label] = observed;
      console.log(`LEGACY_SHAPE_${label}`, JSON.stringify(observed));
    }
    console.log("LEGACY_SHAPE_ALL", JSON.stringify(observations));
    // Canonical storage: INTEGER epoch milliseconds.
    expect(observations.epochMillis).toEqual({
      ok: true,
      iso: "2026-10-25T14:30:00.000Z",
    });
    // Integer is milliseconds — a seconds magnitude lands in 1970.
    expect(observations.epochSeconds).toEqual({
      ok: true,
      iso: new Date(1792938600).toISOString(),
    });
    expect((observations.epochSeconds as { iso: string }).iso).toMatch(/^1970-/);
    // ISO text forms observed readable: full ISO-Z and space-separated UTC.
    expect(observations.isoZ).toEqual({
      ok: true,
      iso: "2026-10-25T14:30:00.000Z",
    });
    expect(observations.isoSpaceUtc).toEqual({
      ok: true,
      iso: "2026-10-25T14:30:00.000Z",
    });
    // Bare YYYY-MM-DD and offset-suffixed text FAIL the row read entirely:
    // a DateOnly string cannot live inside a Prisma DATETIME column.
    expect(observations.bareDateOnly).toMatchObject({ ok: false });
    expect(observations.isoSpaceOffset).toMatchObject({ ok: false });
  });
});
