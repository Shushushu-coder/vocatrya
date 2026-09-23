// Internal loopback API contract: bearer auth, single-use ticket resolve,
// and the only writes to AIConnection rows for runtime operations.
import { POST as resolvePOST } from "@/app/api/internal/ai-connections/resolve/route";
import { POST as completePOST } from "@/app/api/internal/ai-connections/complete/route";
import {
  mintConnectionTicket,
  resetConnectionTickets,
} from "@/lib/ai/connection-tickets";

const store = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    aIConnection: {
      findUnique: store.findUnique,
      findMany: vi.fn(),
      count: store.count,
      create: store.create,
      update: store.update,
    },
  },
}));

const TOKEN = "test-internal-token";
const RP = "rp_11111111-1111-4111-8111-111111111111";

const req = (body: unknown, token: string | null = TOKEN) =>
  ({
    json: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" && token
          ? `Bearer ${token}`
          : null,
    },
  }) as any;

function connRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    userId: "user-1",
    provider: "OPENAI",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CODEX_RUNTIME",
    displayName: "ChatGPT",
    accountIdentity: "first@example.com",
    status: "CONNECTED",
    credentialRef: null,
    runtimeProfileRef: RP,
    lastVerifiedAt: null,
    archivedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  resetConnectionTickets();
  process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN = TOKEN;
  store.findUnique.mockReset();
  store.count.mockReset();
  store.create.mockReset();
  store.update.mockReset();
});

afterEach(() => {
  delete process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
});

describe("POST /api/internal/ai-connections/resolve", () => {
  it("fails closed when the internal token is not configured", async () => {
    delete process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
    const res = await resolvePOST(req({ ticket: "x" }));
    expect(res.status).toBe(404);
  });

  it("rejects missing/invalid bearer tokens", async () => {
    for (const token of [null, "wrong"]) {
      const res = await resolvePOST(req({ ticket: "x" }, token));
      expect(res.status).toBe(401);
    }
  });

  it("resolves a login ticket into an operationId", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const res = await resolvePOST(req({ ticket: record.ticket }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      operation: "login",
      backendKind: "CODEX_RUNTIME",
      operationId: record.operationId,
    });
    // Single-use: the same ticket resolves nothing the second time.
    const replay = await resolvePOST(req({ ticket: record.ticket }));
    expect(replay.status).toBe(400);
  });

  it("carries the minted accountProvider to the runtime for login", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENAI",
    });
    const res = await resolvePOST(req({ ticket: record.ticket }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.accountProvider).toBe("OPENAI");
  });

  it("returns the verified connection context for connection ops", async () => {
    store.findUnique.mockResolvedValue(connRow());
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "reconnect",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    const res = await resolvePOST(req({ ticket: record.ticket }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.connection.id).toBe("c1");
    expect(data.connection.runtimeProfileRef).toBe(RP);
    // The response carries opaque refs only — never userId or secrets.
    expect(data.connection.userId).toBeUndefined();
  });

  it("404s when the connection does not belong to the ticket's user", async () => {
    store.findUnique.mockResolvedValue(connRow({ userId: "other-user" }));
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "disconnect",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    const res = await resolvePOST(req({ ticket: record.ticket }));
    const data = await res.json();
    expect(res.status).toBe(404);
    expect(data.code).toBe("CONNECTION_NOT_FOUND");
  });
});

