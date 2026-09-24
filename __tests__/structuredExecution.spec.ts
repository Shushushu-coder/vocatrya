// @vitest-environment node
/**
 * Business structured-execution seam (executeStructuredForAssignment).
 *
 * Covers:
 * - RESUME assignment resolution → structured execution via the managed
 *   TEXT_ONLY seam (ticketed internal transport, structuredOutput payload)
 * - GLOBAL_DEFAULT fallback resolution; NOT_CONFIGURED passthrough
 * - broken explicit assignment → explicit failure, never a fallback
 * - strict validation: ≤1 retry, same connection/model/schema on retry,
 *   no semantic repair, stable business error taxonomy
 * - desktop-side structured verification gate surfacing as
 *   STRUCTURED_OUTPUT_NOT_VERIFIED
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
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

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

function rpRef() {
  return `rp_${randomUUID()}`;
}

async function makeConnection(overrides: Record<string, unknown> = {}) {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
      displayName: "Devin",
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
  await prisma.aIConnection.deleteMany();
}

beforeAll(async () => {
  userId = await seedAccount(prisma, "structured-exec@example.com");
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

function okResponse(text: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      text,
      durationMs: 5,
      structuredStrategy: "PROMPT_AND_VALIDATE",
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function failResponse(code: string) {
  return new Response(JSON.stringify({ ok: false, code }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(impl: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return impl(bodies[bodies.length - 1]);
  };
  return { bodies, fetchImpl };
}

const deps = (fetchImpl: typeof fetch) => ({
  dbClient: prisma as never,
  execUrl: "http://127.0.0.1:9999",
  internalToken: "test-token",
  fetchImpl,
});

function input(prompt = "task") {
  return {
    userId,
    purpose: "RESUME",
    prompt,
    schema: SCHEMA,
    schemaName: "resume_import_v1",
  };
}

describe("executeStructuredForAssignment", () => {
  it("resolves the RESUME assignment and returns the validated value with lock fields", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "claude-opus-5-5-medium");
    const { bodies, fetchImpl } = captureFetch(() =>
      okResponse('{"name":"x"}'),
    );

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl),
    );

    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.value).toEqual({ name: "x" });
    expect(result.resolvedConnectionId).toBe(connection.id);
    expect(result.resolvedModel).toBe("claude-opus-5-5-medium");
    expect(result.provider).toBe("DEVIN");
    expect(result.backendKind).toBe("DEVIN_RUNTIME");
    expect(result.assignmentSource).toBe("BUSINESS_ASSIGNMENT");
    expect(result.attemptCount).toBe(1);
    expect(result.retried).toBe(false);

    // The wire payload carries identifiers + data only, plus the
    // Vocatrya-owned structured contract — never executable/args/env/cwd.
    const body = bodies[0];
    expect(body).toMatchObject({
      connectionId: connection.id,
      model: "claude-opus-5-5-medium",
      permissionScope: "TEXT_ONLY",
    });
    expect(body.structuredOutput).toEqual({
      schema: SCHEMA,
      schemaName: "resume_import_v1",
    });
    for (const forbidden of [
      "executable",
      "args",
      "env",
      "cwd",
      "workingDirectory",
      "runtimeProfileRef",
      "credentialRef",
      "verificationProbe",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    // The schema rides inside the prompt contract as well.
    expect(String(body.prompt)).toContain('"name"');
    expect(String(body.prompt)).toContain("task");
  });

  it("uses GLOBAL_DEFAULT when no RESUME assignment exists", async () => {
    const connection = await makeConnection();
    await assign("GLOBAL_DEFAULT", connection.id, "model-g");
    const { fetchImpl } = captureFetch(() => okResponse('{"name":"x"}'));

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl),
    );
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.assignmentSource).toBe("GLOBAL_DEFAULT");
    expect(result.resolvedConnectionId).toBe(connection.id);
  });

  it("reports NOT_CONFIGURED without executing when nothing is assigned", async () => {
    const fetchImpl = vi.fn(async () => okResponse("{}"));
    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );
    expect(result).toEqual({ status: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails a broken explicit assignment without falling back or executing", async () => {
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "Other" });
    await assign("RESUME", broken.id, "m-broken");
    await assign("GLOBAL_DEFAULT", healthy.id, "m-healthy");
    const fetchImpl = vi.fn(async () => okResponse("{}"));

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("CONNECTION_DISCONNECTED");
    expect(result.resolution).toMatchObject({
      status: "INVALID_ASSIGNMENT",
      connectionId: broken.id,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails a REAUTH_REQUIRED assignment without legacy fallback", async () => {
    const connection = await makeConnection({ status: "REAUTH_REQUIRED" });
    await assign("RESUME", connection.id, "m");
    const fetchImpl = vi.fn(async () => okResponse("{}"));

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("REAUTH_REQUIRED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the desktop structured-verification gate as STRUCTURED_OUTPUT_NOT_VERIFIED", async () => {
    // A PENDING runtime (e.g. Codex) refuses structured requests at the
    // trusted boundary — simulated here by the desktop response.
    const connection = await makeConnection({
      provider: "OPENAI",
      backendKind: "CODEX_RUNTIME",
      displayName: "ChatGPT via Codex",
    });
    await assign("RESUME", connection.id, "gpt-5.5");
    const fetchImpl = vi.fn(async () =>
      failResponse("STRUCTURED_OUTPUT_NOT_VERIFIED"),
    );

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STRUCTURED_OUTPUT_NOT_VERIFIED");
    // Execution-layer failure is terminal — no repair retry on a gate.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once with the same connection/model/schema and succeeds", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "m-1");
    let calls = 0;
    const { bodies, fetchImpl } = captureFetch(() =>
      calls++ === 0 ? okResponse("not json at all") : okResponse('{"name":"x"}'),
    );

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl),
    );

    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.attemptCount).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.value).toEqual({ name: "x" });
    // The retry is the same locked pair + same schema; only the prompt
    // gains the validator's issue summary.
    for (const body of bodies) {
      expect(body.connectionId).toBe(connection.id);
      expect(body.model).toBe("m-1");
      expect(body.structuredOutput).toEqual({
        schema: SCHEMA,
        schemaName: "resume_import_v1",
      });
    }
    expect(bodies).toHaveLength(2);
    expect(String(bodies[1].prompt)).toContain(
      "failed local schema validation",
    );
  });

  it("stops after one repair attempt — never a retry loop", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "m-1");
    const fetchImpl = vi.fn(async () => okResponse("still not json"));

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STRUCTURED_OUTPUT_RETRY_EXHAUSTED");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps schema-valid-but-wrong-shape to the structured taxonomy", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "m-1");
    const fetchImpl = vi.fn(async () => okResponse('{"name":5}'));

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STRUCTURED_OUTPUT_RETRY_EXHAUSTED");
    // Attempts carry category detail for diagnostics — never raw text.
    const last = result.attempts[result.attempts.length - 1];
    expect(last.outcome).toBe("SCHEMA_FAILED");
  });

  it("maps a truncated envelope to STRUCTURED_OUTPUT_TRUNCATED", async () => {
    const connection = await makeConnection();
    await assign("RESUME", connection.id, "m-1");
    const fetchImpl = vi.fn(async () =>
      okResponse("not json", { stopReason: "max_tokens" }),
    );

    const result = await executeStructuredForAssignment(
      input(),
      deps(fetchImpl as typeof fetch),
    );
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STRUCTURED_OUTPUT_TRUNCATED");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects schemas outside the supported subset before resolving", async () => {
    const fetchImpl = vi.fn(async () => okResponse("{}"));
    const result = await executeStructuredForAssignment(
      {
        userId,
        purpose: "RESUME",
        prompt: "p",
        schema: {
          type: "object",
          properties: { a: { anyOf: [{ type: "string" }] } },
        },
        schemaName: "x",
      },
      deps(fetchImpl as typeof fetch),
    );
    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STRUCTURED_OUTPUT_UNSUPPORTED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("each operation re-resolves; a retry never re-resolves", async () => {
    const a = await makeConnection();
    const b = await makeConnection({ displayName: "B" });
    await assign("RESUME", a.id, "m-a");

    const first = captureFetch(() => okResponse('{"name":"x"}'));
    const r1 = await executeStructuredForAssignment(
      input(),
      deps(first.fetchImpl),
    );
    expect(r1.status).toBe("OK");
    if (r1.status !== "OK") return;
    expect(r1.resolvedConnectionId).toBe(a.id);

    // Assignment changes only affect the NEXT operation.
    await prisma.aIBusinessAssignment.updateMany({
      where: { userId, purpose: "RESUME" },
      data: { connectionId: b.id, model: "m-b" },
    });
    const second = captureFetch(() => okResponse('{"name":"y"}'));
    const r2 = await executeStructuredForAssignment(
      input(),
      deps(second.fetchImpl),
    );
    expect(r2.status).toBe("OK");
    if (r2.status !== "OK") return;
    expect(r2.resolvedConnectionId).toBe(b.id);
    expect(r2.resolvedModel).toBe("m-b");
  });
});
