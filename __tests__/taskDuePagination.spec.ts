// @vitest-environment node
//
// P-TASK due-mix pagination acceptance (contract §5.4):
// 5,000 synthetic tasks on an isolated SQLite file — ~60% dateOnly, ~30%
// instant, ~10% NULL — paged 25/page over 200 pages. Verifies the two-pass
// read contract: the WHOLE matching set is sorted by the §5.2 key
// (instant → itself; dateOnly → account-zone endIsoExclusive; NULL last;
// ties → priority desc → id asc) BEFORE the page slice is hydrated.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const c = helpers.makeTestDbUrl();
  helpers.pushSchema(c.url);
  return c;
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/db";
import { getCurrentUser } from "@/utils/user.utils";
import { createTask, getTasksList, updateTask } from "@/actions/task.actions";
import { dateOnlyUtcWindow } from "@/lib/datetime";
import type { TaskStatus } from "@/models/task.model";

const ACCOUNT_TZ = "Asia/Shanghai";
const PAGE_SIZE = 25;
const TOTAL = 5000;
const TOTAL_PAGES = TOTAL / PAGE_SIZE; // 200

// Pinned cluster: ≥200 rows sharing one sort key, straddling many page
// boundaries; 20 instants land on the very same key to tie across kinds.
const CLUSTER_DAY = "2026-06-15";
const CLUSTER_INSTANT_ISO = dateOnlyUtcWindow(CLUSTER_DAY, ACCOUNT_TZ)
  .endIsoExclusive;

// Deterministic RNG → reproducible dataset across runs.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eed);

function randomDateOnly(): string {
  // Uniform day in [2025-01-01, 2027-12-31] in the account zone.
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2027, 11, 31);
  const t = new Date(start + rand() * (end - start));
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function randomInstant(): Date {
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2027, 11, 31);
  return new Date(start + Math.floor(rand() * (end - start)));
}

const STATUSES = [
  "in-progress",
  "complete",
  "needs-attention",
  "cancelled",
] as const;

type SortRow = {
  id: string;
  status: string;
  dueOn: string | null;
  dueDate: Date | null;
  duePrecision: string | null;
  priority: number;
};

// Independent oracle for the §5.2 key — re-derived here (not imported from
// the implementation) so the spec fails if the contract mapping drifts.
function oracleKeyMs(row: SortRow): number | null {
  if (row.duePrecision === "dateOnly" && row.dueOn != null) {
    return Date.parse(dateOnlyUtcWindow(row.dueOn, ACCOUNT_TZ).endIsoExclusive);
  }
  if (row.dueDate != null) return row.dueDate.getTime();
  return null;
}
function oracleOrder(rows: SortRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const ka = oracleKeyMs(a);
      const kb = oracleKeyMs(b);
      if (ka !== kb) {
        if (ka === null) return 1;
        if (kb === null) return -1;
        return ka - kb;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((r) => r.id);
}

let userId = "";
const seedRows: SortRow[] = [];

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { id: randomUUID(), name: "W2 Task", email: "w2-task@test.dev", password: "x" },
  });
  userId = user.id;
  (getCurrentUser as any).mockResolvedValue(user);

  await prisma.userSettings.create({
    data: {
      userId,
      settings: JSON.stringify({
        settings: { general: { timeZone: ACCOUNT_TZ } },
      }),
    },
  });

  const rows: Array<Record<string, unknown>> = [];
  const push = (due: {
    dueOn?: string;
    dueDate?: Date;
    duePrecision?: string;
  }) => {
    const row = {
      id: randomUUID(),
      userId,
      title: `task-${rows.length}`,
      status: STATUSES[rows.length % STATUSES.length],
      priority: Math.floor(rand() * 10),
      dueOn: due.dueOn ?? null,
      dueDate: due.dueDate ?? null,
      duePrecision: due.duePrecision ?? null,
    };
    rows.push(row);
    seedRows.push({
      id: row.id,
      status: row.status,
      dueOn: row.dueOn,
      dueDate: row.dueDate,
      duePrecision: row.duePrecision,
      priority: row.priority,
    });
  };

  // ~60% dateOnly, incl. the pinned 220-row same-key cluster.
  for (let i = 0; i < 2780; i++) {
    push({ dueOn: randomDateOnly(), duePrecision: "dateOnly" });
  }
  for (let i = 0; i < 220; i++) {
    push({ dueOn: CLUSTER_DAY, duePrecision: "dateOnly" });
  }
  // ~30% instants — mixed declared precision + legacy NULL (unknown);
  // 20 pinned exactly on the cluster key.
  const precisions = ["minute", "fullInstant", null] as const;
  for (let i = 0; i < 1480; i++) {
    push({
      dueDate: randomInstant(),
      duePrecision: precisions[i % precisions.length] ?? undefined,
    });
  }
  for (let i = 0; i < 20; i++) {
    push({ dueDate: new Date(CLUSTER_INSTANT_ISO) });
  }
  // ~10% NULL due.
  for (let i = 0; i < 500; i++) push({});

  expect(rows.length).toBe(TOTAL);
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.task.createMany({ data: rows.slice(i, i + 500) as any });
  }
  expect(await prisma.task.count({ where: { userId } })).toBe(TOTAL);
}, 120_000);

