import {
  completeConnectionOperation,
  mintConnectionTicket,
  resetConnectionTickets,
  resolveConnectionTicket,
  CONNECTION_TICKET_TTL_MS,
} from "@/lib/ai/connection-tickets";
import {
  applyDisconnect,
  applyReconnectAuthenticated,
  applyReconnectIdentityConflict,
  applyVerifyResult,
  ConnectionOpError,
  createVerifiedAccountConnection,
  getConnectionOperationContext,
  listConnectionsForUser,
  mapAuthStateToConnectionStatus,
} from "@/lib/ai/connection-service";
import { mintAiConnectionTicket } from "@/actions/aiConnection.actions";
import { getCurrentUser } from "@/utils/user.utils";

vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));

const store = vi.hoisted(() => ({
  rows: [] as any[],
  findUnique: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    aIConnection: {
      findUnique: store.findUnique,
      findMany: store.findMany,
      count: store.count,
      create: store.create,
      update: store.update,
    },
  },
}));

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const RP = "rp_11111111-1111-4111-8111-111111111111";
const USER = { id: "user-1", name: "U", email: "u@example.com" };

function fakeDb() {
  return {
    aIConnection: {
      findUnique: store.findUnique,
      findMany: store.findMany,
      count: store.count,
      create: store.create,
      update: store.update,
    },
  } as any;
}

beforeEach(() => {
  resetConnectionTickets();
  store.rows = [];
  store.findUnique.mockReset();
  store.findMany.mockReset();
  store.count.mockReset();
  store.create.mockReset();
  store.update.mockReset();
});

describe("connection tickets", () => {
  it("a freshly minted ticket resolves immediately — never pre-expired", () => {
    // Regression for the "session expired" bug: a minted ticket must be
    // resolvable on the very next call.
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    const resolved = resolveConnectionTicket(record.ticket);
    expect(resolved).not.toBeNull();
    expect(resolved?.ticket).toBe(record.ticket);
  });

  it("shares one store across module instances (standalone-bundle parity)", async () => {
    // In the Next standalone server each route/page is a self-contained
    // webpack bundle — the ticket module exists once per bundle. The
    // store must therefore live on globalThis, or a ticket minted by the
    // settings page's server action is invisible to the /resolve route.
    // vi.resetModules() + a fresh dynamic import produces exactly that
    // second module instance inside this test process.
    const mintSide = await import("@/lib/ai/connection-tickets");
    const record = mintSide.mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENCODE_GO",
    });
    vi.resetModules();
    const routeSide = await import("@/lib/ai/connection-tickets");
    const resolved = routeSide.resolveConnectionTicket(record.ticket);
    expect(resolved).not.toBeNull();
    expect(resolved?.operationId).toBe(record.operationId);
    expect(resolved?.accountProvider).toBe("OPENCODE_GO");
    // Complete also crosses instances — the full lifecycle works
    // independent of which bundle each caller lives in.
    const completed = routeSide.completeConnectionOperation(record.operationId);
    expect(completed?.ticket).toBe(record.ticket);
  });

  it("mint → resolve → complete is single-use at each step", () => {
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    expect(record.ticket).toBeTruthy();
    expect(record.operationId).toMatch(/^op_/);

    const resolved = resolveConnectionTicket(record.ticket);
    expect(resolved?.operationId).toBe(record.operationId);
    // Second resolve replays nothing.
    expect(resolveConnectionTicket(record.ticket)).toBeNull();

    const completed = completeConnectionOperation(record.operationId);
    expect(completed?.ticket).toBe(record.ticket);
    expect(completeConnectionOperation(record.operationId)).toBeNull();
  });

  it("expires tickets only at the TTL boundary", () => {
    const now = 1_000_000;
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
      now,
    });
    // Still valid one ms before the TTL — expiry is time-based, never
    // a lookup artifact.
    expect(
      resolveConnectionTicket(record.ticket, {
        now: now + CONNECTION_TICKET_TTL_MS - 1,
      }),
    ).not.toBeNull();
    expect(
      resolveConnectionTicket(record.ticket, {
        now: now + CONNECTION_TICKET_TTL_MS + 1,
      }),
    ).toBeNull();
  });

  it("rejects unknown tickets", () => {
    expect(resolveConnectionTicket("nope")).toBeNull();
  });
});

