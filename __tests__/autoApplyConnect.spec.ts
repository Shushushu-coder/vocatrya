import { describe, expect, it } from "vitest";
import {
  AUTO_APPLY_CONNECT_ERROR,
  AUTO_APPLY_MAX_CONNECTIONS,
  AUTO_APPLY_PAIRING_TTL_MS,
  AutoApplyConnectError,
  authenticateConnection,
  buildPairedProfile,
  createPairingRequest,
  exchangePairingCode,
  listConnections,
  parseRequestedSections,
  parseSectionGrant,
  revokeConnection,
  revokeConnectionByToken,
  touchConnection,
} from "@/lib/extensions/autoApply/connect";
import { PROFILE_BACKUP_FORMAT } from "@/lib/extensions/autoApply/upstreamContract";
import type {
  AutoApplyConnectionRow,
} from "@/lib/extensions/autoApply/connect";

/**
 * In-memory stand-ins for the pairing/connection tables plus the source
 * tables `loadAutoApplySource` reads through the career services. Same
 * pattern as autoApplyExport.spec.ts: the fake is cast `as never`, and only
 * the code-under-test decides which rows it can see.
 */

function matchWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === "OR") {
      if (!(cond as unknown[]).some((clause) => matchWhere(row, clause))) {
        return false;
      }
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("not" in c && c.not === null) {
        if (value == null) return false;
        continue;
      }
      if ("lt" in c) {
        const bound = c.lt as Date;
        if (!(value instanceof Date && value.getTime() < bound.getTime())) {
          return false;
        }
        continue;
      }
    }
    if (cond === null) {
      if (value !== null) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "张三",
    headline: "后端工程师",
    email: "zhangsan@example.com",
    phone: "13800000000",
    phoneCountryCode: "+86",
    address: null,
    linksData: null,
    gender: "男",
    birthDate: "2001-03-05",
    ethnicity: "汉族",
    politicalStatus: "共青团员",
    nativePlace: "浙江省杭州市",
    householdRegistration: "浙江省杭州市",
    graduationCohort: "2026届",
    countryOrRegion: "中国",
    wechatId: "zs_wechat",
    qqNumber: null,
    currentCity: "杭州市",
    homeCity: "宁波市",
    homeAddress: null,
    updatedAt: "2026-11-10T08:00:00.000Z",
    ...overrides,
  };
}

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    targetRoles: "后端开发工程师",
    preferredCities: "杭州、上海",
    preferredIndustries: null,
    recruitmentTypes: "校园招聘",
    availability: null,
    hardConstraints: "SENTINEL-CONSTRAINTS",
    softPreferences: "SENTINEL-SOFT",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeDbOptions {
  profiles?: Map<string, unknown>;
  preference?: unknown;
  materials?: unknown[];
}

