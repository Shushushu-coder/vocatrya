// @vitest-environment node
/**
 * Business assignment + TEXT_ONLY execution seam (backend side).
 *
 * Covers:
 * - resolveBusinessAIConfig: specific → GLOBAL_DEFAULT → NOT_CONFIGURED;
 *   broken explicit assignment never falls back; ownership; status gate;
 *   runtime binding; INTERVIEW legacy coexistence precedence
 * - assignment CRUD validation (ownership, archived, model, purpose)
 * - executeAIConnectionText: ownership + status gates, prompt cap,
 *   ticketed internal transport, error-code mapping
 * - AutomationRun lock-on-create semantics + NO_GUESS_BACKFILL
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  clearBusinessAssignment,
  listBusinessAssignmentsForUser,
  resolveBusinessAIConfig,
  setBusinessAssignment,
} from "@/lib/ai/assignments";
import {
  executeAIConnectionText,
  AI_EXECUTION_MAX_PROMPT_BYTES,
} from "@/lib/ai/execution";
import { AIBusinessError } from "@/lib/ai/connections";
import { resolveAutomationMatchRuntime } from "@/lib/scraper/automation-run/matchRuntime";
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

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;

function rpRef() {
  return `rp_${randomUUID()}`;
}

async function makeConnection(overrides: Record<string, unknown> = {}) {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "OPENAI",
      backendKind: "CODEX_RUNTIME",
      displayName: "ChatGPT via Codex",
      status: "CONNECTED",
      runtimeProfileRef: rpRef(),
      ...overrides,
    },
  });
}

async function assign(purpose: string, connectionId: string, model: string) {
  return prisma.aIBusinessAssignment.create({
    data: { userId, purpose, connectionId, model },
  });
}

async function cleanup() {
  await prisma.aIBusinessAssignment.deleteMany();
  await prisma.automationRun.deleteMany();
  await prisma.automation.deleteMany();
  await prisma.resume.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.userSettings.deleteMany();
  await prisma.aIConnection.deleteMany();
}

beforeAll(async () => {
  userId = await seedAccount(prisma, "biz-assign@example.com");
  otherUserId = await seedAccount(prisma, "biz-assign-other@example.com");
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const fs = await import("node:fs");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

beforeEach(cleanup);

describe("resolveBusinessAIConfig", () => {
  it("resolves a specific business assignment", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "gpt-5.5");
    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.source).toBe("BUSINESS_ASSIGNMENT");
    expect(result.connectionId).toBe(connection.id);
    expect(result.model).toBe("gpt-5.5");
    expect(result.provider).toBe("OPENAI");
    expect(result.backendKind).toBe("CODEX_RUNTIME");
  });

  it("falls back to GLOBAL_DEFAULT when no specific assignment exists", async () => {
    const connection = await makeConnection();
    await assign("GLOBAL_DEFAULT", connection.id, "gpt-5.6-sol");
    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.source).toBe("GLOBAL_DEFAULT");
    expect(result.connectionId).toBe(connection.id);
  });

  it("returns NOT_CONFIGURED when neither exists", async () => {
    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result.status).toBe("NOT_CONFIGURED");
  });

  it("fails explicitly on a broken explicit assignment — never falls back", async () => {
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "Other account" });
    await assign("RESUME", broken.id, "gpt-5.5");
    await assign("GLOBAL_DEFAULT", healthy.id, "gpt-5.6-sol");

    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result.status).toBe("INVALID_ASSIGNMENT");
    if (result.status !== "INVALID_ASSIGNMENT") return;
    expect(result.code).toBe("CONNECTION_DISCONNECTED");
    expect(result.connectionId).toBe(broken.id);
  });

  it("fails explicitly on an archived connection", async () => {
    const connection = await makeConnection({ archivedAt: new Date() });
    const healthy = await makeConnection({ displayName: "Other" });
    await assign("RESUME", connection.id, "gpt-5.5");
    await assign("GLOBAL_DEFAULT", healthy.id, "gpt-5.6-sol");

    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      code: "ASSIGNED_CONNECTION_UNAVAILABLE",
    });
  });

  it("fails explicitly when the assigned connection belongs to another user", async () => {
    const foreign = await prisma.aIConnection.create({
      data: {
        userId: otherUserId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        displayName: "Foreign",
        status: "CONNECTED",
        runtimeProfileRef: rpRef(),
      },
    });
    const healthy = await makeConnection({ displayName: "Mine" });
    await assign("RESUME", foreign.id, "gpt-5.5");
    await assign("GLOBAL_DEFAULT", healthy.id, "gpt-5.6-sol");

    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      code: "ASSIGNED_CONNECTION_UNAVAILABLE",
    });
  });

  it("maps REAUTH_REQUIRED status without fallback", async () => {
    const connection = await makeConnection({ status: "REAUTH_REQUIRED" });
    await assign("GLOBAL_DEFAULT", connection.id, "gpt-5.5");
    const result = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
    expect(result).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      source: "GLOBAL_DEFAULT",
      code: "REAUTH_REQUIRED",
    });
  });

  it("maps ERROR status and invalid runtime binding explicitly", async () => {
    const errConn = await makeConnection({ status: "ERROR" });
    await assign("RESUME", errConn.id, "gpt-5.5");
    expect(
      await resolveBusinessAIConfig({ userId, purpose: "RESUME" }),
    ).toMatchObject({ status: "INVALID_ASSIGNMENT", code: "CONNECTION_ERROR" });

    const noProfile = await makeConnection({ runtimeProfileRef: null });
    await setBusinessAssignment({
      userId,
      purpose: "CAREER_DIALOGUE",
      connectionId: noProfile.id,
      model: "gpt-5.5",
    });
    expect(
      await resolveBusinessAIConfig({ userId, purpose: "CAREER_DIALOGUE" }),
    ).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      code: "RUNTIME_NOT_AVAILABLE",
    });
  });
});

describe("CAREER_DIALOGUE precedence", () => {
  // CAREER_DIALOGUE has no legacy special-casing — the plain steady-state
  // chain applies: purpose assignment → GLOBAL_DEFAULT → NOT_CONFIGURED.
  it("resolves a specific assignment over GLOBAL_DEFAULT", async () => {
    const specific = await makeConnection();
    const global = await makeConnection({ displayName: "Global" });
    await assign("CAREER_DIALOGUE", specific.id, "gpt-5.5");
    await assign("GLOBAL_DEFAULT", global.id, "gpt-5.6");
    const result = await resolveBusinessAIConfig({
      userId,
      purpose: "CAREER_DIALOGUE",
    });
    expect(result).toMatchObject({
      status: "RESOLVED",
      source: "BUSINESS_ASSIGNMENT",
      connectionId: specific.id,
      model: "gpt-5.5",
    });
  });

  it("falls back to GLOBAL_DEFAULT, then reports NOT_CONFIGURED", async () => {
    const global = await makeConnection();
    await assign("GLOBAL_DEFAULT", global.id, "gpt-5.6");
    expect(
      await resolveBusinessAIConfig({ userId, purpose: "CAREER_DIALOGUE" }),
    ).toMatchObject({
      status: "RESOLVED",
      source: "GLOBAL_DEFAULT",
      connectionId: global.id,
    });

    await cleanup();
    expect(
      await resolveBusinessAIConfig({ userId, purpose: "CAREER_DIALOGUE" }),
    ).toMatchObject({ status: "NOT_CONFIGURED" });
  });

  it("a broken explicit assignment never falls back to GLOBAL_DEFAULT", async () => {
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "Healthy" });
    await assign("CAREER_DIALOGUE", broken.id, "m");
    await assign("GLOBAL_DEFAULT", healthy.id, "g");
    expect(
      await resolveBusinessAIConfig({ userId, purpose: "CAREER_DIALOGUE" }),
    ).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      code: "CONNECTION_DISCONNECTED",
      connectionId: broken.id,
    });
  });
});

describe("INTERVIEW coexistence", () => {
  async function setLegacyInterview(provider = "OPENAI", model = "gpt-4o-mini") {
    await prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        settings: JSON.stringify({
          ai: { provider: "OLLAMA", model: "llama3.2", interview: { provider, model } },
        }),
      },
      update: {
        settings: JSON.stringify({
          ai: { provider: "OLLAMA", model: "llama3.2", interview: { provider, model } },
        }),
      },
    });
  }

  it("explicit INTERVIEW assignment resolves first", async () => {
    const connection = await makeConnection();
    await setLegacyInterview();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const result = await resolveBusinessAIConfig({
      userId,
      purpose: "INTERVIEW",
    });
    expect(result).toMatchObject({
      status: "RESOLVED",
      source: "BUSINESS_ASSIGNMENT",
      connectionId: connection.id,
    });
  });

  it("legacy settings.ai.interview is preserved when no assignment exists", async () => {
    await setLegacyInterview("GEMINI", "gemini-2.0-flash");
    const result = await resolveBusinessAIConfig({
      userId,
      purpose: "INTERVIEW",
    });
    expect(result).toMatchObject({
      status: "LEGACY_INTERVIEW_CONFIG",
      provider: "GEMINI",
      model: "gemini-2.0-flash",
    });
  });

  it("legacy interview config wins over GLOBAL_DEFAULT during coexistence", async () => {
    const connection = await makeConnection();
    await assign("GLOBAL_DEFAULT", connection.id, "gpt-5.5");
    await setLegacyInterview();
    const result = await resolveBusinessAIConfig({
      userId,
      purpose: "INTERVIEW",
    });
    expect(result.status).toBe("LEGACY_INTERVIEW_CONFIG");
  });

  it("GLOBAL_DEFAULT applies to INTERVIEW only when no legacy config exists", async () => {
    const connection = await makeConnection();
    await assign("GLOBAL_DEFAULT", connection.id, "gpt-5.5");
    const result = await resolveBusinessAIConfig({
      userId,
      purpose: "INTERVIEW",
    });
    expect(result).toMatchObject({
      status: "RESOLVED",
      source: "GLOBAL_DEFAULT",
    });
  });
});

describe("assignment CRUD", () => {
  it("saves, lists, and clears a connectionId + model pair atomically", async () => {
    const connection = await makeConnection();
    const saved = await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: connection.id,
      model: "gpt-5.5",
    });
    expect(saved.model).toBe("gpt-5.5");
    const list = await listBusinessAssignmentsForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      purpose: "RESUME",
      connectionId: connection.id,
      model: "gpt-5.5",
    });
    await clearBusinessAssignment({ userId, purpose: "RESUME" });
    expect(await listBusinessAssignmentsForUser(userId)).toHaveLength(0);
  });

  it("upserts over an existing purpose", async () => {
    const a = await makeConnection();
    const b = await makeConnection({ displayName: "B" });
    await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: a.id,
      model: "m1",
    });
    await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: b.id,
      model: "m2",
    });
    const list = await listBusinessAssignmentsForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0].connectionId).toBe(b.id);
    expect(list[0].model).toBe("m2");
  });

  it("rejects a foreign-owned connection", async () => {
    const foreign = await prisma.aIConnection.create({
      data: {
        userId: otherUserId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        displayName: "Foreign",
        runtimeProfileRef: rpRef(),
      },
    });
    await expect(
      setBusinessAssignment({
        userId,
        purpose: "RESUME",
        connectionId: foreign.id,
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });

  it("rejects archived connections and empty models", async () => {
    const archived = await makeConnection({ archivedAt: new Date() });
    await expect(
      setBusinessAssignment({
        userId,
        purpose: "RESUME",
        connectionId: archived.id,
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_ARCHIVED" });
    const connection = await makeConnection();
    await expect(
      setBusinessAssignment({
        userId,
        purpose: "RESUME",
        connectionId: connection.id,
        model: "  ",
      }),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await expect(
      setBusinessAssignment({
        userId,
        purpose: "NOPE",
        connectionId: connection.id,
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PURPOSE" });
  });

  it("does not require CONNECTED status at save time", async () => {
    const connection = await makeConnection({ status: "REAUTH_REQUIRED" });
    const saved = await setBusinessAssignment({
      userId,
      purpose: "RESUME",
      connectionId: connection.id,
      model: "gpt-5.5",
    });
    expect(saved.connectionId).toBe(connection.id);
  });
});

describe("executeAIConnectionText", () => {
  const deps = (fetchImpl: typeof fetch) => ({
    dbClient: prisma as never,
    execUrl: "http://127.0.0.1:9999",
    internalToken: "test-token",
    fetchImpl,
  });

  const okFetch = async () =>
    new Response(
      JSON.stringify({ ok: true, text: "SCORES: match=90", durationMs: 5 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("sends a ticketed TEXT_ONLY request and returns normalized text", async () => {
    const connection = await makeConnection();
    let captured: Record<string, unknown> | null = null;
    let capturedTicket: unknown = null;
    let capturedAuth = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured = parsed;
      capturedTicket = parsed.ticket;
      capturedAuth = String(
        (init?.headers as Record<string, string>)?.authorization ?? "",
      );
      return okFetch();
    };
    const result = await executeAIConnectionText(
      {
        userId,
        connectionId: connection.id,
        model: "gpt-5.5",
        prompt: "hello",
      },
      deps(fetchImpl),
    );
    expect(result.text).toBe("SCORES: match=90");
    expect(result.provider).toBe("OPENAI");
    expect(result.backendKind).toBe("CODEX_RUNTIME");
    expect(result.connectionId).toBe(connection.id);
    expect(capturedAuth).toBe("Bearer test-token");
    expect(captured).toMatchObject({
      connectionId: connection.id,
      model: "gpt-5.5",
      prompt: "hello",
      permissionScope: "TEXT_ONLY",
    });
    expect(typeof capturedTicket).toBe("string");
    // The payload carries identifiers and data only — never executable,
    // args, env, cwd, profile path, or credential material.
    for (const forbidden of [
      "executable",
      "args",
      "env",
      "cwd",
      "workingDirectory",
      "runtimeProfileRef",
      "credentialRef",
    ]) {
      expect(captured).not.toHaveProperty(forbidden);
    }
  });

  it("rejects a foreign-owned or missing connection", async () => {
    const foreign = await prisma.aIConnection.create({
      data: {
        userId: otherUserId,
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        displayName: "Foreign",
        runtimeProfileRef: rpRef(),
      },
    });
    await expect(
      executeAIConnectionText(
        {
          userId,
          connectionId: foreign.id,
          model: "m",
          prompt: "p",
        },
        deps(okFetch),
      ),
    ).rejects.toMatchObject({
      name: "AIBusinessError",
      code: "ASSIGNED_CONNECTION_UNAVAILABLE",
    });
  });

  it("maps connection status gates without calling the desktop", async () => {
    const fetchImpl = vi.fn(okFetch);
    for (const [status, code] of [
      ["REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ["DISCONNECTED", "CONNECTION_DISCONNECTED"],
      ["ERROR", "CONNECTION_ERROR"],
    ] as const) {
      const connection = await makeConnection({ status });
      await expect(
        executeAIConnectionText(
          { userId, connectionId: connection.id, model: "m", prompt: "p" },
          deps(fetchImpl as typeof fetch),
        ),
      ).rejects.toMatchObject({ code });
      expect(fetchImpl).not.toHaveBeenCalled();
      await prisma.aIConnection.delete({ where: { id: connection.id } });
    }
  });

  it("rejects oversized prompts and empty models", async () => {
    const connection = await makeConnection();
    await expect(
      executeAIConnectionText(
        {
          userId,
          connectionId: connection.id,
          model: "m",
          prompt: "x".repeat(AI_EXECUTION_MAX_PROMPT_BYTES + 1),
        },
        deps(okFetch),
      ),
    ).rejects.toMatchObject({ code: "AI_REQUEST_TOO_LARGE" });
    await expect(
      executeAIConnectionText(
        { userId, connectionId: connection.id, model: " ", prompt: "p" },
        deps(okFetch),
      ),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("maps desktop failure codes onto the business taxonomy", async () => {
    const connection = await makeConnection();
    const cases: [string, string][] = [
      ["RUNTIME_NOT_INSTALLED", "RUNTIME_NOT_INSTALLED"],
      ["RUNTIME_BROKEN", "RUNTIME_BROKEN"],
      ["REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ["CONNECTION_DISCONNECTED", "CONNECTION_DISCONNECTED"],
      ["MODEL_UNAVAILABLE", "MODEL_UNAVAILABLE"],
      ["PERMISSION_BOUNDARY_NOT_READY", "PERMISSION_BOUNDARY_NOT_READY"],
      ["AI_EXECUTION_TIMEOUT", "AI_EXECUTION_TIMEOUT"],
      ["INFERENCE_FAILED", "AI_EXECUTION_FAILED"],
      ["GROK_LEADER_SOCKET_WEIRDNESS", "AI_EXECUTION_FAILED"],
    ];
    for (const [desktopCode, expected] of cases) {
      const fetchImpl: typeof fetch = async () =>
        new Response(JSON.stringify({ ok: false, code: desktopCode }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      await expect(
        executeAIConnectionText(
          { userId, connectionId: connection.id, model: "m", prompt: "p" },
          deps(fetchImpl),
        ),
      ).rejects.toMatchObject({ code: expected });
    }
  });

  it("reports RUNTIME_NOT_AVAILABLE when the desktop channel is absent", async () => {
    const connection = await makeConnection();
    await expect(
      executeAIConnectionText(
        { userId, connectionId: connection.id, model: "m", prompt: "p" },
        { dbClient: prisma as never, execUrl: "", internalToken: "" },
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_NOT_AVAILABLE" });
  });
});

describe("AutomationRun lock-on-create", () => {
  async function makeAutomation() {
    const profile = await prisma.profile.create({ data: { userId } });
    const resume = await prisma.resume.create({
      data: { profileId: profile.id, title: "R" },
    });
    return prisma.automation.create({
      data: {
        userId,
        name: "A",
        jobBoard: "greenhouse",
        keywords: "",
        location: "",
        resumeId: resume.id,
        scheduleHour: 8,
      },
    });
  }

  it("locks resolvedConnectionId + resolvedModel at creation time", async () => {
    const connection = await makeConnection();
    await assign("MATCH_ANALYSIS", connection.id, "gpt-5.5");
    const automation = await makeAutomation();

    const { plan, lock } = await resolveAutomationMatchRuntime(userId);
    expect(plan.kind).toBe("account");
    const run = await prisma.automationRun.create({
      data: { automationId: automation.id, status: "running", ...lock },
    });
    expect(run.resolvedConnectionId).toBe(connection.id);
    expect(run.resolvedModel).toBe("gpt-5.5");
  });

  it("assignment changes never rewrite an existing run's lock", async () => {
    const a = await makeConnection();
    const b = await makeConnection({ displayName: "B" });
    await assign("MATCH_ANALYSIS", a.id, "model-a");
    const automation = await makeAutomation();

    const first = await resolveAutomationMatchRuntime(userId);
    const run = await prisma.automationRun.create({
      data: { automationId: automation.id, status: "running", ...first.lock },
    });
    // Assignment switches to a different account afterwards.
    await setBusinessAssignment({
      userId,
      purpose: "MATCH_ANALYSIS",
      connectionId: b.id,
      model: "model-b",
    });
    const reloaded = await prisma.automationRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(reloaded.resolvedConnectionId).toBe(a.id);
    expect(reloaded.resolvedModel).toBe("model-a");
    // A new run resolves the new assignment.
    const second = await resolveAutomationMatchRuntime(userId);
    expect(second.plan).toMatchObject({ kind: "account", connectionId: b.id });
  });

  it("broken explicit assignment produces an invalid plan and empty lock", async () => {
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "H" });
    await assign("MATCH_ANALYSIS", broken.id, "m");
    await assign("GLOBAL_DEFAULT", healthy.id, "g");
    const { plan, lock } = await resolveAutomationMatchRuntime(userId);
    expect(plan).toMatchObject({
      kind: "invalid",
      code: "CONNECTION_DISCONNECTED",
    });
    expect(lock).toEqual({});
  });

  it("no assignments yields the legacy plan with no lock", async () => {
    const { plan, lock } = await resolveAutomationMatchRuntime(userId);
    expect(plan.kind).toBe("legacy");
    expect(lock).toEqual({});
  });

  it("legacy rows keep null lock fields (NO_GUESS_BACKFILL)", async () => {
    const connection = await makeConnection();
    await assign("MATCH_ANALYSIS", connection.id, "m");
    const automation = await makeAutomation();
    const legacyRun = await prisma.automationRun.create({
      data: { automationId: automation.id, status: "completed" },
    });
    const reloaded = await prisma.automationRun.findUniqueOrThrow({
      where: { id: legacyRun.id },
    });
    expect(reloaded.resolvedConnectionId).toBeNull();
    expect(reloaded.resolvedModel).toBeNull();
  });
});