describe("connection service", () => {
  it("creates a CONNECTED row only with a valid profile ref", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);

    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CODEX_RUNTIME",
        verifiedProvider: "OPENAI",
        runtimeProfileRef: RP,
        accountIdentity: "me@example.com",
      },
      fakeDb(),
    );
    expect(row).toMatchObject({
      provider: "OPENAI",
      authType: "ACCOUNT_LOGIN",
      backendKind: "CODEX_RUNTIME",
      displayName: "ChatGPT via Codex",
      accountIdentity: "me@example.com",
      status: "CONNECTED",
      credentialRef: null,
      runtimeProfileRef: RP,
    });
    // No model, no token, no absolute profile path is ever persisted.
    expect(JSON.stringify(row)).not.toMatch(/model|token|AppData|CODEX_HOME/i);
  });

  it("persists OPENCODE_GO/ZEN + backendKind=OPENCODE_RUNTIME for OpenCode login", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);

    for (const [provider, displayName] of [
      ["OPENCODE_GO", "OpenCode Go"],
      ["OPENCODE_ZEN", "OpenCode Zen"],
    ] as const) {
      const row = await createVerifiedAccountConnection(
        {
          userId: "user-1",
          backendKind: "OPENCODE_RUNTIME",
          verifiedProvider: provider,
          runtimeProfileRef: RP,
          accountIdentity: null,
        },
        fakeDb(),
      );
      // The verified product wins — never "OPENCODE" (the runtime
      // vendor) and never "OPENAI" (removed ChatGPT semantics).
      expect(row).toMatchObject({
        provider,
        authType: "ACCOUNT_LOGIN",
        backendKind: "OPENCODE_RUNTIME",
        displayName,
        status: "CONNECTED",
        credentialRef: null,
        runtimeProfileRef: RP,
      });
    }
  });

  it("numbers OpenCode Go accounts independently from other pairings", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);
    const first = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "OPENCODE_RUNTIME",
        verifiedProvider: "OPENCODE_GO",
        runtimeProfileRef: RP,
        accountIdentity: null,
      },
      fakeDb(),
    );
    expect(store.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "OPENCODE_GO",
          backendKind: "OPENCODE_RUNTIME",
        }),
      }),
    );
    expect(first.displayName).toBe("OpenCode Go");

    store.count.mockResolvedValue(1);
    const second = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "OPENCODE_RUNTIME",
        verifiedProvider: "OPENCODE_GO",
        runtimeProfileRef: RP,
        accountIdentity: null,
      },
      fakeDb(),
    );
    expect(second.displayName).toBe("OpenCode Go 2");
  });

  it("rejects provider/runtime combinations outside the matrix", async () => {
    for (const [backendKind, verifiedProvider] of [
      // The runtime vendor is never an ACCOUNT_LOGIN provider.
      ["OPENCODE_RUNTIME", "OPENCODE"],
      // Anthropic through OpenCode is not a supported account-login path.
      ["OPENCODE_RUNTIME", "ANTHROPIC"],
      // ChatGPT-via-OpenCode was removed — OpenAI never authenticates
      // through the OpenCode runtime.
      ["OPENCODE_RUNTIME", "OPENAI"],
      // OpenAI cannot authenticate through Claude Code.
      ["CLAUDE_RUNTIME", "OPENAI"],
      // Codex only authenticates OpenAI.
      ["CODEX_RUNTIME", "ANTHROPIC"],
    ] as const) {
      await expect(
        createVerifiedAccountConnection(
          {
            userId: "user-1",
            backendKind,
            verifiedProvider,
            runtimeProfileRef: RP,
            accountIdentity: null,
          },
          fakeDb(),
        ),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
      });
    }
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized verified provider", async () => {
    await expect(
      createVerifiedAccountConnection(
        {
          userId: "user-1",
          backendKind: "OPENCODE_RUNTIME",
          verifiedProvider: "MYSTERY",
          runtimeProfileRef: RP,
          accountIdentity: null,
        },
        fakeDb(),
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
    });
  });

  it("numbers additional ChatGPT accounts", async () => {
    store.count.mockResolvedValue(2);
    store.create.mockImplementation(async ({ data }) => data);
    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CODEX_RUNTIME",
        verifiedProvider: "OPENAI",
        runtimeProfileRef: RP,
        accountIdentity: null,
      },
      fakeDb(),
    );
    expect(row.displayName).toBe("ChatGPT via Codex 3");
  });

  it("creates a Claude account-login connection with whitelisted metadata", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);
    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CLAUDE_RUNTIME",
        verifiedProvider: "ANTHROPIC",
        runtimeProfileRef: RP,
        accountIdentity: "me@example.com",
        providerMetadata: {
          organizationName: "My Org",
          subscriptionType: "pro",
          loginMethod: "claude.ai",
        },
      },
      fakeDb(),
    );
    expect(row).toMatchObject({
      provider: "ANTHROPIC",
      authType: "ACCOUNT_LOGIN",
      backendKind: "CLAUDE_RUNTIME",
      displayName: "Claude",
      accountIdentity: "me@example.com",
      status: "CONNECTED",
      credentialRef: null,
      runtimeProfileRef: RP,
      providerMetadata:
        '{"organizationName":"My Org","subscriptionType":"pro","loginMethod":"claude.ai"}',
    });
    // No model, no token, no absolute profile path is ever persisted.
    expect(JSON.stringify(row)).not.toMatch(/accesstoken|AppData|CLAUDE_CONFIG_DIR/i);
  });

  it("numbers additional Claude accounts", async () => {
    store.count.mockResolvedValue(1);
    store.create.mockImplementation(async ({ data }) => data);
    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CLAUDE_RUNTIME",
        verifiedProvider: "ANTHROPIC",
        runtimeProfileRef: RP,
        accountIdentity: null,
      },
      fakeDb(),
    );
    expect(row.displayName).toBe("Claude 2");
  });

  it("rejects provider metadata carrying credential-shaped keys", async () => {
    await expect(
      createVerifiedAccountConnection(
        {
          userId: "user-1",
          backendKind: "CLAUDE_RUNTIME",
          verifiedProvider: "ANTHROPIC",
          runtimeProfileRef: RP,
          accountIdentity: null,
          providerMetadata: { oauthAccessToken: "steal-me" },
        },
        fakeDb(),
      ),
    ).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("rejects a malformed profile ref", async () => {
    await expect(
      createVerifiedAccountConnection(
        {
          userId: "user-1",
          backendKind: "CODEX_RUNTIME",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: "C:\\temp\\escape",
          accountIdentity: null,
        },
        fakeDb(),
      ),
    ).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("rejects unsupported backends", async () => {
    await expect(
      createVerifiedAccountConnection(
        {
          userId: "user-1",
          backendKind: "MYSTERY",
          verifiedProvider: "OPENAI",
          runtimeProfileRef: RP,
          accountIdentity: null,
        },
        fakeDb(),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BACKEND" });
  });

  it("reconnect keeps the same row and bumps lastVerifiedAt", async () => {
    const existing = { id: "c1", userId: "user-1", archivedAt: null, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null };
    store.findUnique.mockResolvedValue(existing);
    store.update.mockImplementation(async ({ data }) => ({
      id: "c1",
      ...data,
    }));
    const row = await applyReconnectAuthenticated(
      { userId: "user-1", connectionId: "c1", accountIdentity: "x@y.z" },
      fakeDb(),
    );
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" } }),
    );
    expect(row.status).toBe("CONNECTED");
    expect(row.accountIdentity).toBe("x@y.z");
    expect(row.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("identity conflict moves the connection to ERROR", async () => {
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null });
    store.update.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
    const row = await applyReconnectIdentityConflict(
      { userId: "user-1", connectionId: "c1" },
      fakeDb(),
    );
    expect(row.status).toBe("ERROR");
  });

  it("verify maps auth states onto connection status", async () => {
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null });
    store.update.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));

    for (const [authState, expected] of [
      ["AUTHENTICATED", "CONNECTED"],
      ["NOT_AUTHENTICATED", "REAUTH_REQUIRED"],
      ["REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ["UNKNOWN", "ERROR"],
    ] as const) {
      const row = await applyVerifyResult(
        { userId: "user-1", connectionId: "c1", authState },
        fakeDb(),
      );
      expect(row.status).toBe(expected);
    }
    expect(mapAuthStateToConnectionStatus("GARBAGE")).toBe("ERROR");
  });

  it("disconnect keeps the row and profile ref", async () => {
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null });
    store.update.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
    const row = await applyDisconnect(
      { userId: "user-1", connectionId: "c1" },
      fakeDb(),
    );
    expect(row.status).toBe("DISCONNECTED");
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "DISCONNECTED" },
      }),
    );
  });

  it("refuses operations on another user's connection", async () => {
    store.findUnique.mockResolvedValue({ id: "c1", userId: "someone-else", archivedAt: null });
    await expect(
      getConnectionOperationContext(
        { userId: "user-1", connectionId: "c1" },
        fakeDb(),
      ),
    ).rejects.toBeInstanceOf(ConnectionOpError);
  });

  it("refuses operations on archived connections", async () => {
    store.findUnique.mockResolvedValue({
      id: "c1",
      userId: "user-1",
      archivedAt: new Date(),
    });
    await expect(
      getConnectionOperationContext(
        { userId: "user-1", connectionId: "c1" },
        fakeDb(),
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_ARCHIVED" });
  });

  it("lists only live connections for the user", async () => {
    store.findMany.mockResolvedValue([{ id: "c1" }]);
    await listConnectionsForUser("user-1", fakeDb());
    expect(store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", archivedAt: null },
      }),
    );
  });

  it("the public listing select never carries the owner identity", async () => {
    // Browser-facing connection payloads must not expose userId — the
    // owner identity is reserved for the authenticated internal bridge
    // (e.g. Codex pool scoping). The select itself is the boundary.
    store.findMany.mockResolvedValue([]);
    await listConnectionsForUser("user-1", fakeDb());
    const select = store.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("userId");
  });
});