function makeFakeDb(options: FakeDbOptions = {}) {
  const pairings = new Map<string, Record<string, unknown>>();
  const connections = new Map<string, Record<string, unknown>>();
  const profiles = options.profiles ?? new Map([["user-1", profileRow()]]);

  const pairingApi = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { consumedAt: null, createdAt: new Date(), ...data };
      pairings.set(data.id as string, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      pairings.get(where.id) ?? null,
    updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of pairings.values()) {
        if (matchWhere(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      let count = 0;
      for (const [id, row] of pairings) {
        if (matchWhere(row, where)) {
          pairings.delete(id);
          count += 1;
        }
      }
      return { count };
    },
  };

  const connectionApi = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        lastSeenAt: null,
        lastSyncAt: null,
        lastProfileUpdatedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      connections.set(data.id as string, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      connections.get(where.id) ?? null,
    findMany: async ({ where, orderBy }: { where?: unknown; orderBy?: unknown[] } = {}) => {
      const rows = [...connections.values()].filter((row) =>
        matchWhere(row, where),
      );
      rows.sort((a, b) => {
        const revokedRank = (r: Record<string, unknown>) =>
          r.revokedAt ? 1 : 0;
        if (revokedRank(a) !== revokedRank(b)) {
          return revokedRank(a) - revokedRank(b);
        }
        const aTime = a.pairedAt instanceof Date ? a.pairedAt.getTime() : 0;
        const bTime = b.pairedAt instanceof Date ? b.pairedAt.getTime() : 0;
        return bTime - aTime;
      });
      return rows;
    },
    findFirst: async ({ where, orderBy }: { where?: unknown; orderBy?: Record<string, string> } = {}) => {
      const rows = [...connections.values()].filter((row) =>
        matchWhere(row, where),
      );
      if (orderBy?.lastSyncAt === "desc") {
        rows.sort((a, b) => {
          const aTime = a.lastSyncAt instanceof Date ? a.lastSyncAt.getTime() : 0;
          const bTime = b.lastSyncAt instanceof Date ? b.lastSyncAt.getTime() : 0;
          return bTime - aTime;
        });
      }
      return rows[0] ?? null;
    },
    count: async ({ where }: { where?: unknown } = {}) =>
      [...connections.values()].filter((row) => matchWhere(row, where)).length,
    updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of connections.values()) {
        if (matchWhere(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const db = {
    autoApplyExtensionPairing: pairingApi,
    autoApplyExtensionConnection: connectionApi,
    candidateProfile: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        profiles.get(where.userId) ?? null,
    },
    jobSearchPreference: {
      findUnique: async () => options.preference ?? null,
    },
    careerMaterialItem: {
      findMany: async () => options.materials ?? [],
    },
  };

  Object.assign(db, { $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db) });
  return { db, pairings, connections };
}

const NOW = new Date("2026-11-14T10:00:00.000Z");
const ORIGIN = "http://127.0.0.1:3737";

async function pairAndExchange(
  db: unknown,
  userId = "user-1",
  sections: readonly ("basic" | "education")[] = ["basic", "education"],
) {
  const { pairingString } = await createPairingRequest(
    userId,
    ORIGIN,
    [...sections],
    { db: db as never },
    NOW,
  );
  const code = new URL(pairingString).searchParams.get("code")!;
  const result = await exchangePairingCode(
    code,
    { name: "OpenJobAutofill 1.0.3" },
    { db: db as never },
    NOW,
  );
  return { pairingString, code, ...result };
}

// --- pairing ---------------------------------------------------------------

describe("pairing lifecycle", () => {
  it("creates a one-shot code embedded in the pair URI; only the hash persists", async () => {
    const { db, pairings } = makeFakeDb();
    const { pairingString, expiresAt } = await createPairingRequest(
      "user-1",
      ORIGIN,
      ["basic"],
      { db: db as never },
      NOW,
    );
    const url = new URL(pairingString);
    expect(url.protocol).toBe("vocatrya-auto-apply:");
    expect(url.hostname).toBe("pair");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("app")).toBe(ORIGIN);
    const code = url.searchParams.get("code")!;
    expect(code.startsWith("vaap.")).toBe(true);
    expect(expiresAt).toBe(
      new Date(NOW.getTime() + AUTO_APPLY_PAIRING_TTL_MS).toISOString(),
    );
    // Only the sha256 hash is stored — the plaintext code appears nowhere.
    expect(pairings.size).toBe(1);
    const stored = [...pairings.values()][0];
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.consumedAt).toBeNull();
  });

  it("rejects non-exportable or empty section grants", () => {
    expect(() => parseSectionGrant(["basic", "family"])).toThrow(
      AutoApplyConnectError,
    );
    expect(() => parseSectionGrant([])).toThrow(AutoApplyConnectError);
    expect(() => parseSectionGrant("basic")).toThrow(AutoApplyConnectError);
    expect(parseSectionGrant(["education", "basic", "basic"])).toEqual([
      "basic",
      "education",
    ]);
  });
});

describe("exchange", () => {
  it("exchanges a valid code for a bearer token; hashes only are stored", async () => {
    const { db, connections } = makeFakeDb();
    const { accessToken, connectionId, allowedSections, appName } =
      await pairAndExchange(db);
    expect(appName).toBe("Vocatrya");
    expect(accessToken.startsWith("vaac.")).toBe(true);
    expect(allowedSections).toEqual(["basic", "education"]);
    const stored = connections.get(connectionId)!;
    expect(JSON.stringify(stored)).not.toContain(accessToken);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.userId).toBe("user-1");
  });

  it("rejects a replayed code with PAIRING_CONSUMED", async () => {
    const { db } = makeFakeDb();
    const { code } = await pairAndExchange(db);
    await expect(
      exchangePairingCode(code, {}, { db: db as never }, NOW),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.PAIRING_CONSUMED,
    });
  });

  it("rejects expired, malformed and tampered codes", async () => {
    const { db } = makeFakeDb();
    const { pairingString } = await createPairingRequest(
      "user-1",
      ORIGIN,
      ["basic"],
      { db: db as never },
      NOW,
    );
    const code = new URL(pairingString).searchParams.get("code")!;
    const later = new Date(NOW.getTime() + AUTO_APPLY_PAIRING_TTL_MS + 1);
    await expect(
      exchangePairingCode(code, {}, { db: db as never }, later),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.PAIRING_EXPIRED,
    });
    await expect(
      exchangePairingCode("vaap.nonexistent.abc", {}, { db: db as never }, NOW),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID,
    });
    await expect(
      exchangePairingCode(
        `${code.slice(0, -2)}xx`,
        {},
        { db: db as never },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID,
    });
    await expect(
      exchangePairingCode("not-a-code", {}, { db: db as never }, NOW),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID,
    });
  });

  it("enforces the active-connection ceiling", async () => {
    const { db, connections } = makeFakeDb();
    for (let i = 0; i < AUTO_APPLY_MAX_CONNECTIONS; i += 1) {
      connections.set(`conn-${i}`, {
        id: `conn-${i}`,
        userId: "user-1",
        tokenHash: "x".repeat(64),
        allowedSections: "[]",
        pairedAt: NOW,
        revokedAt: null,
      });
    }
    const { pairingString } = await createPairingRequest(
      "user-1",
      ORIGIN,
      ["basic"],
      { db: db as never },
      NOW,
    );
    const code = new URL(pairingString).searchParams.get("code")!;
    await expect(
      exchangePairingCode(code, {}, { db: db as never }, NOW),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_LIMIT,
    });
  });
});

