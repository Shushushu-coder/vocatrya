import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "notion-test-key";

import { hashCanonical } from "@/lib/career/hash";
import { sealApiKeySecret } from "@/lib/ai/credential-store";
import {
  acquireToolExecution,
  AGENT_TOOL_EXECUTION_STATUS,
} from "@/lib/agent/toolExecution";
import { ConversationRequestError } from "@/lib/agent/conversationRequest";
import type { ConversationRequest } from "@/lib/agent/conversationRequest";
import { buildAgentTools } from "@/lib/agent/tools";
import { buildNotionAgentTools } from "@/lib/agent/tools/notion";
import {
  computeNotionAgentTools,
  isNotionToolAllowed,
  notionCapabilityFlags,
} from "@/lib/extensions/notion/capabilities";
import { NOTION_ERROR } from "@/lib/extensions/notion/errors";
import { NOTION_TOOL } from "@/lib/extensions/notion/constants";
import { mapNotionRemoteError, setNotionMcpClientFactory } from "@/lib/extensions/notion/mcpClient";
import { setNotionOAuthFetch } from "@/lib/extensions/notion/oauth";
import {
  disconnectNotion,
  resolveNotionAccessToken,
  resolveNotionAgentToolNames,
} from "@/lib/extensions/notion/service";
import { NOTION_STATUS } from "@/lib/extensions/notion/store";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const USER = "u-notion";
const CONV = "conv-notion";

type Row = Record<string, unknown>;

type FakeState = {
  connection: Row | null;
  executions: Row[];
  conversation: Row | null;
};

// Evaluate the Prisma predicates used by ownership and execution CAS checks.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((clause) => matches(row, clause));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const filter = expected as Row;
      if ("not" in filter) return row[key] !== filter.not;
      if ("in" in filter) return (filter.in as unknown[]).includes(row[key]);
      if ("gt" in filter) return row[key] instanceof Date && (row[key] as Date) > (filter.gt as Date);
    }
    return (row[key] ?? null) === expected;
  });
}

function makeDb(state: FakeState) {
  const notionConnection = {
    findUnique: vi.fn(async ({ where }: { where: { userId?: string } }) =>
      state.connection && matches(state.connection, where) ? structuredClone(state.connection) : null,
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return state.connection && matches(state.connection, where) ? structuredClone(state.connection) : null;
    }),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (state.connection) Object.assign(state.connection, update);
        else state.connection = { id: "nc-1", ...create };
        return structuredClone(state.connection);
      },
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Row; data: Record<string, unknown> }) => {
        if (!state.connection || !matches(state.connection, where)) return { count: 0 };
        Object.assign(state.connection, data);
        return { count: 1 };
      },
    ),
  };

  const matchUnique = (
    row: Row,
    where: { conversationId?: unknown; toolName?: unknown; turnKey?: unknown },
  ) =>
    row.conversationId === where.conversationId &&
    row.toolName === where.toolName &&
    row.turnKey === where.turnKey;

  const agentToolExecution = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (
        state.executions.some(
          (r) =>
            matchUnique(r, {
              conversationId: data.conversationId,
              toolName: data.toolName,
              turnKey: data.turnKey,
            }) || r.operationKey === data.operationKey,
        )
      ) {
        const err = new Error("P2002") as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
      const row = { id: `exec-${state.executions.length}`, failureCode: null, resultJson: null, ...data };
      state.executions.push(row);
      return structuredClone(row);
    }),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const key = where.conversationId_toolName_turnKey as
        | { conversationId: string; toolName: string; turnKey: string }
        | undefined;
      if (key) {
        return structuredClone(state.executions.find((r) => matchUnique(r, key)) ?? null);
      }
      if (where.operationKey) {
        return (
          state.executions.find((r) => r.operationKey === where.operationKey) ??
          null
        );
      }
      return null;
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.executions.find((row) => matches(row, where)) ?? null,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = state.executions.filter((row) => matches(row, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
  };

  const chatConversation = {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.conversation && matches(state.conversation, where) ? { ...state.conversation } : null,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      if (!state.conversation || !matches(state.conversation, where)) return { count: 0 };
      const { revision, ...rest } = data;
      Object.assign(state.conversation, rest);
      if (revision && typeof revision === "object") state.conversation.revision =
        (state.conversation.revision as number) + ((revision as Row).increment as number);
      return { count: 1 };
    }),
  };

  let transactionDepth = 0;
  const db = {
    get inTransaction() { return transactionDepth > 0; },
    notionConnection,
    agentToolExecution,
    chatConversation,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      transactionDepth++;
      try { return await fn({ notionConnection, agentToolExecution, chatConversation }); }
      catch (error) { Object.assign(state, snapshot); throw error; }
      finally { transactionDepth--; }
    }),
  };
  return db;
}