async function fetchPageIds(page: number, statusFilter?: TaskStatus[]) {
  const res = await getTasksList(
    page,
    PAGE_SIZE,
    undefined,
    statusFilter,
    undefined,
    "dueDate",
  );
  expect(res.success).toBe(true);
  return res;
}

describe("§5.4 — 5,000-row mixed-due pagination", () => {
  it("envelope: account zone, page size and full-match total", async () => {
    const res = await fetchPageIds(1);
    expect(res.timeZone).toBe(ACCOUNT_TZ);
    expect(res.total).toBe(TOTAL);
    expect(res.data).toHaveLength(PAGE_SIZE);
    // Hydrated rows carry the DTO's full fields, not just sort fields.
    expect(res.data[0]).toHaveProperty("title");
    expect(res.data[0]).toHaveProperty("dueOn");
    expect(res.data[0]).toHaveProperty("duePrecision");
    expect(res.data[0]).toHaveProperty("dueDate");
  });

  it(
    "200 pages → exact id set, exact §5.2 order, NULL tail, no gaps/dupes",
    async () => {
      const seen = new Map<string, number>();
      const flattened: string[] = [];
      const pageMs: number[] = [];

      for (let page = 1; page <= TOTAL_PAGES; page++) {
        const t0 = performance.now();
        const res = await fetchPageIds(page);
        pageMs.push(performance.now() - t0);
        expect(res.data).toHaveLength(PAGE_SIZE);
        for (const row of res.data) {
          flattened.push(row.id);
          seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
        }
      }

      // No duplicates, no misses: every seeded id appears exactly once.
      expect(flattened).toHaveLength(TOTAL);
      const dupes = [...seen.entries()].filter(([, n]) => n !== 1);
      expect(dupes).toEqual([]);
      expect(new Set(flattened)).toEqual(new Set(seedRows.map((r) => r.id)));

      // The whole sequence equals the §5.2 total order of the full set.
      expect(flattened).toEqual(oracleOrder(seedRows));

      // NULL-due rows form a strict tail.
      const nullIds = new Set(
        seedRows
          .filter((r) => r.dueOn == null && r.dueDate == null)
          .map((r) => r.id),
      );
      expect(nullIds.size).toBe(500);
      const tail = flattened.slice(TOTAL - nullIds.size);
      expect(new Set(tail)).toEqual(nullIds);
      expect(flattened.slice(0, TOTAL - nullIds.size).some((id) => nullIds.has(id))).toBe(
        false,
      );

      // Same-key cluster stayed internally ordered: priority desc, id asc.
      // ≥240 rows (220 pinned dateOnly + 20 pinned instants + any random
      // dateOnly rows that happened to land on the cluster day).
      const clusterIds = oracleOrder(
        seedRows.filter(
          (r) => oracleKeyMs(r) === Date.parse(CLUSTER_INSTANT_ISO),
        ),
      );
      expect(clusterIds.length).toBeGreaterThanOrEqual(220 + 20);
      const clusterSlice = clusterIds.map((id) => flattened.indexOf(id));
      for (let i = 1; i < clusterSlice.length; i++) {
        expect(clusterSlice[i]).toBeGreaterThan(clusterSlice[i - 1]);
      }

      const avg = pageMs.reduce((a, b) => a + b, 0) / pageMs.length;
      const max = Math.max(...pageMs);
      // Reference budget is ≤300ms/page; record actuals, assert a generous
      // CI-safe ceiling only (perf assertion must not flake on slow agents).
      console.log(
        `[5k pagination] pages=${TOTAL_PAGES} avg=${avg.toFixed(1)}ms max=${max.toFixed(1)}ms per page`,
      );
      expect(max).toBeLessThan(5000);
      expect(avg).toBeLessThan(3000);
    },
    300_000,
  );

  it("deterministic: repeated pages return identical sequences", async () => {
    for (const page of [1, 100, 200]) {
      const a = (await fetchPageIds(page)).data.map((r: any) => r.id);
      const b = (await fetchPageIds(page)).data.map((r: any) => r.id);
      expect(a).toEqual(b);
    }
  });

  it("filtered view keeps the same total order over the matching subset", async () => {
    const res = await fetchPageIds(1, ["in-progress"]);
    const filtered = seedRows.filter((r) => r.status === "in-progress");
    expect(res.total).toBe(filtered.length);
    expect(res.data.map((r: any) => r.id)).toEqual(
      oracleOrder(filtered).slice(0, PAGE_SIZE),
    );
  });
});