describe("bearer authentication and revoke", () => {
  it("authenticates a live token and rejects revoked/unknown ones", async () => {
    const { db } = makeFakeDb();
    const { accessToken } = await pairAndExchange(db);
    const row = await authenticateConnection(accessToken, { db: db as never });
    expect(row.userId).toBe("user-1");

    await expect(
      authenticateConnection("vaac.deadbeef.bad", { db: db as never }),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID,
    });
    await expect(
      authenticateConnection("garbage", { db: db as never }),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID,
    });
  });

  it("app-side revoke kills the token immediately", async () => {
    const { db } = makeFakeDb();
    const { accessToken, connectionId } = await pairAndExchange(db);
    const revoked = await revokeConnection("user-1", connectionId, {
      db: db as never,
    });
    expect(revoked).toBe(true);
    await expect(
      authenticateConnection(accessToken, { db: db as never }),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_REVOKED,
    });
    // Second revoke is a no-op, not an error.
    expect(
      await revokeConnection("user-1", connectionId, { db: db as never }),
    ).toBe(false);
  });

  it("is user-scoped: another user's revoke call cannot kill the token", async () => {
    const { db } = makeFakeDb();
    const { accessToken, connectionId } = await pairAndExchange(db);
    expect(
      await revokeConnection("user-2", connectionId, { db: db as never }),
    ).toBe(false);
    const row = await authenticateConnection(accessToken, { db: db as never });
    expect(row.userId).toBe("user-1");
  });

  it("plugin-side disconnect revokes its own token", async () => {
    const { db } = makeFakeDb();
    const { accessToken } = await pairAndExchange(db);
    expect(
      await revokeConnectionByToken(accessToken, { db: db as never }),
    ).toBe(true);
    await expect(
      authenticateConnection(accessToken, { db: db as never }),
    ).rejects.toMatchObject({
      code: AUTO_APPLY_CONNECT_ERROR.CONNECTION_REVOKED,
    });
  });
});

// --- on-demand profile pull -------------------------------------------------

