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
import {
  deletePagesCandidates,
  updateContentCandidates,
} from "@/lib/extensions/notion/remoteArgs";
import {
  AgentNotionDeletePagesSchema,
  AgentNotionUpdateContentSchema,
} from "@/models/agent.schema";
import {
  NOTION_WRITE_SPECS,
  notionWriteInputHash,
} from "@/lib/agent/notionWriteSpec";
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
  proposals?: Row[];
  tasks?: Row[];
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

  const agentOperationProposal = {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      state.proposals?.find(
        (r) =>
          (where.id !== undefined && r.id === where.id) ||
          (where.toolCallId !== undefined && r.toolCallId === where.toolCallId),
      ) ?? null,
    ),
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.proposals?.find((row) => matches(row, where)) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `prop-${(state.proposals?.length ?? 0) + 1}`, ...data };
      (state.proposals ??= []).push(row);
      return structuredClone(row);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = (state.proposals ?? []).filter((row) => matches(row, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
  };

  const harnessTask = {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      state.tasks?.find((r) => r.id === where.id) ?? null,
    ),
  };

  let transactionDepth = 0;
  const db = {
    get inTransaction() { return transactionDepth > 0; },
    notionConnection,
    agentToolExecution,
    agentOperationProposal,
    harnessTask,
    chatConversation,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      transactionDepth++;
      try { return await fn({ notionConnection, agentToolExecution, agentOperationProposal, harnessTask, chatConversation }); }
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
      updateContent: true,
      deletePages: false,
    });
    expect(
      notionCapabilityFlags([
        "notion-search",
        "notion-fetch",
        "notion-create-pages",
        "notion-update-page",
        "notion-delete-pages",
      ]).deletePages,
    ).toBe(true);
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
      "notion-delete-pages",
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
        "notion_update_content",
        "notion_delete_pages",
      ]),
    );
    expect(pilot.notion_update_content?.needsApproval).toBeUndefined();
    expect(pilot.notion_delete_pages?.needsApproval).toBe(true);
    const insight = buildAgentTools({ ...base, agentRole: "insight" });
    expect(insight.notion_search).toBeTruthy();
    expect(insight.notion_read).toBeTruthy();
    expect(insight.notion_create_page).toBeUndefined();
    expect(insight.notion_append_content).toBeUndefined();
    expect(insight.notion_update_content).toBeUndefined();
    expect(insight.notion_delete_pages).toBeUndefined();
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

