// @vitest-environment node
/**
 * Phase B account-login foundation (additive schema + backup seam).
 *
 * Covers:
 * - AIConnection / AIBusinessAssignment schema shape (multi-account per
 *   provider, (userId, purpose) uniqueness, nullable lock fields)
 * - archive-not-delete: Restrict FK blocks deleting a referenced connection
 * - resolver contract: business wins / global fallback / not configured /
 *   archived / reauth (pure helper, no DB)
 * - providerMetadata secret guard
 * - backup coverage + insert ordering for the new models and lock FKs
 * - round-trip: connection metadata + assignment + resolved lock fields
 * - ACCOUNT_LOGIN restore normalization: CONNECTED -> REAUTH_REQUIRED
 * - legacy backups (no AI groups, no lock columns) still restore
 * - fail-closed on a dangling AIBusinessAssignment.connectionId
 */
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import {
  backupCoverageStatus,
  BACKUP_COVERAGE_STATUS,
} from "@/lib/backup/coverage";
import { INSERT_ORDER, MODEL_SPECS } from "@/lib/backup/ordering";
import { BackupDataSchema } from "@/lib/backup/schema";
import {
  AI_RESOLUTION_ERROR_CODES,
  AIResolutionError,
  assertProviderMetadataSafe,
  isAIAssignmentPurpose,
  isAIAuthType,
  isAIBackendKind,
  isAIConnectionProvider,
  isAIConnectionStatus,
  resolveBusinessAIAssignment,
} from "@/lib/ai/connections";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

// Never start the cron in a test run.
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

const EMAIL = "ai-foundation@example.com";

let userId: string;
let uploadsDir: string;
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

beforeAll(async () => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;

  userId = await seedAccount(prisma, EMAIL);
}, 180_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

describe("ai connection schema foundation", () => {
  it("allows multiple connections for the same user + provider", async () => {
    const first = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        displayName: "Work OpenAI",
        accountIdentity: "work-account",
      },
    });
    const second = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        displayName: "Personal OpenAI",
        accountIdentity: "personal-account",
      },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.authType).toBe("ACCOUNT_LOGIN");
    expect(first.status).toBe("CONNECTED");
  });

  it("allows the same accountIdentity on different connections (no unique)", async () => {
    await prisma.aIConnection.create({
      data: {
        userId,
        provider: "ANTHROPIC",
        backendKind: "CLAUDE_RUNTIME",
        displayName: "Shared identity A",
        accountIdentity: "shared@example.com",
      },
    });
    const dup = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "ANTHROPIC",
        backendKind: "CLAUDE_RUNTIME",
        displayName: "Shared identity B",
        accountIdentity: "shared@example.com",
      },
    });
    expect(dup.id).toBeTruthy();
  });

  it("lets different purposes coexist but rejects duplicate (userId, purpose)", async () => {
    const conn = await prisma.aIConnection.findFirstOrThrow({
      where: { userId, provider: "OPENAI" },
    });
    const interview = await prisma.aIBusinessAssignment.create({
      data: {
        userId,
        purpose: "INTERVIEW",
        connectionId: conn.id,
        model: "gpt-5",
      },
    });
    const globalDefault = await prisma.aIBusinessAssignment.create({
      data: {
        userId,
        purpose: "GLOBAL_DEFAULT",
        connectionId: conn.id,
        model: "gpt-4o",
      },
    });
    expect(interview.id).not.toBe(globalDefault.id);

    await expect(
      prisma.aIBusinessAssignment.create({
        data: {
          userId,
          purpose: "INTERVIEW",
          connectionId: conn.id,
          model: "gpt-5-mini",
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps legacy lock fields nullable and enforces Restrict on delete", async () => {
    const conn = await prisma.aIConnection.findFirstOrThrow({
      where: { userId, provider: "OPENAI" },
    });

    // A row written before Phase B: no lock fields at all.
    const legacy = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    expect(legacy.resolvedConnectionId).toBeNull();
    expect(legacy.resolvedModel).toBeNull();

    const locked = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "MOCK",
        feedbackReleasePolicy: "ON_SESSION_COMPLETE",
        knowledgeBaseVersion: "v1.0",
        resolvedConnectionId: conn.id,
        resolvedModel: "gpt-5",
      },
    });
    expect(locked.resolvedConnectionId).toBe(conn.id);

    // Archive-not-delete: a connection still referenced by a resolved lock
    // cannot be removed; archiving is the only lifecycle out.
    await expect(
      prisma.aIConnection.delete({ where: { id: conn.id } }),
    ).rejects.toThrow();
  });
});

