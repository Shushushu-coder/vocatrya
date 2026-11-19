// @vitest-environment node
/**
 * Interview assignment migration — session creation-time locking and
 * locked execution.
 *
 * Covers:
 * - INTERVIEW assignment → legacy settings.ai.interview → GLOBAL_DEFAULT
 *   → NOT_CONFIGURED precedence at session creation
 * - broken explicit assignment fails creation explicitly (no fallback)
 * - resolvedConnectionId + resolvedModel persisted atomically with the
 *   session; later assignment/global/legacy changes never retarget it
 * - locked account sessions execute through the TEXT_ONLY seam with the
 *   locked pair; retries and reloads reuse the lock (no re-resolve)
 * - locked connections that turn archived / REAUTH_REQUIRED /
 *   DISCONNECTED fail with explicit business codes
 * - legacy-locked sessions keep their creation-time provider/model even
 *   after settings.ai.interview changes; historical null-lock sessions
 *   keep live legacy resolution (NO_GUESS_BACKFILL)
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { AIBusinessError } from "@/lib/ai/connections";
import { createInterviewRuntime } from "@/lib/interview/services/application";
import { VocatryaInterviewModelAdapter } from "@/lib/interview/vocatryaHostPorts";
import {
  sessionAiLockFromRow,
  encodeLegacyInterviewLock,
} from "@/lib/interview/sessionAiLock";
import { StaticKnowledgeProvider } from "@/lib/interview/services/knowledge";
import type { ResolvedInterviewModel } from "@/lib/interview/interviewModelResolver";

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
const helpers = await import("./helpers/backupTestDb");

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
  return prisma.aIBusinessAssignment.upsert({
    where: { userId_purpose: { userId, purpose } },
    create: { userId, purpose, connectionId, model },
    update: { connectionId, model },
  });
}

async function setLegacyInterview(provider = "openai", model = "gpt-4o-mini") {
  await prisma.userSettings.upsert({
    where: { userId },
    create: {
      userId,
      settings: JSON.stringify({
        ai: { provider: "ollama", model: "llama3.2", interview: { provider, model } },
      }),
    },
    update: {
      settings: JSON.stringify({
        ai: { provider: "ollama", model: "llama3.2", interview: { provider, model } },
      }),
    },
  });
}

const FEEDBACK_PAYLOAD = {
  feedbackItems: [
    {
      problemLabel: "Missing Situation Context",
      suggestion: "Add the team and constraint first.",
      evidence: {
        transcriptExcerpt: "I led the launch",
        startOffset: 99,
        endOffset: 101,
        problemStatement: "Situation missing",
        groundingSources: [],
      },
      explanation: {
        underlyingCause: "Jumped to action",
        performanceImpact: "Hard to judge scope",
        interviewerPerspective: null,
      },
    },
  ],
};

const ANSWER_TEXT =
  "I led the launch of a billing rewrite under a two-week freeze.";

function fakeExecText(text: string | ((prompt: string) => string)) {
  return vi.fn(
    async (input: {
      userId: string;
      connectionId: string;
      model: string;
      prompt: string;
    }) => ({
      text:
        typeof text === "string"
          ? text
          : text(input.prompt),
    }),
  );
}

function fakeResolver(model: ResolvedInterviewModel) {
  return {
    resolve: vi.fn(async () => model),
    resolveForConfig: vi.fn(
      async (_userId: string, config: { provider: string; model: string }) => ({
        provider: config.provider,
        model: config.model,
        generateJson: model.generateJson,
      }),
    ),
  };
}

function generateJsonStub(payload: unknown) {
  return vi.fn(async () => payload);
}

function runtime(opts: {
  execText?: ReturnType<typeof fakeExecText>;
  resolver?: ReturnType<typeof fakeResolver>;
}) {
  const adapter = new VocatryaInterviewModelAdapter(
    prisma as never,
    opts.resolver,
    opts.execText,
  );
  return createInterviewRuntime({
    db: prisma,
    modelPort: adapter,
    knowledge: new StaticKnowledgeProvider("v1.0", "KB excerpt", "hash-v1"),
  });
}

async function createSession(app: ReturnType<typeof runtime>) {
  return app.createInterviewSession({
    userId,
    coachingMode: "PRACTICE",
    questions: [{ displayedText: "Tell me about a launch." }],
  });
}

async function sessionRow(sessionId: string) {
  return prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
}

beforeEach(async () => {
  await helpers.resetDisposableDb(prisma);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  userId = await helpers.seedAccount(prisma, `il-a-${stamp}@example.com`);
  otherUserId = await helpers.seedAccount(prisma, `il-b-${stamp}@example.com`);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const fs = await import("node:fs");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

describe("session creation lock", () => {
  it("locks an explicit INTERVIEW assignment onto the new session", async () => {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const { session } = await createSession(runtime({}));
    const row = await sessionRow(session.id);
    expect(row.resolvedConnectionId).toBe(connection.id);
    expect(row.resolvedModel).toBe("gpt-5.5");
  });

  it("assignment change never retargets an existing session", async () => {
    const a = await makeConnection();
    const b = await makeConnection({ displayName: "B" });
    await assign("INTERVIEW", a.id, "model-a");
    const app = runtime({});
    const { session: first } = await createSession(app);

    await assign("INTERVIEW", b.id, "model-b");
    const { session: second } = await createSession(app);

    const firstRow = await sessionRow(first.id);
    const secondRow = await sessionRow(second.id);
    expect(firstRow.resolvedConnectionId).toBe(a.id);
    expect(firstRow.resolvedModel).toBe("model-a");
    expect(secondRow.resolvedConnectionId).toBe(b.id);
    expect(secondRow.resolvedModel).toBe("model-b");
  });

  it("GLOBAL_DEFAULT locks the session when no assignment or legacy config exists", async () => {
    const a = await makeConnection();
    const b = await makeConnection({ displayName: "B" });
    await assign("GLOBAL_DEFAULT", a.id, "global-a");
    const app = runtime({});
    const { session: first } = await createSession(app);

    await assign("GLOBAL_DEFAULT", b.id, "global-b");
    const { session: second } = await createSession(app);

    expect((await sessionRow(first.id)).resolvedConnectionId).toBe(a.id);
    expect((await sessionRow(first.id)).resolvedModel).toBe("global-a");
    expect((await sessionRow(second.id)).resolvedConnectionId).toBe(b.id);
  });

  it("broken explicit INTERVIEW assignment fails creation — never falls back", async () => {
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "H" });
    await assign("INTERVIEW", broken.id, "m");
    await assign("GLOBAL_DEFAULT", healthy.id, "g");
    await setLegacyInterview();

    await expect(createSession(runtime({}))).rejects.toMatchObject({
      code: "CONNECTION_DISCONNECTED",
    });
    expect(await prisma.interviewSession.count()).toBe(0);
  });

  it("legacy config locks provider/model without fabricating a connection", async () => {
    await setLegacyInterview("gemini", "gemini-2.0-flash");
    const healthy = await makeConnection();
    await assign("GLOBAL_DEFAULT", healthy.id, "g");

    const { session } = await createSession(runtime({}));
    const row = await sessionRow(session.id);
    expect(row.resolvedConnectionId).toBeNull();
    expect(sessionAiLockFromRow(row)).toEqual({
      kind: "legacy",
      provider: "gemini",
      model: "gemini-2.0-flash",
    });
    expect(row.resolvedModel).toBe(
      encodeLegacyInterviewLock("gemini", "gemini-2.0-flash"),
    );
  });

  it("nothing configured creates an unlocked session (legacy semantics)", async () => {
    const { session } = await createSession(runtime({}));
    const row = await sessionRow(session.id);
    expect(row.resolvedConnectionId).toBeNull();
    expect(row.resolvedModel).toBeNull();
    expect(sessionAiLockFromRow(row)).toEqual({ kind: "unlocked" });
  });

  it("clearing the INTERVIEW assignment returns new sessions to legacy/global; old sessions keep the lock", async () => {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const app = runtime({});
    const { session: locked } = await createSession(app);

    await prisma.aIBusinessAssignment.delete({
      where: { userId_purpose: { userId, purpose: "INTERVIEW" } },
    });
    await setLegacyInterview();
    const { session: fallback } = await createSession(app);

    expect((await sessionRow(locked.id)).resolvedConnectionId).toBe(
      connection.id,
    );
    const fallbackRow = await sessionRow(fallback.id);
    expect(fallbackRow.resolvedConnectionId).toBeNull();
    expect(sessionAiLockFromRow(fallbackRow)).toEqual({
      kind: "legacy",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });
});

describe("locked account execution", () => {
  async function lockedSession(model = "gpt-5.5") {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, model);
    const execText = fakeExecText((prompt) =>
      prompt.includes("FEEDBACK_GENERATION")
        ? JSON.stringify(FEEDBACK_PAYLOAD)
        : prompt.includes("SESSION_SUMMARY")
          ? JSON.stringify({
              bodyText: "Solid summary.",
              structuredPayload: {},
            })
          : JSON.stringify({ reply: "Try opening with the constraint." }),
    );
    const app = runtime({ execText });
    const { session, instances } = await createSession(app);
    return { connection, execText, app, session, instances };
  }

  it("runs feedback through the locked connection and records provenance", async () => {
    const { connection, execText, app, session, instances } =
      await lockedSession();
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(feedback.generation.status).toBe("SUCCEEDED");
    expect(feedback.generation.provider).toBe("OPENAI");
    expect(feedback.generation.model).toBe("gpt-5.5");
    expect(execText).toHaveBeenCalledTimes(1);
    const call = execText.mock.calls[0][0];
    expect(call.connectionId).toBe(connection.id);
    expect(call.model).toBe("gpt-5.5");
    expect(call.userId).toBe(userId);
    // Deterministic system+prompt flatten, transcript included once.
    expect(call.prompt).toContain("FEEDBACK_GENERATION");
    expect(call.prompt).toContain(ANSWER_TEXT);
    expect(call.prompt).toContain("interview coach");
  });

  it("follow-up and summary reuse the same locked pair", async () => {
    const { connection, execText, app, session, instances } =
      await lockedSession("locked-model");
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    const turn = await app.sendInterviewFollowUp({
      userId,
      sessionId: session.id,
      userText: "How should I open?",
      targetType: "SESSION",
    });
    expect(turn.assistantReply).toContain("constraint");
    expect(turn.replyModel).toBe("locked-model");

    const summary = await app.generateInterviewSummary({
      userId,
      sessionId: session.id,
    });
    expect(summary.generation.status).toBe("SUCCEEDED");
    expect(summary.generation.model).toBe("locked-model");
    for (const call of execText.mock.calls) {
      expect(call[0].connectionId).toBe(connection.id);
      expect(call[0].model).toBe("locked-model");
    }
  });

  it("retry after an assignment switch still uses the session lock", async () => {
    const { connection, execText, app, session, instances } =
      await lockedSession();
    const other = await makeConnection({ displayName: "B" });
    await assign("INTERVIEW", other.id, "model-b");

    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const first = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    // Simulate a reload: a fresh runtime reads the persisted lock only. A
    // plain repeat is served from the succeeded generation, so request an
    // explicit regeneration to reach the model again.
    const app2 = runtime({ execText });
    await app2.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
      inputRevisionId: first.generation.inputRevisionId,
    });
    expect(execText).toHaveBeenCalledTimes(2);
    for (const call of execText.mock.calls) {
      expect(call[0].connectionId).toBe(connection.id);
      expect(call[0].model).toBe("gpt-5.5");
    }
    expect(session.id).toBeTruthy();
  });

  it("archived / reauth / disconnected locked connections fail explicitly", async () => {
    const { connection, app, instances } = await lockedSession();
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });

    await prisma.aIConnection.update({
      where: { id: connection.id },
      data: { status: "REAUTH_REQUIRED" },
    });
    await expect(
      app.generateInterviewFeedback({
        userId,
        answerAttemptId: submitted.attempt.id,
      }),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });

    await prisma.aIConnection.update({
      where: { id: connection.id },
      data: { status: "DISCONNECTED" },
    });
    await expect(
      app.sendInterviewFollowUp({
        userId,
        sessionId: (
          await prisma.answerAttempt.findUniqueOrThrow({
            where: { id: submitted.attempt.id },
          })
        ).sessionId,
        userText: "next?",
        targetType: "SESSION",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_DISCONNECTED" });

    await prisma.aIConnection.update({
      where: { id: connection.id },
      data: { status: "CONNECTED", archivedAt: new Date() },
    });
    await expect(
      app.generateInterviewFeedback({
        userId,
        answerAttemptId: submitted.attempt.id,
      }),
    ).rejects.toMatchObject({ code: "ASSIGNED_CONNECTION_UNAVAILABLE" });
  });

  it("mid-call business failures keep their stable code on the generation", async () => {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const execText = vi.fn(async () => {
      throw new AIBusinessError("AI_EXECUTION_TIMEOUT", "timed out");
    });
    const app = runtime({ execText });
    const { session, instances } = await createSession(app);
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(feedback.generation.status).toBe("FAILED");
    expect(feedback.generation.failureCode).toBe("AI_EXECUTION_TIMEOUT");
    void session;
  });

  it("non-JSON output fails without leaking model text into diagnostics", async () => {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const execText = fakeExecText("this is not json at all");
    const app = runtime({ execText });
    const { instances } = await createSession(app);
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(feedback.generation.status).toBe("FAILED");
    expect(feedback.generation.failureCode).toBe("GENERATION_FAILED");
    expect(feedback.generation.failureMessage ?? "").not.toContain(
      "this is not json at all",
    );
    expect(feedback.generation.failureMessage ?? "").not.toContain(
      ANSWER_TEXT,
    );
  });

  it("a locked session never resolves for another user", async () => {
    const connection = await makeConnection();
    await assign("INTERVIEW", connection.id, "gpt-5.5");
    const app = runtime({ execText: fakeExecText("{}") });
    const { session } = await createSession(app);
    const adapter = new VocatryaInterviewModelAdapter(
      prisma as never,
      fakeResolver({
        provider: "legacy",
        model: "legacy-m",
        generateJson: generateJsonStub({}),
      }),
      fakeExecText("{}"),
    );
    await expect(
      adapter.resolveInterviewModel({
        requestingUserId: otherUserId,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "SESSION_FORBIDDEN" });
  });
});

describe("legacy and unlocked sessions", () => {
  it("legacy-locked session keeps its creation-time pair after settings change", async () => {
    await setLegacyInterview("openai", "gpt-4o-mini");
    const resolver = fakeResolver({
      provider: "unused",
      model: "unused",
      generateJson: generateJsonStub(FEEDBACK_PAYLOAD),
    });
    const execText = fakeExecText("{}");
    const app = runtime({ execText, resolver });
    const { session, instances } = await createSession(app);

    // User re-points legacy settings after the session was created.
    await setLegacyInterview("gemini", "gemini-2.0-flash");

    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(feedback.generation.status).toBe("SUCCEEDED");
    expect(feedback.generation.provider).toBe("openai");
    expect(feedback.generation.model).toBe("gpt-4o-mini");
    expect(resolver.resolveForConfig).toHaveBeenCalledWith(userId, {
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(execText).not.toHaveBeenCalled();
    void session;
  });

  it("unlocked (historical-style) session uses live legacy resolution", async () => {
    const resolver = fakeResolver({
      provider: "live",
      model: "live-m",
      generateJson: generateJsonStub(FEEDBACK_PAYLOAD),
    });
    const app = runtime({ resolver });
    const { instances } = await createSession(app);
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(resolver.resolve).toHaveBeenCalledWith(userId);
    expect(resolver.resolveForConfig).not.toHaveBeenCalled();
  });
});