describe("POST /api/internal/ai-connections/complete", () => {
  it("creates the AIConnection only for a verified login outcome", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);

    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();

    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: RP,
          accountIdentity: "me@example.com",
        },
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          provider: "OPENAI",
          authType: "ACCOUNT_LOGIN",
          backendKind: "CODEX_RUNTIME",
          status: "CONNECTED",
          credentialRef: null,
          runtimeProfileRef: RP,
          accountIdentity: "me@example.com",
          displayName: "ChatGPT",
        }),
      }),
    );
    // The created row must not carry a model or any credential material.
    const created = store.create.mock.calls[0][0].data;
    expect(Object.keys(created)).not.toContain("model");
    expect(JSON.stringify(created)).not.toMatch(/sk-|token|auth\.json/i);
  });

  it("creates a Claude connection with whitelisted provider metadata", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);

    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CLAUDE_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();

    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "ANTHROPIC",
          runtimeProfileRef: RP,
          accountIdentity: "me@example.com",
          providerMetadata: {
            organizationName: "My Org",
            subscriptionType: "pro",
            loginMethod: "claude.ai",
          },
        },
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const created = store.create.mock.calls[0][0].data;
    expect(created.provider).toBe("ANTHROPIC");
    expect(created.backendKind).toBe("CLAUDE_RUNTIME");
    expect(created.displayName).toBe("Claude");
    expect(created.providerMetadata).toBe(
      '{"organizationName":"My Org","subscriptionType":"pro","loginMethod":"claude.ai"}',
    );
  });

  it("creates an OpenCode connection as OPENAI, never OPENCODE", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);

    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENAI",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    expect(resolved.accountProvider).toBe("OPENAI");

    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: RP,
          accountIdentity: null,
        },
      }),
    );
    expect(res.status).toBe(200);
    const created = store.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      provider: "OPENAI",
      backendKind: "OPENCODE_RUNTIME",
      authType: "ACCOUNT_LOGIN",
      displayName: "ChatGPT via OpenCode",
      credentialRef: null,
    });
  });

  it("rejects a completion whose verifiedProvider mismatches the ticket", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENAI",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "GITHUB_COPILOT",
          runtimeProfileRef: RP,
        },
      }),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects the runtime vendor persisted as an ACCOUNT_LOGIN provider", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      // A forged/minted OPENCODE request still cannot complete — the
      // runtime vendor is not a supported account provider.
      accountProvider: null,
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENCODE",
          runtimeProfileRef: RP,
        },
      }),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects a login completion whose metadata carries credential keys", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CLAUDE_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "ANTHROPIC",
          runtimeProfileRef: RP,
          providerMetadata: { refreshToken: "not-allowed" },
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects a login completion without the verified outcome", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: { outcome: "auth_state", authState: "AUTHENTICATED" },
      }),
    );
    expect(res.status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects a login completion with a malformed profile ref", async () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: "..\\..\\escape",
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("operationId is consumed — a second completion is rejected", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: RP,
        },
      }),
    );
    const replay = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "authenticated",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: RP,
        },
      }),
    );
    expect(replay.status).toBe(400);
  });

  it("disconnect marks the row DISCONNECTED and keeps everything else", async () => {
    store.findUnique.mockResolvedValue(connRow());
    store.update.mockImplementation(async ({ data }) => data);
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "disconnect",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({ operationId: resolved.operationId, result: { outcome: "disconnected" } }),
    );
    expect(res.status).toBe(200);
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: { status: "DISCONNECTED" },
      }),
    );
  });

  it("identity conflict returns the specific code and marks ERROR", async () => {
    store.findUnique.mockResolvedValue(connRow());
    store.update.mockImplementation(async ({ data }) => ({
      ...connRow(),
      ...data,
    }));
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "reconnect",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({
        operationId: resolved.operationId,
        result: {
          outcome: "identity_conflict",
          accountIdentity: "other@example.com",
        },
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe("ACCOUNT_IDENTITY_CONFLICT");
    expect(data.connection.status).toBe("ERROR");
  });

  it("read-only ops consume their ticket without mutating rows", async () => {
    store.findUnique.mockResolvedValue(connRow());
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "listModels",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    const resolved = await (
      await resolvePOST(req({ ticket: record.ticket }))
    ).json();
    const res = await completePOST(
      req({ operationId: resolved.operationId, result: { outcome: "consumed" } }),
    );
    expect(res.status).toBe(200);
    expect(store.update).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });
});
