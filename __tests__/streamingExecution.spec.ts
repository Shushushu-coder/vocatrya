// Backend streaming client (executeAIConnectionTextStream) — the NDJSON
// consumer for the desktop's /execute-stream, plus the readiness probe.
// The desktop transport is mocked at fetch; the Prisma seam uses a fake db
// so the connection lookup/state gate can be exercised without a DB.
import {
  executeAIConnectionTextStream,
  fetchAccountRuntimeState,
  checkStreamingTurnReadiness,
} from "@/lib/ai/streaming-execution";
import { AIBusinessError } from "@/lib/ai/connections";

const CONNECTION = {
  id: "conn-1",
  status: "CONNECTED",
  archivedAt: null,
  backendKind: "DEVIN_RUNTIME",
  provider: "DEVIN",
};

const db = {
  aIConnection: {
    findFirst: vi.fn(async () => CONNECTION),
  },
};

function ndjson(...events: Record<string, unknown>[]) {
  return new Response(
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

const deps = (fetchImpl: typeof fetch) => ({
  dbClient: db as never,
  execUrl: "http://127.0.0.1:9999",
  internalToken: "t",
  fetchImpl,
});

async function collect(iter: AsyncGenerator<{ type: string }>) {
  const events: unknown[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

const input = {
  userId: "user-1",
  connectionId: "conn-1",
  model: "swe-2",
  prompt: "hello",
};

describe("executeAIConnectionTextStream", () => {
  it("yields normalized deltas then the terminal event", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjson(
        { type: "text-delta", delta: "Hel" },
        { type: "text-delta", delta: "lo" },
        { type: "completed", text: "Hello", model: "swe-2" },
      ),
    );
    const events = await collect(
      executeAIConnectionTextStream(input, deps(fetchImpl as never)),
    );
    expect(events).toEqual([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
      { type: "completed", text: "Hello", model: "swe-2" },
    ]);
    // Bearer token + TEXT_ONLY ticket — the wire stays inside the boundary.
    const init = (fetchImpl.mock.calls[0] as never)[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: "Bearer t",
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      connectionId: "conn-1",
      permissionScope: "TEXT_ONLY",
      model: "swe-2",
    });
    // The wire carries the ticket STRING, not the minted record object —
    // an object ticket fails the desktop's payload shape check (400).
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(0);
  });

  it("surfaces a stream error event as a mapped AIBusinessError", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjson({ type: "error", code: "STREAMING_NOT_VERIFIED" }),
    );
    await expect(
      collect(executeAIConnectionTextStream(input, deps(fetchImpl as never))),
    ).rejects.toMatchObject({
      name: "AIBusinessError",
      code: "STREAMING_NOT_VERIFIED",
    });
  });

  it("fails closed when the stream ends without a terminal event", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjson({ type: "text-delta", delta: "partial" }),
    );
    await expect(
      collect(executeAIConnectionTextStream(input, deps(fetchImpl as never))),
    ).rejects.toMatchObject({ code: "AI_EXECUTION_FAILED" });
  });

  it("fails on malformed NDJSON lines", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json at all\n", { status: 200 }),
    );
    await expect(
      collect(executeAIConnectionTextStream(input, deps(fetchImpl as never))),
    ).rejects.toMatchObject({ code: "AI_EXECUTION_FAILED" });
  });

  it("denies a disconnected connection before any HTTP call", async () => {
    (db.aIConnection.findFirst as any).mockResolvedValueOnce({
      ...CONNECTION,
      status: "DISCONNECTED",
    });
    const fetchImpl = vi.fn();
    await expect(
      collect(executeAIConnectionTextStream(input, deps(fetchImpl as never))),
    ).rejects.toMatchObject({ code: "CONNECTION_DISCONNECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies a foreign/missing connection before any HTTP call", async () => {
    (db.aIConnection.findFirst as any).mockResolvedValueOnce(null);
    const fetchImpl = vi.fn();
    await expect(
      collect(executeAIConnectionTextStream(input, deps(fetchImpl as never))),
    ).rejects.toMatchObject({ code: "ASSIGNED_CONNECTION_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checkStreamingTurnReadiness", () => {
  const connection = {
    backendKind: "DEVIN_RUNTIME",
    provider: "DEVIN",
    authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null,
    status: "CONNECTED",
    archivedAt: null,
  };
  const verified = {
    capabilities: {
      implemented: true,
      execution: {
        localOneShot: true,
        streaming: true,
        streamingVerification: "PASS",
        streamingVerifiedRuntimeVersion: "300.10.31",
      },
    },
    runtimeVersion: "300.10.31",
    runtimeReady: true,
  };

  it("passes a verified runtime at the verified version", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, ...verified })),
    );
    await expect(
      checkStreamingTurnReadiness({
        connection,
        model: "swe-2",
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails STREAMING_NOT_VERIFIED on a runtime version mismatch", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            ...verified,
            runtimeVersion: "300.10.99", // runtime updated after verification
          }),
        ),
    );
    await expect(
      checkStreamingTurnReadiness({
        connection,
        model: "swe-2",
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).rejects.toMatchObject({ code: "STREAMING_NOT_VERIFIED" });
  });

  it("fails STREAMING_NOT_VERIFIED when verification is PENDING", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            ...verified,
            capabilities: {
              ...verified.capabilities,
              execution: {
                ...verified.capabilities.execution,
                streamingVerification: "PENDING",
              },
            },
          }),
        ),
    );
    await expect(
      checkStreamingTurnReadiness({
        connection,
        model: "swe-2",
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).rejects.toMatchObject({ code: "STREAMING_NOT_VERIFIED" });
  });

  it("fails before any fetch when the connection is not usable", async () => {
    const fetchImpl = vi.fn();
    await expect(
      checkStreamingTurnReadiness({
        connection: { ...connection, status: "REAUTH_REQUIRED" },
        model: "swe-2",
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(
      checkStreamingTurnReadiness({
        connection: { ...connection, archivedAt: new Date() },
        model: "swe-2",
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).rejects.toMatchObject({ code: "ASSIGNED_CONNECTION_UNAVAILABLE" });
    await expect(
      checkStreamingTurnReadiness({
        connection,
        model: null,
        deps: { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      }),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fetchAccountRuntimeState", () => {
  it("maps transport failure to BACKEND_UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      fetchAccountRuntimeState(
        { backendKind: "DEVIN_RUNTIME", accountProvider: "DEVIN" },
        { execUrl: "http://x", internalToken: "t", fetchImpl: fetchImpl as never },
      ),
    ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });
});