function approvalRequest(
  toolCallId: string,
  lastUserMessageId = "msg-user-1",
): ConversationRequest {
  return {
    operation: "approval",
    approvalToolCallId: toolCallId,
    userId: USER,
    conversationId: CONV,
    requestId: "req-1",
    revision: 0,
    messages: [{ id: lastUserMessageId, role: "user", parts: [] }],
    responseMessageId: "msg-a-1",
    released: false,
    wrote: false,
  };
}

async function sealBundle(bundle: Record<string, unknown>) {
  const sealed = await sealApiKeySecret(JSON.stringify(bundle));
  return { encryptedCredential: sealed.encryptedKey, credentialIv: sealed.iv };
}

const VALID_TOOLS_JSON = JSON.stringify(
  ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"].map(
    (name) => ({ name, inputSchema: undefined }),
  ),
);

function connectedState(overrides: Partial<Row> = {}): FakeState {
  return {
    connection: {
      id: "nc-1",
      userId: USER,
      status: NOTION_STATUS.CONNECTED,
      availableTools: VALID_TOOLS_JSON,
      oauthClientId: "client-1",
      ...overrides,
    },
    executions: [],
    conversation: {
      id: CONV,
      userId: USER,
      revision: 0,
      messages: "[]",
      activeRequestId: "req-1",
      activeRequestExpiresAt: new Date(Date.now() + 300_000),
      archivedAt: null,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("capability intersection", () => {
  it("intersects remote tools with the app allowlist", () => {
    expect([
      ...computeNotionAgentTools(["notion-search", "notion-fetch"]),
    ].sort()).toEqual(["notion_read", "notion_search"]);
    expect(computeNotionAgentTools([]).size).toBe(0);
    expect(
      computeNotionAgentTools(["notion-ai-search"]).has("notion_search"),
    ).toBe(true);
    const flags = notionCapabilityFlags([
      "notion-search",
      "notion-fetch",
      "notion-create-pages",
      "notion-update-page",
    ]);
    expect(flags).toEqual({
      search: true,
      read: true,
      createPage: true,
      appendContent: true,
      updateRecord: true,
    });
  });

  it("gates on live connection state", () => {
    const row = {
      status: NOTION_STATUS.CONNECTED,
      availableTools: VALID_TOOLS_JSON,
    };
    expect(isNotionToolAllowed(row as never, "notion_create_page")).toBe(true);
    expect(
      isNotionToolAllowed(
        { ...row, status: NOTION_STATUS.DISCONNECTED } as never,
        "notion_create_page",
      ),
    ).toBe(false);
    expect(isNotionToolAllowed(null, "notion_search")).toBe(false);
    expect(
      isNotionToolAllowed(
        { status: NOTION_STATUS.CONNECTED, availableTools: "[]" } as never,
        "notion_search",
      ),
    ).toBe(false);
  });

  it("intersects with the agent role allowlist in the registry", () => {
    const allTools = [...computeNotionAgentTools([
      "notion-search",
      "notion-fetch",
      "notion-create-pages",
      "notion-update-page",
    ])];
    const base = {
      userId: USER,
      model: {} as never,
      provider: "test",
      modelName: "m",
      writer: {} as never,
      notionTools: allTools,
    };
    const pilot = buildAgentTools({ ...base, agentRole: "pilot" });
    expect(Object.keys(pilot)).toEqual(
      expect.arrayContaining([
        "notion_search",
        "notion_read",
        "notion_create_page",
        "notion_append_content",
        "notion_update_record",
      ]),
    );
    const insight = buildAgentTools({ ...base, agentRole: "insight" });
    expect(insight.notion_search).toBeTruthy();
    expect(insight.notion_read).toBeTruthy();
    expect(insight.notion_create_page).toBeUndefined();
    expect(insight.notion_append_content).toBeUndefined();
    const general = buildAgentTools({ ...base, agentRole: null });
    expect(general.notion_create_page).toBeTruthy();
    const none = buildAgentTools({ ...base, notionTools: [] });
    expect(none.notion_search).toBeUndefined();
  });
});

describe("oauth lifecycle", () => {
  const tokenResponse = {
    access_token: "at-new",
    refresh_token: "rt-new",
    expires_in: 3600,
    token_type: "bearer",
  };

  function oauthFetch(bodies: Record<string, unknown>[]) {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      calls.push(url);
      const body =
        url.includes("oauth-authorization-server") ||
        url.includes("openid-configuration")
          ? {
              issuer: "https://mcp.notion.com",
              authorization_endpoint: "https://mcp.notion.com/authorize",
              token_endpoint: "https://mcp.notion.com/token",
              revocation_endpoint: "https://mcp.notion.com/revoke",
            }
          : url.includes("oauth-protected-resource")
            ? { authorization_servers: ["https://mcp.notion.com"] }
            : (bodies.shift() ?? {});
      return new Response(JSON.stringify(body), {
        status: url.includes("revoke") ? 200 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { fetchFn, calls };
  }

  it("refreshes an expired bundle and persists the rotated tokens", async () => {
    const { fetchFn } = oauthFetch([tokenResponse]);
    setNotionOAuthFetch(fetchFn);
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: Date.now() - 1000,
      clientId: "client-1",
    });
    const state = connectedState(sealed);
    const db = makeDb(state);

    const token = await resolveNotionAccessToken(USER, {
      db: db as never,
    });
    expect(token).toBe("at-new");
    // The rotated bundle resealed and stays readable.
    const again = await resolveNotionAccessToken(USER, { db: db as never });
    expect(again).toBe("at-new");
    expect(fetchFn).toHaveBeenCalled();
  });

  it("marks REAUTH_REQUIRED and clears the credential on invalid_grant", async () => {
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const body = url.includes("oauth-authorization-server")
        ? {
            issuer: "https://mcp.notion.com",
            authorization_endpoint: "https://mcp.notion.com/authorize",
            token_endpoint: "https://mcp.notion.com/token",
          }
        : url.includes("oauth-protected-resource")
          ? { authorization_servers: ["https://mcp.notion.com"] }
          : { error: "invalid_grant" };
      return new Response(JSON.stringify(body), {
        status: url.includes("token") ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    setNotionOAuthFetch(fetchFn);
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: Date.now() - 1000,
      clientId: "client-1",
    });
    const state = connectedState(sealed);
    const db = makeDb(state);

    await expect(
      resolveNotionAccessToken(USER, { db: db as never }),
    ).rejects.toMatchObject({ code: NOTION_ERROR.REAUTH_REQUIRED });
    expect(state.connection!.status).toBe(NOTION_STATUS.REAUTH_REQUIRED);
    expect(state.connection!.encryptedCredential).toBeNull();
  });

  it("disconnect revokes remotely, wipes locally, and blocks later calls", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL) => {
      calls.push(input.toString());
      const url = input.toString();
      const body = url.includes("oauth-authorization-server")
        ? {
            issuer: "https://mcp.notion.com",
            authorization_endpoint: "https://mcp.notion.com/authorize",
            token_endpoint: "https://mcp.notion.com/token",
            revocation_endpoint: "https://mcp.notion.com/revoke",
          }
        : url.includes("oauth-protected-resource")
          ? { authorization_servers: ["https://mcp.notion.com"] }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    setNotionOAuthFetch(fetchFn);
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at-1",
      refreshToken: "rt-1",
      clientId: "client-1",
    });
    const state = connectedState(sealed);
    const db = makeDb(state);

    const after = await disconnectNotion(USER, { db: db as never });
    expect(after.status).toBe("DISCONNECTED");
    expect(calls.some((url) => url.includes("revoke"))).toBe(true);
    expect(state.connection!.encryptedCredential).toBeNull();
    await expect(
      resolveNotionAccessToken(USER, { db: db as never }),
    ).rejects.toMatchObject({ code: NOTION_ERROR.NOT_CONNECTED });
    expect(await resolveNotionAgentToolNames(USER, { db: db as never })).toEqual(
      [],
    );
  });
});