describe("resolver contract skeleton", () => {
  const connA = { status: "CONNECTED", archivedAt: null };
  const rows = [
    { purpose: "INTERVIEW", connectionId: "conn-interview", model: "m-i", connection: connA },
    { purpose: "GLOBAL_DEFAULT", connectionId: "conn-global", model: "m-g", connection: connA },
  ];

  it("business assignment wins over the global default", () => {
    expect(resolveBusinessAIAssignment("INTERVIEW", rows)).toEqual({
      connectionId: "conn-interview",
      model: "m-i",
      source: "BUSINESS",
    });
  });

  it("falls back to GLOBAL_DEFAULT for an unassigned purpose", () => {
    expect(resolveBusinessAIAssignment("RESUME", rows)).toEqual({
      connectionId: "conn-global",
      model: "m-g",
      source: "GLOBAL_DEFAULT",
    });
  });

  it("throws AI_NOT_CONFIGURED when neither assignment exists", () => {
    try {
      resolveBusinessAIAssignment("RESUME", []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AIResolutionError);
      expect((error as AIResolutionError).code).toBe(
        AI_RESOLUTION_ERROR_CODES.AI_NOT_CONFIGURED,
      );
    }
  });

  it("throws CONNECTION_ARCHIVED for an archived picked connection", () => {
    expect(() =>
      resolveBusinessAIAssignment("INTERVIEW", [
        {
          purpose: "INTERVIEW",
          connectionId: "c",
          model: "m",
          connection: { status: "CONNECTED", archivedAt: new Date() },
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: AI_RESOLUTION_ERROR_CODES.CONNECTION_ARCHIVED,
      }) as Error,
    );
  });

  it("throws CONNECTION_REAUTH_REQUIRED for a picked connection needing re-auth", () => {
    expect(() =>
      resolveBusinessAIAssignment("GLOBAL_DEFAULT", [
        {
          purpose: "GLOBAL_DEFAULT",
          connectionId: "c",
          model: "m",
          connection: { status: "REAUTH_REQUIRED", archivedAt: null },
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: AI_RESOLUTION_ERROR_CODES.CONNECTION_REAUTH_REQUIRED,
      }) as Error,
    );
  });
});

describe("registry + secret guard", () => {
  it("validates registry values without database CHECKs", () => {
    expect(isAIConnectionProvider("OPENAI")).toBe(true);
    expect(isAIConnectionProvider("openai")).toBe(false);
    expect(isAIBackendKind("CODEX_RUNTIME")).toBe(true);
    expect(isAIAuthType("ACCOUNT_LOGIN")).toBe(true);
    expect(isAIAuthType("API_KEY")).toBe(true);
    expect(isAIAuthType("OAUTH")).toBe(false);
    expect(isAIConnectionStatus("REAUTH_REQUIRED")).toBe(true);
    expect(isAIAssignmentPurpose("GLOBAL_DEFAULT")).toBe(true);
    expect(isAIAssignmentPurpose("INTERVIEW")).toBe(true);
  });

  it("rejects secret-looking keys in providerMetadata", () => {
    for (const key of [
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "apiKey",
      "api_key",
      "token",
      "secret",
      "password",
      "oauthAccessToken",
    ]) {
      expect(() => assertProviderMetadataSafe({ [key]: "x" })).toThrow(
        /credential field/,
      );
      expect(() =>
        assertProviderMetadataSafe(JSON.stringify({ [key]: "x" })),
      ).toThrow(/credential field/);
    }
  });

  it("accepts non-secret providerMetadata and empty input", () => {
    expect(() =>
      assertProviderMetadataSafe({ org: "acme", region: "us", plan: "pro" }),
    ).not.toThrow();
    expect(() => assertProviderMetadataSafe(JSON.stringify({ org: "acme" }))).not.toThrow();
    expect(() => assertProviderMetadataSafe(null)).not.toThrow();
    expect(() => assertProviderMetadataSafe(undefined)).not.toThrow();
  });
});

describe("backup ordering + coverage", () => {
  it("classifies both new models as backed up, never excluded", () => {
    for (const model of ["AIConnection", "AIBusinessAssignment"] as const) {
      expect(backupCoverageStatus(model)).toBe(BACKUP_COVERAGE_STATUS.BACKED_UP);
      expect(BackupDataSchema.shape).toHaveProperty(model);
    }
  });

  it("inserts AIConnection before every model that locks onto it", () => {
    const at = (m: string) => INSERT_ORDER.indexOf(m as never);
    for (const dependent of [
      "AIBusinessAssignment",
      "InterviewSession",
      "MatchAnalysis",
      "JobDescriptionParse",
      "ResumeVariantVersion",
      "AutomationRun",
    ]) {
      expect(at("AIConnection")).toBeLessThan(at(dependent));
    }
  });

  it("maps every resolvedConnectionId and the required assignment FK", () => {
    for (const model of [
      "InterviewSession",
      "MatchAnalysis",
      "JobDescriptionParse",
      "ResumeVariantVersion",
      "AutomationRun",
    ] as const) {
      expect(MODEL_SPECS[model].fks.resolvedConnectionId).toBe("AIConnection");
    }
    expect(MODEL_SPECS.AIBusinessAssignment.fks.connectionId).toBe(
      "AIConnection",
    );
    expect(MODEL_SPECS.AIConnection.owner).toBe("userId");
    expect(MODEL_SPECS.AIBusinessAssignment.owner).toBe("userId");
  });
});

describe("backup round trip", () => {
  let backupBuffer: Buffer;
  let connId: string;
  let apiKeyConnId: string;

  beforeAll(async () => {
    const conn = await prisma.aIConnection.findFirstOrThrow({
      where: { userId, provider: "OPENAI", accountIdentity: "work-account" },
    });
    connId = conn.id;

    // An API_KEY-authed connection proves the normalization is authType-scoped.
    const apiKeyConn = await prisma.aIConnection.create({
      data: {
        userId,
        provider: "DEVIN",
        backendKind: "DEVIN_RUNTIME",
        displayName: "Devin key",
        authType: "API_KEY",
        credentialRef: "apikey:devin",
      },
    });
    apiKeyConnId = apiKeyConn.id;

    // AutomationRun lock: profile -> resume -> automation -> run.
    const profile = await prisma.profile.create({ data: { userId } });
    const resume = await prisma.resume.create({
      data: { profileId: profile.id, title: "CV" },
    });
    const automation = await prisma.automation.create({
      data: {
        userId,
        name: "auto",
        jobBoard: "board",
        keywords: "k",
        location: "l",
        resumeId: resume.id,
        scheduleHour: 9,
      },
    });
    await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        status: "completed",
        completedAt: new Date("2026-03-01T00:00:00.000Z"),
        resolvedConnectionId: connId,
        resolvedModel: "gpt-5",
      },
    });

    // MatchAnalysis + JobDescriptionParse lock.
    const company = await prisma.company.create({
      data: { label: "Acme", value: "acme-ai-conn", createdBy: userId },
    });
    const opp = await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "Engineer" },
    });
    const jdv = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: opp.id,
        versionNumber: 1,
        rawContent: "raw",
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        contentHash: "hash-ai-conn",
      },
    });
    const parse = await prisma.jobDescriptionParse.create({
      data: {
        jobDescriptionVersionId: jdv.id,
        schemaVersion: "s1",
        parserVersion: "p1",
        structuredData: "{}",
        parseStatus: "OK",
        inputHash: "ih-1",
        resolvedConnectionId: connId,
      },
    });
    await prisma.matchAnalysis.create({
      data: {
        userId,
        jobOpportunityId: opp.id,
        jobDescriptionParseId: parse.id,
        analysisType: "FAST_SCREENING",
        inputHash: "ih-2",
        analysisSchemaVersion: "v1",
        status: "DONE",
        resolvedConnectionId: connId,
      },
    });

    // ResumeVariantVersion lock.
    const variant = await prisma.resumeVariant.create({
      data: { userId, name: "Variant" },
    });
    await prisma.resumeVariantVersion.create({
      data: {
        resumeVariantId: variant.id,
        versionNumber: 1,
        resolvedConnectionId: connId,
        resolvedModel: "gpt-5",
      },
    });
  });

  it("exports connection metadata, assignments, and lock fields", async () => {
    const result = await buildBackupZip(userId, EMAIL);
    backupBuffer = result.buffer;
    const zip = await JSZip.loadAsync(backupBuffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));

    expect(data.AIConnection).toHaveLength(5);
    const exported = data.AIConnection.find(
      (row: { id: string }) => row.id === connId,
    );
    expect(exported).toMatchObject({
      provider: "OPENAI",
      authType: "ACCOUNT_LOGIN",
      backendKind: "CODEX_RUNTIME",
      status: "CONNECTED",
    });
    // Ownership stripped; no credential material is ever written.
    expect(exported).not.toHaveProperty("userId");
    const raw = await zip.file("data.json")!.async("string");
    expect(raw).not.toContain("tokenHash");

    expect(data.AIBusinessAssignment).toHaveLength(2);
    expect(data.AIBusinessAssignment[0]).not.toHaveProperty("userId");

    const session = data.InterviewSession.find(
      (row: { resolvedConnectionId?: string }) => row.resolvedConnectionId,
    );
    expect(session.resolvedConnectionId).toBe(connId);
    expect(session.resolvedModel).toBe("gpt-5");
    expect(data.AutomationRun[0].resolvedConnectionId).toBe(connId);
    expect(data.AutomationRun[0].resolvedModel).toBe("gpt-5");
    expect(data.MatchAnalysis[0].resolvedConnectionId).toBe(connId);
    expect(data.JobDescriptionParse[0].resolvedConnectionId).toBe(connId);
    expect(data.ResumeVariantVersion[0].resolvedConnectionId).toBe(connId);
    expect(data.ResumeVariantVersion[0].resolvedModel).toBe("gpt-5");
  }, 120_000);

  it("restores connections as REAUTH_REQUIRED and keeps assignment + locks", async () => {
    const result = await importBackup(backupBuffer, userId, EMAIL, true);
    expect(result.counts.AIConnection).toBe(5);
    expect(result.counts.AIBusinessAssignment).toBe(2);

    const connections = await prisma.aIConnection.findMany({
      where: { userId },
    });
    expect(connections).toHaveLength(5);
    // Remapped ids â€?the restore must never replay source ids.
    expect(connections.map((c) => c.id)).not.toContain(connId);

    const accountLogin = connections.filter((c) => c.authType === "ACCOUNT_LOGIN");
    expect(accountLogin).toHaveLength(4);
    for (const conn of accountLogin) {
      expect(conn.status).toBe("REAUTH_REQUIRED");
    }
    // API_KEY rows are not re-auth normalized (different seam entirely).
    const apiKeyConn = connections.find((c) => c.authType === "API_KEY");
    expect(apiKeyConn?.status).toBe("CONNECTED");

    const assignments = await prisma.aIBusinessAssignment.findMany({
      where: { userId },
    });
    expect(assignments).toHaveLength(2);
    const interview = assignments.find((a) => a.purpose === "INTERVIEW");
    const newConnId = connections.find(
      (c) => c.accountIdentity === "work-account",
    )!.id;
    expect(interview?.connectionId).toBe(newConnId);
    expect(interview?.model).toBe("gpt-5");

    const session = await prisma.interviewSession.findFirstOrThrow({
      where: { userId, resolvedModel: "gpt-5" },
    });
    expect(session.resolvedConnectionId).toBe(newConnId);

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { resolvedModel: "gpt-5" },
    });
    expect(run.resolvedConnectionId).toBe(newConnId);

    const analysis = await prisma.matchAnalysis.findFirstOrThrow({
      where: { userId },
    });
    expect(analysis.resolvedConnectionId).toBe(newConnId);

    const parse = await prisma.jobDescriptionParse.findFirstOrThrow();
    expect(parse.resolvedConnectionId).toBe(newConnId);

    const version = await prisma.resumeVariantVersion.findFirstOrThrow({
      where: { resolvedModel: "gpt-5" },
    });
    expect(version.resolvedConnectionId).toBe(newConnId);

    const fk = (await prisma.$queryRawUnsafe(
      "PRAGMA foreign_key_check;",
    )) as unknown[];
    expect(fk).toEqual([]);
  }, 180_000);

  it("fails closed on a dangling AIBusinessAssignment.connectionId", async () => {
    const zip = await JSZip.loadAsync(backupBuffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    data.AIBusinessAssignment[0].connectionId = "ghost-connection";
    zip.file("data.json", JSON.stringify(data));
    const poisoned = await zip.generateAsync({ type: "nodebuffer" });

    const before = await prisma.aIConnection.count({ where: { userId } });
    await expect(
      importBackup(poisoned, userId, EMAIL, true),
    ).rejects.toThrow();
    // Atomic rollback: the wipe did not commit.
    expect(await prisma.aIConnection.count({ where: { userId } })).toBe(before);
  }, 180_000);

  it("degrades a dangling resolvedConnectionId to null instead of failing", async () => {
    const zip = await JSZip.loadAsync(backupBuffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    // The lock target exists in the backup's rows, but pretend a pruned
    // connection is still referenced (e.g. hand-filtered export).
    for (const row of data.InterviewSession) row.resolvedConnectionId = "ghost";
    for (const row of data.AutomationRun) row.resolvedConnectionId = "ghost";
    zip.file("data.json", JSON.stringify(data));
    const pruned = await zip.generateAsync({ type: "nodebuffer" });

    await importBackup(pruned, userId, EMAIL, true);
    const sessions = await prisma.interviewSession.findMany({
      where: { userId },
    });
    for (const session of sessions) {
      expect(session.resolvedConnectionId).toBeNull();
      // resolvedModel provenance is kept even when the link degraded.
      if (session.resolvedModel !== null) {
        expect(session.resolvedModel).toBe("gpt-5");
      }
    }
  }, 180_000);

  it("restores a legacy backup with no AI groups or lock columns", async () => {
    const zip = await JSZip.loadAsync(backupBuffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));

    delete data.AIConnection;
    delete data.AIBusinessAssignment;
    delete manifest.counts.AIConnection;
    delete manifest.counts.AIBusinessAssignment;
    for (const model of [
      "InterviewSession",
      "MatchAnalysis",
      "JobDescriptionParse",
      "ResumeVariantVersion",
      "AutomationRun",
    ]) {
      for (const row of data[model] ?? []) {
        delete row.resolvedConnectionId;
        delete row.resolvedModel;
      }
    }
    zip.file("data.json", JSON.stringify(data));
    zip.file("manifest.json", JSON.stringify(manifest));
    const legacy = await zip.generateAsync({ type: "nodebuffer" });

    await importBackup(legacy, userId, EMAIL, true);

    // The wipe removed the user's connections and the legacy payload has none.
    expect(await prisma.aIConnection.count({ where: { userId } })).toBe(0);
    expect(
      await prisma.aIBusinessAssignment.count({ where: { userId } }),
    ).toBe(0);
    const sessions = await prisma.interviewSession.findMany({
      where: { userId },
    });
    for (const session of sessions) {
      expect(session.resolvedConnectionId).toBeNull();
      expect(session.resolvedModel).toBeNull();
    }
  }, 180_000);
});