describe("§5.2 example — kind mixing on one boundary", () => {
  const MIX_PREFIX = "w2xmix";
  let t1 = "";
  let t2 = "";
  let t3 = "";
  let t4 = "";

  beforeAll(async () => {
    // T1 instant 10:00 local, T2 dateOnly same day (key = local day end),
    // T3 instant 08:30 next day, T4 NULL. A unique title prefix lets search
    // isolate exactly these four out of the 5k set.
    const mk = async (due: {
      dueOn?: string;
      dueDate?: Date;
      duePrecision?: string;
    }) => {
      const id = randomUUID();
      await prisma.task.create({
        data: {
          id,
          userId,
          title: `${MIX_PREFIX}-${id.slice(0, 8)}`,
          dueOn: due.dueOn ?? null,
          dueDate: due.dueDate ?? null,
          duePrecision: due.duePrecision ?? null,
        },
      });
      return id;
    };
    t1 = await mk({ dueDate: new Date("2026-10-25T02:00:00.000Z") });
    t2 = await mk({ dueOn: "2026-10-25", duePrecision: "dateOnly" });
    t3 = await mk({ dueDate: new Date("2026-10-26T00:30:00.000Z") });
    t4 = await mk({});
  });

  it("instant < dateOnly-day-end < next instant < NULL", async () => {
    const res = await getTasksList(
      1,
      PAGE_SIZE,
      undefined,
      undefined,
      MIX_PREFIX,
      "dueDate",
    );
    expect(res.success).toBe(true);
    expect(res.total).toBe(4);
    expect(res.data.map((r: any) => r.id)).toEqual([t1, t2, t3, t4]);
  });
});

describe("write path on the isolated DB", () => {
  it("createTask persists dueOn + dateOnly and leaves dueDate NULL", async () => {
    const res = await createTask({
      title: "W2 created",
      status: "in-progress",
      priority: 5,
      percentComplete: 0,
      dueOn: "2027-01-15",
      activityTypeId: null,
    });
    expect(res.success).toBe(true);
    const row = await prisma.task.findUnique({ where: { id: res.data.id } });
    expect(row).toMatchObject({
      dueOn: "2027-01-15",
      duePrecision: "dateOnly",
      dueDate: null,
    });
  });

  it("updateTask without dueOn preserves a historical instant", async () => {
    const id = randomUUID();
    const instant = new Date("2026-03-03T04:05:00.000Z");
    await prisma.task.create({
      data: { id, userId, title: "legacy", dueDate: instant },
    });
    const res = await updateTask({
      id,
      title: "legacy renamed",
      status: "in-progress",
      priority: 5,
      percentComplete: 0,
      activityTypeId: null,
    });
    expect(res.success).toBe(true);
    const row = await prisma.task.findUnique({ where: { id } });
    expect(row).toMatchObject({
      dueOn: null,
      duePrecision: null,
      dueDate: instant,
    });
  });

  it("updateTask dueOn: null clears all three due columns", async () => {
    const id = randomUUID();
    await prisma.task.create({
      data: { id, userId, title: "legacy", dueDate: new Date("2026-03-03T04:05:00.000Z") },
    });
    const res = await updateTask({
      id,
      title: "legacy cleared",
      status: "in-progress",
      priority: 5,
      percentComplete: 0,
      dueOn: null,
      activityTypeId: null,
    });
    expect(res.success).toBe(true);
    const row = await prisma.task.findUnique({ where: { id } });
    expect(row).toMatchObject({ dueOn: null, duePrecision: null, dueDate: null });
  });

  it("rejects a past dueOn against the account zone", async () => {
    const res = await createTask({
      title: "past due",
      status: "in-progress",
      priority: 5,
      percentComplete: 0,
      dueOn: "2020-01-01",
      activityTypeId: null,
    });
    expect(res.success).toBe(false);
    expect(res.message).toBe("Due date cannot be in the past.");
  });

  it("rejects malformed dueOn text at the schema boundary", async () => {
    const res = await createTask({
      title: "bad due",
      status: "in-progress",
      priority: 5,
      percentComplete: 0,
      dueOn: "15/03/2027",
      activityTypeId: null,
    });
    expect(res.success).toBe(false);
  });
});