describe("paired profile pull", () => {
  it("serves whitelisted data for granted sections only", async () => {
    const profiles = new Map([
      ["user-1", profileRow()],
      ["user-2", profileRow({ fullName: "李四", email: "lisi@example.com" })],
    ]);
    const { db } = makeFakeDb({
      profiles,
      preference: preferenceRow(),
      materials: [
        {
          id: "mat-1",
          userId: "user-1",
          type: "EDUCATION",
          title: "示例大学",
          startDate: new Date("2024-09-01T00:00:00.000Z"),
          endDate: null,
          isCurrent: true,
          notes: null,
          origin: "USER",
          verificationStatus: "USER_AUTHORED",
          archivedAt: null,
          updatedAt: "2026-11-12T09:00:00.000Z",
          educationDetail: {
            institution: "示例大学",
            degree: "硕士",
            fieldOfStudy: "软件工程",
            studyMode: "全日制",
            locationText: "杭州市",
            department: "计算机学院",
            structuredData: '{"secret":"SENTINEL"}',
          },
          attachments: [],
          evidence: [],
        },
      ],
    });
    const { accessToken } = await pairAndExchange(db, "user-1", [
      "basic",
      "education",
    ]);
    const connection = await authenticateConnection(accessToken, {
      db: db as never,
    });
    const payload = await buildPairedProfile(connection, null, {
      db: db as never,
    });

    expect(payload.profileV2.schemaVersion).toBe(2);
    expect(payload.meta.channel).toBe("paired-sync");
    expect(payload.meta.allowedSections).toEqual(["basic", "education"]);
    // Whitelisted values flow.
    const basic = payload.profileV2.sections.basic;
    expect(basic.kind === "simple" && basic.values["姓名"]).toBe("张三");
    // Never user-2's data: the token resolves to user-1 only.
    expect(JSON.stringify(payload)).not.toContain("李四");
    expect(JSON.stringify(payload)).not.toContain("SENTINEL");
    // Report transparency: structuredData reported unsupported, sensitive
    // categories still listed as excluded.
    expect(payload.meta.report.sensitiveExcluded.join()).toContain("证件");
    expect(
      payload.meta.report.unsupported.some((n) => n.includes("扩展结构数据")),
    ).toBe(true);
    // Profile pull reflects the newest source timestamp.
    expect(payload.profileV2.updatedAt).toBe("2026-11-12T09:00:00.000Z");
  });

  it("narrows the grant with ?sections= and cannot exceed the grant", async () => {
    const { db } = makeFakeDb({ preference: preferenceRow() });
    const { accessToken } = await pairAndExchange(db, "user-1", [
      "basic",
      "education",
    ]);
    const connection = await authenticateConnection(accessToken, {
      db: db as never,
    });
    const requested = parseRequestedSections("basic");
    const payload = await buildPairedProfile(connection, requested, {
      db: db as never,
    });
    expect(payload.meta.sections).toEqual(["basic"]);
    const education = payload.profileV2.sections.education;
    expect(education.kind === "repeat" && education.items).toHaveLength(0);
    // A section outside the grant is simply not produced.
    const outside = await buildPairedProfile(connection, ["work"], {
      db: db as never,
    });
    expect(outside.meta.sections).toEqual([]);
    // Unknown keys in the query are rejected, not silently dropped.
    expect(() => parseRequestedSections("basic,family")).toThrow(
      AutoApplyConnectError,
    );
  });

  it("re-reads the source on every pull so edits surface on the next sync", async () => {
    const profiles = new Map([["user-1", profileRow()]]);
    const { db } = makeFakeDb({ profiles });
    const { accessToken } = await pairAndExchange(db, "user-1", ["basic"]);
    const connection = await authenticateConnection(accessToken, {
      db: db as never,
    });
    const first = await buildPairedProfile(connection, null, {
      db: db as never,
    });
    profiles.set(
      "user-1",
      profileRow({
        fullName: "张三丰",
        updatedAt: "2026-11-14T11:00:00.000Z",
      }),
    );
    const second = await buildPairedProfile(connection, null, {
      db: db as never,
    });
    const firstBasic = first.profileV2.sections.basic;
    const secondBasic = second.profileV2.sections.basic;
    expect(firstBasic.kind === "simple" && firstBasic.values["姓名"]).toBe(
      "张三",
    );
    expect(secondBasic.kind === "simple" && secondBasic.values["姓名"]).toBe(
      "张三丰",
    );
    expect(second.profileV2.updatedAt > first.profileV2.updatedAt).toBe(true);
  });
});

describe("session-middleware bypass contract", () => {
  // The plugin carries its own bearer token and has no NextAuth session, so
  // the connect endpoints must bypass the session middleware — same pattern
  // as /api/internal (see src/middleware.ts). If the matcher stops excluding
  // them, every extension call dies as an HTML sign-in redirect.
  it("matcher excludes connect endpoints but keeps session-guarded APIs", async () => {
    const { config } = await import("@/middleware");
    const apiPattern = (config.matcher as string[]).find((entry) =>
      entry.startsWith("/api/"),
    );
    expect(apiPattern).toBeTruthy();
    const regex = new RegExp(`^${apiPattern}$`);
    expect(
      regex.test("/api/extensions/auto-apply/connect/exchange"),
    ).toBe(false);
    expect(
      regex.test("/api/extensions/auto-apply/connect/profile"),
    ).toBe(false);
    expect(
      regex.test("/api/extensions/auto-apply/connect/status"),
    ).toBe(false);
    expect(
      regex.test("/api/extensions/auto-apply/connect/disconnect"),
    ).toBe(false);
    // The manual export and every other API stay session-guarded.
    expect(regex.test("/api/extensions/auto-apply/export")).toBe(true);
    expect(regex.test("/api/jobs")).toBe(true);
  });
});

describe("listing and bookkeeping", () => {
  it("lists connections without secrets and tracks sync timestamps", async () => {
    const { db } = makeFakeDb();
    const { accessToken, connectionId } = await pairAndExchange(db);
    await touchConnection(
      connectionId,
      {
        lastSeenAt: NOW,
        lastSyncAt: NOW,
        lastProfileUpdatedAt: "2026-11-12T09:00:00.000Z",
      },
      { db: db as never },
    );
    const rows = await listConnections("user-1", { db: db as never });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(connectionId);
    expect(rows[0].revoked).toBe(false);
    expect(rows[0].lastSyncAt).toBe(NOW.toISOString());
    expect(rows[0].lastProfileUpdatedAt).toBe("2026-11-12T09:00:00.000Z");
    expect(rows[0].allowedSections).toEqual(["basic", "education"]);
    expect(JSON.stringify(rows)).not.toContain(accessToken);
    // Other users see nothing.
    expect(await listConnections("user-2", { db: db as never })).toEqual([]);
  });
});