describe("write tool approval binding and detached queue", () => {
  function toolset(state: FakeState, request: ConversationRequest) {
    const db = makeDb(state);
    const tools = buildNotionAgentTools({
      userId: USER,
      request,
      db: db as never,
    });
    return { db, tools };
  }

  const createInput = { title: "Test page", content: "Hello Notion" };

  function seedProposal(state: FakeState, over: Partial<Row> = {}) {
    const row: Row = {
      id: "prop-1",
      userId: USER,
      conversationId: CONV,
      toolCallId: "tc-1",
      toolName: "notion_create_page",
      status: "APPROVED",
      inputJson: JSON.stringify(createInput),
      inputHash: notionWriteInputHash(createInput),
      harnessTaskId: "task-1",
      outcomeJson: null,
      expiresAt: new Date(Date.now() + 3600_000),
      ...over,
    };
    (state.proposals ??= []).push(row);
    (state.tasks ??= []).push({ id: "task-1", status: "QUEUED" });
    return row;
  }

  it("refuses execution outside an admitted approval turn", async () => {
    const state = connectedState();
    const request = approvalRequest("tc-1");
    request.operation = "send";
    const { tools } = toolset(state, request);
    await expect(
      tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never),
    ).rejects.toBeInstanceOf(ConversationRequestError);
    expect(request.failure).toBeInstanceOf(ConversationRequestError);
  });

  it("refuses execution bound to a different approval toolCall", async () => {
    const state = connectedState();
    const request = approvalRequest("tc-approved");
    const { tools } = toolset(state, request);
    await expect(
      tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-other" } as never),
    ).rejects.toBeInstanceOf(ConversationRequestError);
  });

  it("fails closed when the durable proposal is missing — never a fake queued", async () => {
    const callTool = vi.fn();
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const state = connectedState();
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { saved: boolean; status: string; code?: string };
    expect(out.saved).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("PROPOSAL_MISSING");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns the persisted queued stub — never calls the remote", async () => {
    const callTool = vi.fn();
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const state = connectedState();
    seedProposal(state);
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { saved: boolean; status: string; proposalId?: string; taskId?: string; taskStatus?: string };
    expect(out.saved).toBe(false);
    expect(out.status).toBe("queued");
    expect(out.proposalId).toBe("prop-1");
    expect(out.taskId).toBe("task-1");
    expect(out.taskStatus).toBe("QUEUED");
    expect(out).not.toMatchObject({ saved: true });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reports the real RUNNING task state — still no remote call", async () => {
    const callTool = vi.fn();
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const state = connectedState();
    seedProposal(state);
    state.tasks![0].status = "RUNNING";
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { saved: boolean; status: string; taskStatus?: string };
    expect(out.saved).toBe(false);
    expect(out.status).toBe("queued");
    expect(out.taskStatus).toBe("RUNNING");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("fails closed when the call input no longer matches the approved hash", async () => {
    const callTool = vi.fn();
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const state = connectedState();
    seedProposal(state);
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(
      { ...createInput, title: "Tampered title" },
      { toolCallId: "tc-1" } as never,
    )) as { saved: boolean; status: string; code?: string };
    expect(out.saved).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.code).toBe("PROPOSAL_INPUT_CONFLICT");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("approved without a task reports unknown, not queued", async () => {
    const state = connectedState();
    seedProposal(state, { harnessTaskId: null });
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { status: string; code?: string };
    expect(out.status).toBe("unknown");
    expect(out.code).toBe("TASK_MISSING");
  });

  it("replays the stored outcome receipt — saved:true only from persistence", async () => {
    const state = connectedState();
    seedProposal(state, {
      outcomeJson: JSON.stringify({ saved: true, tool: "notion_create_page", pageId: "12345678-1234-1234-1234-123456789abc" }),
    });
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { saved: boolean; pageId?: string };
    expect(out.saved).toBe(true);
    expect(out.pageId).toBe("12345678-1234-1234-1234-123456789abc");
  });

  it.each(["REJECTED", "WITHDRAWN", "EXPIRED", "SUPERSEDED"])("a %s proposal reports denied — the stored decision rules", async (status) => {
    const callTool = vi.fn();
    setNotionMcpClientFactory(async () => ({ listTools: async () => ({ tools: [] }), callTool, close: async () => undefined }));
    const state = connectedState();
    seedProposal(state, { status, harnessTaskId: null });
    const request = approvalRequest("tc-1");
    const { tools } = toolset(state, request);
    const out = (await tools[NOTION_TOOL.createPage].execute!(createInput, { toolCallId: "tc-1" } as never)) as { saved: boolean; status: string; code?: string };
    expect(out.saved).toBe(false);
    expect(out.status).toBe("denied");
    expect(out.code).toBe("PROPOSAL_" + status);
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["async task", JSON.stringify({ task_id: "task-1", status: "pending" })],
    ["task UUID", JSON.stringify({ id: "12345678-1234-1234-1234-123456789abc", object: "task" })],
    ["garbage", "request accepted"],
    ["empty response", "{}"],
    ["untrusted URL", JSON.stringify({ url: "https://example.com/page" })],
  ])("keeps %s receipts unknown at settle — never a saved receipt", (_name, text) => {
    const receipt = NOTION_WRITE_SPECS[NOTION_TOOL.createPage].receipt(text, createInput);
    expect(receipt.saved).toBe(false);
    expect((receipt as { status?: string }).status).toBe("unknown");
  });

  it("accepts a verifiable Notion page URL receipt without an ID field", () => {
    const receipt = NOTION_WRITE_SPECS[NOTION_TOOL.createPage].receipt(
      JSON.stringify({ url: "https://www.notion.so/12345678123412341234123456789abc" }),
      createInput,
    );
    expect(receipt.saved).toBe(true);
    expect((receipt as { url?: string }).url).toBe("https://www.notion.so/12345678123412341234123456789abc");
  });

  it("writes a body edit in the turn without an approval", async () => {
    const sealed = await sealBundle({
      v: 1,
      accessToken: "at",
      clientId: "client-1",
      expiresAt: Date.now() + 3_600_000,
    });
    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ id: "12345678-1234-1234-1234-123456789abc" }) }],
    }));
    setNotionMcpClientFactory(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool,
      close: async () => undefined,
    }));
    const state = connectedState(sealed);
    const { tools } = toolset(state, approvalRequest("other-call"));
    const out = await tools[NOTION_TOOL.updateContent].execute!(
      {
        target: "12345678-1234-1234-1234-123456789abc",
        edits: [{ oldText: "验证码：12345", newText: "验证码：123" }],
      },
      { toolCallId: "tc-edit" } as never,
    );
    expect(out).toMatchObject({ saved: true, tool: NOTION_TOOL.updateContent });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(
      (callTool.mock.calls as any[])[0][0].arguments.command,
    ).toBe("update_content");
    expect(tools[NOTION_TOOL.deletePages].needsApproval).toBe(true);
    await expect(
      tools[NOTION_TOOL.deletePages].execute!(
        { targets: ["page-a", "page-b"] },
        { toolCallId: "tc-delete" } as never,
      ),
    ).rejects.toBeInstanceOf(ConversationRequestError);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("edits page text in place and deletes a batch in one confirmed call", () => {
    const edits = updateContentCandidates({
      pageId: "page-1",
      edits: [{ oldText: "验证码：12345", newText: "验证码：123" }, { oldText: "旧段落", newText: "", replaceAll: true }],
    });
    expect(edits[0]).toMatchObject({
      command: "update_content",
      allow_async: false,
      update_content: {
        content_updates: [
          { old_str: "验证码：12345", new_str: "验证码：123" },
          { old_str: "旧段落", new_str: "", replace_all_matches: true },
        ],
      },
    });
    expect(JSON.stringify(edits)).not.toContain("allow_deleting_content");
    const batch = deletePagesCandidates([
      "https://www.notion.so/page-11111111111111111111111111111111",
      "22222222222222222222222222222222",
      "22222222222222222222222222222222",
    ]);
    expect(batch[0]).toEqual({
      page_ids: [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
      ],
      user_confirmed: true,
    });
    expect(batch.every((args) => args.user_confirmed === true)).toBe(true);
    expect(AgentNotionUpdateContentSchema.safeParse({
      target: "page-1",
      edits: [{ oldText: "验证码：12345", newText: "" }],
    }).success).toBe(true);
    expect(AgentNotionUpdateContentSchema.safeParse({
      target: "page-1",
      edits: [{ oldText: "", newText: "x" }],
    }).success).toBe(false);
    expect(AgentNotionDeletePagesSchema.safeParse({
      targets: Array.from({ length: 21 }, (_, i) => `page-${i}`),
    }).success).toBe(false);
    const receipt = NOTION_WRITE_SPECS[NOTION_TOOL.deletePages].receipt(
      JSON.stringify({ ok: true }),
      { targets: ["page-a", "page-b"] },
    );
    expect(receipt.saved).toBe(true);
    expect(receipt.saved && receipt.pageIds).toEqual(["page-a", "page-b"]);
    const pending = NOTION_WRITE_SPECS[NOTION_TOOL.deletePages].receipt(
      JSON.stringify({ task_id: "task-1", status: "pending" }),
      { targets: ["page-a"] },
    );
    expect(pending.saved).toBe(false);
  });

  it("verifyOf names a read-path check per tool, never the write tool", () => {
    expect(NOTION_WRITE_SPECS[NOTION_TOOL.createPage].verifyOf({ title: "x" }).tool).toBe("notion_search");
    expect(NOTION_WRITE_SPECS[NOTION_TOOL.appendContent].verifyOf({ target: "p" }).tool).toBe("notion_read");
    expect(NOTION_WRITE_SPECS[NOTION_TOOL.updateRecord].verifyOf({ target: "p" }).tool).toBe("notion_read");
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