describe("durable write execution", () => {
  it("replays identical input and conflicts on re-proposed input", async () => {
    const state = connectedState();
    const db = makeDb(state);
    const first = await acquireToolExecution(db as never, {
      userId: USER,
      conversationId: CONV,
      toolName: "notion_create_page",
      turnKey: "msg-1",
      inputHash: "h1",
      operationPrefix: "notion",
    });
    expect(first.state).toBe("fresh");
    await db.agentToolExecution.updateMany({
      where: { operationKey: first.execution.operationKey },
      data: { status: "COMPLETED", resultJson: '{"saved":true}' },
    });
    const replay = await acquireToolExecution(db as never, {
      userId: USER,
      conversationId: CONV,
      toolName: "notion_create_page",
      turnKey: "msg-1",
      inputHash: "h1",
      operationPrefix: "notion",
    });
    expect(replay.state).toBe("replay");
    await expect(
      acquireToolExecution(db as never, {
        userId: USER,
        conversationId: CONV,
        toolName: "notion_create_page",
        turnKey: "msg-1",
        inputHash: "h2",
        operationPrefix: "notion",
      }),
    ).rejects.toBeInstanceOf(ConversationRequestError);
  });
});

describe("write tool approval binding and outcomes", () => {
  function toolset(state: FakeState, request: ConversationRequest) {
    const db = makeDb(state);
    if (state.conversation?.messages === "[]") {
      state.conversation.messages = JSON.stringify([
        ...request.messages,
        { id: "proposal", role: "assistant", parts: [{
          type: "tool-notion_create_page", toolCallId: request.approvalToolCallId,
          state: "approval-responded", approval: { id: "approval", approved: true },
          input: { title: "Test page", content: "Hello Notion" },
        }] },
      ]);
    }
    const tools = buildNotionAgentTools({
      userId: USER,
      request,
      db: db as never,
    });
    return { db, tools };
  }

  const createInput = {
    title: "Test page",
    content: "Hello Notion",
  };

  it("refuses execution outside an admitted approval turn", async () => {
    const state = connectedState();
    const request = approvalRequest("tc-1");
    request.operation = "send";
    const { tools } = toolset(state, request);
    const create = tools[NOTION_TOOL.createPage];
    await expect(
      create.execute!(createInput, { toolCallId: "tc-1" } as never),
    ).rejects.toBeInstanceOf(ConversationRequestError);
    expect(request.failure).toBeInstanceOf(ConversationRequestError);
  });

  it("refuses execution bound to a different approval toolCall", async () => {
    const state = connectedState();
    const request = approvalRequest("tc-approved");
    const { tools } = toolset(state, request);
    const create = tools[NOTION_TOOL.createPage];
    await expect(
      create.execute!(createInput, { toolCallId: "tc-other" } as never),
    ).rejects.toBeInstanceOf(ConversationRequestError);
  });

  it("writes and returns a verifiable receipt", async () => {
    setNotionMcpClientFactory(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pages: [{ id: "12345678-1234-1234-1234-123456789abc", url: "https://notion.so/12345678-1234-1234-1234-123456789abc" }],
            }),
          },
        ],
      }),
      close: async () => undefined,
    }));
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at-1",
      clientId: "client-1",
      expiresAt: Date.now() + 3_600_000,
    });
    const state = connectedState(sealed);
    const request = approvalRequest("tc-1");
    const { tools, db } = toolset(state, request);
    const create = tools[NOTION_TOOL.createPage];
    const out = (await create.execute!(createInput, {
      toolCallId: "tc-1",
    } as never)) as { saved: boolean; pageId?: string; url?: string };
    expect(out.saved).toBe(true);
    expect(out.pageId).toBe("12345678-1234-1234-1234-123456789abc");
    expect(out.url).toBe("https://notion.so/12345678-1234-1234-1234-123456789abc");
    expect(
      state.executions.find((r) => r.toolName === "notion_create_page")!
        .status,
    ).toBe(AGENT_TOOL_EXECUTION_STATUS.COMPLETED);
    // The durable receipt landed in the conversation messages.
    expect(
      (db.chatConversation.findFirst as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeGreaterThan(0);
  });

  it("reports unknown outcome and blocks retry including a model verification flag", async () => {
    let calls = 0;
    setNotionMcpClientFactory(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      close: async () => undefined,
    }));
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at-1",
      clientId: "client-1",
      expiresAt: Date.now() + 3_600_000,
    });
    const state = connectedState(sealed);

    const request1 = approvalRequest("tc-1", "msg-turn-1");
    const { tools: t1 } = toolset(state, request1);
    const first = (await t1[NOTION_TOOL.createPage].execute!(createInput, {
      toolCallId: "tc-1",
    } as never)) as { saved: boolean; status?: string; verify?: { tool: string } };
    expect(first.saved).toBe(false);
    expect(first.status).toBe("unknown");
    expect(first.verify?.tool).toBe("notion_search");
    expect(
      state.executions.find((r) => r.toolName === "notion_create_page")!
        .failureCode,
    ).toBe(NOTION_ERROR.OUTCOME_UNKNOWN);

    // A new turn retrying without verification is blocked.
    const request2 = approvalRequest("tc-2", "msg-turn-2");
    const { tools: t2 } = toolset(state, request2);
    const second = (await t2[NOTION_TOOL.createPage].execute!(createInput, {
      toolCallId: "tc-2",
    } as never)) as { saved: boolean; status?: string };
    expect(second.saved).toBe(false);
    expect(second.status).toBe("verification_required");
    expect(calls).toBe(1);

    // A model flag never authorizes retry, even on a fresh turn.
    const request3 = approvalRequest("tc-3", "msg-turn-3");
    const { tools: t3 } = toolset(state, request3);
    const third = (await t3[NOTION_TOOL.createPage].execute!(
      { ...createInput, verifiedNoDuplicate: true },
      { toolCallId: "tc-3" } as never,
    )) as { saved: boolean; status?: string };
    expect(third.saved).toBe(false);
    expect(third.status).toBe("verification_required");
    expect(calls).toBe(1);
  });

  async function ready() {
    const state = connectedState(await sealBundle({ v: 1, accessToken: "at-1", clientId: "client-1", expiresAt: Date.now() + 3_600_000 }));
    const request = approvalRequest("tc-1");
    const ctx = toolset(state, request);
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: '{"pages":[{"id":"12345678-1234-1234-1234-123456789abc"}]}' }] }));
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const execute = (input = createInput) => ctx.tools[NOTION_TOOL.createPage].execute!(input, { toolCallId: "tc-1" } as never);
    return { state, request, ...ctx, callTool, execute };
  }

  it.each([
    ["cancelled", { activeRequestId: null }],
    ["replaced owner", { activeRequestId: "other" }],
    ["stale revision", { revision: 9 }],
    ["expired lease", { activeRequestExpiresAt: new Date(0) }],
    ["archived", { archivedAt: new Date() }],
    ["wrong user", { userId: "other" }],
  ])("blocks dispatch for %s live ownership", async (_name, patch) => {
    const ctx = await ready();
    Object.assign(ctx.state.conversation!, patch);
    await expect(ctx.execute()).rejects.toBeInstanceOf(ConversationRequestError);
    expect(ctx.callTool).not.toHaveBeenCalled();
    expect(ctx.state.executions[0].failureCode).toBeNull();
  });

  it.each(["denied", "changed input", "wrong tool", "missing proposal", "wrong turn"])("rejects persisted approval: %s", async (kind) => {
    const ctx = await ready();
    const messages = JSON.parse(ctx.state.conversation!.messages as string);
    const part = messages[1].parts[0];
    if (kind === "denied") part.approval.approved = false;
    if (kind === "changed input") part.input.content = "unapproved";
    if (kind === "wrong tool") part.type = "tool-notion_update_record";
    if (kind === "missing proposal") messages.pop();
    if (kind === "wrong turn") messages[0].id = "other-turn";
    ctx.state.conversation!.messages = JSON.stringify(messages);
    await expect(ctx.execute()).rejects.toBeInstanceOf(ConversationRequestError);
    expect(ctx.callTool).not.toHaveBeenCalled();
  });

  it("rechecks cancellation occurring during token resolution", async () => {
    const ctx = await ready();
    ctx.db.notionConnection.findUnique.mockImplementationOnce(async () => {
      ctx.state.conversation!.activeRequestId = null;
      return ctx.state.connection;
    });
    await expect(ctx.execute()).rejects.toBeInstanceOf(ConversationRequestError);
    expect(ctx.callTool).not.toHaveBeenCalled();
  });

  it("does not redispatch a concurrent pending execution", async () => {
    const ctx = await ready();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    ctx.callTool.mockImplementationOnce(async () => { expect(ctx.db.inTransaction).toBe(false); entered(); await blocked; return { content: [{ type: "text", text: '{"pages":[{"id":"12345678-1234-1234-1234-123456789abc"}]}' }] }; });
    const first = ctx.execute();
    await started;
    expect(await ctx.execute()).toMatchObject({ status: "verification_required" });
    expect(ctx.callTool).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ saved: true });
  });

  it.each(["PENDING", "ABORTED"])("blocks %s interruption on a later turn even with a verification flag", async (status) => {
    const ctx = await ready();
    const reservation = await acquireToolExecution(ctx.db as never, {
      userId: USER, conversationId: CONV, toolName: NOTION_TOOL.createPage,
      turnKey: "old-turn", inputHash: hashCanonical(createInput), operationPrefix: "notion",
    });
    ctx.state.executions[0].status = status;
    expect(await ctx.tools[NOTION_TOOL.createPage].execute!({ ...createInput, verifiedNoDuplicate: true }, { toolCallId: "tc-1" } as never)).toMatchObject({ status: "verification_required" });
    expect(ctx.callTool).not.toHaveBeenCalled();
    expect(reservation.execution.operationKey).toBeTruthy();
  });

  it("preserves remote success when the local checkpoint loses ownership", async () => {
    const ctx = await ready();
    ctx.callTool.mockImplementationOnce(async () => {
      ctx.state.conversation!.activeRequestId = null;
      return { content: [{ type: "text", text: '{"pages":[{"id":"12345678-1234-1234-1234-123456789abc"}]}' }] };
    });
    await expect(ctx.execute()).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect(ctx.state.executions[0]).toMatchObject({ status: "COMPLETED", failureCode: null });
    expect(JSON.parse(ctx.state.executions[0].resultJson as string)).toMatchObject({ saved: true, pageId: "12345678-1234-1234-1234-123456789abc" });
    expect(ctx.callTool).toHaveBeenCalledTimes(1);
    expect(await ctx.execute()).toMatchObject({ saved: true });
    expect(ctx.callTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["async task", JSON.stringify({ task_id: "task-1", status: "pending" })],
    ["task UUID", JSON.stringify({ id: "12345678-1234-1234-1234-123456789abc", object: "task" })],
    ["garbage", "request accepted"],
    ["empty response", "{}"],
    ["untrusted URL", JSON.stringify({ url: "https://example.com/page" })],
  ])("keeps %s receipts unknown and blocks later retry", async (_name, text) => {
    const ctx = await ready();
    ctx.callTool.mockResolvedValueOnce({ content: [{ type: "text", text }] });
    expect(await ctx.execute()).toMatchObject({ saved: false, status: "unknown", verify: { tool: "notion_search" } });
    expect(ctx.state.executions[0]).toMatchObject({ status: "FAILED", failureCode: NOTION_ERROR.OUTCOME_UNKNOWN });
    const request = approvalRequest("tc-2", "next-turn");
    const next = toolset(ctx.state, request);
    expect(await next.tools[NOTION_TOOL.createPage].execute!({ ...createInput, verifiedNoDuplicate: true }, { toolCallId: "tc-2" } as never)).toMatchObject({ status: "verification_required" });
    expect(ctx.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not treat the input target as proof of a completed append", async () => {
    const ctx = await ready();
    const input = { target: "12345678-1234-1234-1234-123456789abc", content: "append this" };
    const messages = JSON.parse(ctx.state.conversation!.messages as string);
    Object.assign(messages[1].parts[0], { type: "tool-notion_append_content", input });
    ctx.state.conversation!.messages = JSON.stringify(messages);
    ctx.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: '{"task_id":"async-task"}' }] });
    expect(await ctx.tools[NOTION_TOOL.appendContent].execute!(input, { toolCallId: "tc-1" } as never)).toMatchObject({
      saved: false, status: "unknown", verify: { tool: "notion_read", target: input.target },
    });
    expect(ctx.state.executions[0]).toMatchObject({ status: "FAILED", failureCode: NOTION_ERROR.OUTCOME_UNKNOWN });
  });

  it("accepts a verifiable Notion page URL receipt without an ID field", async () => {
    const ctx = await ready();
    ctx.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ url: "https://www.notion.so/12345678123412341234123456789abc" }) }] });
    expect(await ctx.execute()).toMatchObject({ saved: true, url: "https://www.notion.so/12345678123412341234123456789abc" });
    expect(ctx.state.executions[0].status).toBe("COMPLETED");
  });

  it("leaves a remotely successful write unresolved if ledger persistence fails", async () => {
    const ctx = await ready();
    ctx.callTool.mockImplementationOnce(async () => {
      ctx.db.agentToolExecution.updateMany.mockRejectedValueOnce(new Error("ledger unavailable"));
      return { content: [{ type: "text", text: '{"pages":[{"id":"12345678-1234-1234-1234-123456789abc"}]}' }] };
    });
    await expect(ctx.execute()).rejects.toThrow("ledger unavailable");
    expect(ctx.state.executions[0]).toMatchObject({ status: "PENDING", failureCode: "NOTION_DISPATCHED" });
    expect(await ctx.execute()).toMatchObject({ status: "verification_required" });
    expect(ctx.callTool).toHaveBeenCalledTimes(1);
  });

});

describe("remote error mapping", () => {
  it("maps HTTP statuses to stable codes", () => {
    expect(
      mapNotionRemoteError(new StreamableHTTPError(401, "unauth")).code,
    ).toBe(NOTION_ERROR.REAUTH_REQUIRED);
    expect(
      mapNotionRemoteError(new StreamableHTTPError(403, "forbidden")).code,
    ).toBe(NOTION_ERROR.PERMISSION_DENIED);
    expect(
      mapNotionRemoteError(new StreamableHTTPError(429, "slow down")).code,
    ).toBe(NOTION_ERROR.RATE_LIMITED);
    expect(
      mapNotionRemoteError(new StreamableHTTPError(503, "down")).code,
    ).toBe(NOTION_ERROR.OUTCOME_UNKNOWN);
    expect(mapNotionRemoteError(new TypeError("fetch failed")).code).toBe(
      NOTION_ERROR.NETWORK,
    );
    expect(
      mapNotionRemoteError(new (class extends Error {
        constructor() {
          super("x");
          this.name = "AbortError";
        }
      })()).code,
    ).toBe(NOTION_ERROR.OUTCOME_UNKNOWN);
  });
});

