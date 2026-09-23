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

  it("expires tickets after the TTL", () => {
    const now = 1_000_000;
    const record = mintConnectionTicket({
      userId: "user-1",
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
      now,
    });
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
        runtimeProfileRef: RP,
        accountIdentity: "me@example.com",
      },
      fakeDb(),
    );
    expect(row).toMatchObject({
      provider: "OPENAI",
      authType: "ACCOUNT_LOGIN",
      backendKind: "CODEX_RUNTIME",
      displayName: "ChatGPT",
      accountIdentity: "me@example.com",
      status: "CONNECTED",
      credentialRef: null,
      runtimeProfileRef: RP,
    });
    // No model, no token, no absolute profile path is ever persisted.
    expect(JSON.stringify(row)).not.toMatch(/model|token|AppData|CODEX_HOME/i);
  });

  it("numbers additional ChatGPT accounts", async () => {
    store.count.mockResolvedValue(2);
    store.create.mockImplementation(async ({ data }) => data);
    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CODEX_RUNTIME",
        runtimeProfileRef: RP,
        accountIdentity: null,
      },
      fakeDb(),
    );
    expect(row.displayName).toBe("ChatGPT 3");
  });

  it("creates a Claude account-login connection with whitelisted metadata", async () => {
    store.count.mockResolvedValue(0);
    store.create.mockImplementation(async ({ data }) => data);
    const row = await createVerifiedAccountConnection(
      {
        userId: "user-1",
        backendKind: "CLAUDE_RUNTIME",
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
          runtimeProfileRef: RP,
          accountIdentity: null,
        },
        fakeDb(),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BACKEND" });
  });

  it("reconnect keeps the same row and bumps lastVerifiedAt", async () => {
    const existing = { id: "c1", userId: "user-1", archivedAt: null };
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
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null });
    store.update.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
    const row = await applyReconnectIdentityConflict(
      { userId: "user-1", connectionId: "c1" },
      fakeDb(),
    );
    expect(row.status).toBe("ERROR");
  });

  it("verify maps auth states onto connection status", async () => {
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null });
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
    store.findUnique.mockResolvedValue({ id: "c1", userId: "user-1", archivedAt: null });
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