describe("mintAiConnectionTicket", () => {
  it("fails when unauthenticated", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    const result = await mintAiConnectionTicket({ operation: "login", backendKind: "CODEX_RUNTIME" });
    expect(result).toEqual({ success: false, message: "Not authenticated" });
  });

  it("mints a login ticket for a registered backend", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    const result = await mintAiConnectionTicket({
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    });
    expect(result.success).toBe(true);
    expect(result.data?.ticket).toBeTruthy();
  });

  it("mints an OpenCode Go/Zen login ticket for OpenCode when requested", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    for (const accountProvider of ["OPENCODE_GO", "OPENCODE_ZEN"] as const) {
      const result = await mintAiConnectionTicket({
        operation: "login",
        backendKind: "OPENCODE_RUNTIME",
        accountProvider,
      });
      expect(result.success).toBe(true);
      expect(result.data?.ticket).toBeTruthy();
    }
  });

  it("rejects a ChatGPT login ticket for OpenCode", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    const result = await mintAiConnectionTicket({
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENAI",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
  });

  it("requires an explicit provider on a multi-provider runtime", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    const result = await mintAiConnectionTicket({
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
  });

  it("rejects the runtime vendor as an account provider", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    const result = await mintAiConnectionTicket({
      operation: "login",
      backendKind: "OPENCODE_RUNTIME",
      accountProvider: "OPENCODE",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
  });

  it("rejects provider/runtime pairs outside the matrix", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    for (const [backendKind, accountProvider] of [
      ["CODEX_RUNTIME", "ANTHROPIC"],
      ["OPENCODE_RUNTIME", "ANTHROPIC"],
      ["CLAUDE_RUNTIME", "OPENAI"],
      ["CODEX_RUNTIME", "NOT_A_PROVIDER"],
    ] as const) {
      const result = await mintAiConnectionTicket({
        operation: "login",
        backendKind,
        accountProvider,
      });
      expect(result.success).toBe(false);
      expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    }
  });

  it("rejects a connection op whose provider mismatches the row", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    store.findUnique.mockResolvedValue({
      userId: "user-1",
      backendKind: "OPENCODE_RUNTIME",
      provider: "OPENAI",
      archivedAt: null,
    });
    const result = await mintAiConnectionTicket({
      operation: "verify",
      backendKind: "OPENCODE_RUNTIME",
      connectionId: "c1",
      accountProvider: "GITHUB_COPILOT",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
  });

  it("rejects connection ops for connections the user does not own", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    store.findUnique.mockResolvedValue({ userId: "other", backendKind: "CODEX_RUNTIME", archivedAt: null });
    const result = await mintAiConnectionTicket({
      operation: "disconnect",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c-foreign",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("CONNECTION_NOT_FOUND");
  });

  it("rejects ops on archived connections", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    store.findUnique.mockResolvedValue({
      userId: "user-1",
      backendKind: "CODEX_RUNTIME",
      archivedAt: new Date(),
    });
    const result = await mintAiConnectionTicket({
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("CONNECTION_ARCHIVED");
  });

  it("refuses executeText tickets — business execution is server-side only", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    const result = await mintAiConnectionTicket({
      operation: "executeText",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_OPERATION");
  });

  it("mints a connection ticket when ownership is proven", async () => {
    mockedGetCurrentUser.mockResolvedValue(USER as any);
    store.findUnique.mockResolvedValue({
      userId: "user-1",
      backendKind: "CODEX_RUNTIME",
      archivedAt: null,
    });
    const result = await mintAiConnectionTicket({
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    });
    expect(result.success).toBe(true);
  });
});
