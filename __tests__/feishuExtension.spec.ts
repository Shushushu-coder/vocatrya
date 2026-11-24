import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "feishu-test-key";

import { sealApiKeySecret } from "@/lib/ai/credential-store";
import { ConversationRequestError } from "@/lib/agent/conversationRequest";
import type { ConversationRequest } from "@/lib/agent/conversationRequest";
import { buildAgentTools } from "@/lib/agent/tools";
import { buildFeishuAgentTools } from "@/lib/agent/tools/feishu";
import {
  agentToolApproval,
  effectiveAgentToolNames,
} from "@/lib/agent/toolPermissions";
import {
  computeFeishuAgentTools,
  feishuCapabilityFlags,
  isFeishuToolAllowed,
} from "@/lib/extensions/feishu/capabilities";
import {
  FEISHU_CAPABILITY,
  FEISHU_TOOL,
} from "@/lib/extensions/feishu/constants";
import { FEISHU_ERROR } from "@/lib/extensions/feishu/errors";
import {
  feishuApiError,
  feishuRequest,
  setFeishuApiFetch,
  type FeishuResponse,
} from "@/lib/extensions/feishu/api";
import {
  markdownToFeishuBlocks,
  fetchTenantAccessToken,
  probeFeishuCapabilities,
  appendDocxChildren,
  batchUpdateDocxBlocks,
  normalizeFeishuTarget,
  type FeishuCall,
} from "@/lib/extensions/feishu/apiMap";
import {
  DETACHED_WRITE_SPECS,
  detachedProviderOf,
  isDetachedToolAllowed,
  isDetachedWriteTool,
} from "@/lib/agent/detachedWrite";
import { FEISHU_STATUS } from "@/lib/extensions/feishu/store";
import {
  connectFeishu,
  disconnectFeishu,
  getFeishuExtensionState,
  invalidateTenantToken,
  resolveFeishuAccessToken,
  resolveFeishuAgentToolNames,
  verifyFeishuConnection,
} from "@/lib/extensions/feishu/service";
import { executeFeishuWrite } from "@/lib/extensions/feishu/writeRemote";

const USER = "u-feishu";
const CONV = "conv-feishu";
const APP_ID = "cli_testapp0001";
const APP_SECRET = "secret-test-0001";

type Row = Record<string, unknown>;

type FakeState = {
  connection: Row | null;
  proposals?: Row[];
  tasks?: Row[];
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR")
      return (expected as Row[]).some((clause) => matches(row, clause));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const filter = expected as Row;
      if ("not" in filter) return row[key] !== filter.not;
      if ("in" in filter) return (filter.in as unknown[]).includes(row[key]);
      if ("gt" in filter)
        return row[key] instanceof Date && (row[key] as Date) > (filter.gt as Date);
    }
    return (row[key] ?? null) === expected;
  });
}

function applyData(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? Number(row[key] ?? 0) + Number(value.increment) : value;
  }
}

function makeDb(state: FakeState) {
  const feishuConnection = {
    findUnique: vi.fn(async ({ where }: { where: { userId?: string } }) =>
      state.connection && matches(state.connection, where)
        ? structuredClone(state.connection)
        : null,
    ),
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.connection && matches(state.connection, where)
        ? structuredClone(state.connection)
        : null,
    ),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (state.connection) applyData(state.connection, update);
        else state.connection = { id: "fc-1", revision: 0, status: "DISCONNECTED", appId: null, availableCapabilities: null, connectedAt: null, lastVerifiedAt: null, lastError: null, ...create };
        return structuredClone(state.connection);
      },
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Row; data: Record<string, unknown> }) => {
        if (!state.connection || !matches(state.connection, where))
          return { count: 0 };
        applyData(state.connection, data);
        return { count: 1 };
      },
    ),
  };
  const agentOperationProposal = {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      state.proposals?.find(
        (r) =>
          (where.id !== undefined && r.id === where.id) ||
          (where.toolCallId !== undefined && r.toolCallId === where.toolCallId),
      ) ?? null,
    ),
  };
  const harnessTask = {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      state.tasks?.find((r) => r.id === where.id) ?? null,
    ),
  };
  const agentToolExecution = {
    findFirst: vi.fn(async () => null),
  };
  const chatConversation = {
    findFirst: vi.fn(async () => null),
  };
  return {
    feishuConnection,
    agentOperationProposal,
    harnessTask,
    agentToolExecution,
    chatConversation,
  };
}

type CallInput = Parameters<FeishuCall>[0];
type CallFn = FeishuCall;

function ok(data: unknown): FeishuResponse {
  return { status: 200, code: 0, data };
}

/** A `call` seam answering the token endpoint + every capability probe. */
function makeRemote(overrides: Partial<Record<string, CallFn>> = {}) {
  const calls: CallInput[] = [];
  const call: CallFn = async (input) => {
    calls.push(input);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (input.path.includes(fragment) && handler) return handler(input);
    }
    if (input.path.includes("tenant_access_token")) {
      return ok({ tenant_access_token: "t-tenant-1", expire: 3600 });
    }
    if (input.path.includes("/drive/v1/files")) {
      return ok({ files: [], has_more: false });
    }
    if (input.path.includes("/wiki/v2/spaces")) {
      return ok({ items: [] });
    }
    if (input.path.includes("raw_content") || input.path.includes("batch_update")) {
      // Probe endpoints: a 4xx business failure = scope granted, doc absent.
      return { status: 404, code: 1770002, msg: "not found" };
    }
    return { status: 404, code: null, msg: "unmatched" };
  };
  return { call, calls };
}

function approvalRequest(toolCallId: string): ConversationRequest {
  return {
    operation: "approval",
    approvalToolCallId: toolCallId,
    userId: USER,
    conversationId: CONV,
    requestId: "req-1",
    revision: 0,
    messages: [{ id: "msg-u-1", role: "user", parts: [] }],
    responseMessageId: "msg-a-1",
    released: false,
    wrote: false,
  };
}

async function sealedBundle() {
  const sealed = await sealApiKeySecret(
    JSON.stringify({ v: 1, appId: APP_ID, appSecret: APP_SECRET }),
  );
  return {
    encryptedCredential: sealed.encryptedKey,
    credentialIv: sealed.iv,
  };
}

function connectedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "fc-1",
    userId: USER,
    revision: 0,
    status: FEISHU_STATUS.CONNECTED,
    appId: APP_ID,
    availableCapabilities: JSON.stringify([
      FEISHU_CAPABILITY.driveList,
      FEISHU_CAPABILITY.wikiRead,
      FEISHU_CAPABILITY.docxRead,
      FEISHU_CAPABILITY.docxWrite,
    ]),
    connectedAt: new Date(),
    lastVerifiedAt: new Date(),
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The tenant-token cache is process-local — clear it so a token minted by
  // an earlier test cannot shadow this test's injected call seam.
  invalidateTenantToken(USER);
  setFeishuApiFetch(null);
});

// ─── Capability intersection ────────────────────────────────────────────────

describe("capability intersection", () => {
  it("intersects probed scopes with the app allowlist", () => {
    expect(
      [
        ...computeFeishuAgentTools([
          FEISHU_CAPABILITY.driveList,
          FEISHU_CAPABILITY.docxRead,
          FEISHU_CAPABILITY.docxWrite,
        ]),
      ].sort(),
    ).toEqual([
      FEISHU_TOOL.appendContent,
      FEISHU_TOOL.createDoc,
      FEISHU_TOOL.readDoc,
      FEISHU_TOOL.searchDocs,
      FEISHU_TOOL.updateContent,
    ]);
    expect(computeFeishuAgentTools([]).size).toBe(0);
    expect(computeFeishuAgentTools(null).size).toBe(0);
    // Search needs EITHER drive.list or wiki.read — either one alone opens it.
    expect(
      computeFeishuAgentTools([FEISHU_CAPABILITY.wikiRead]).has(
        FEISHU_TOOL.searchDocs,
      ),
    ).toBe(true);
    // Read requires docx.read specifically; wiki.read alone is not enough.
    expect(
      computeFeishuAgentTools([FEISHU_CAPABILITY.wikiRead]).has(
        FEISHU_TOOL.readDoc,
      ),
    ).toBe(false);
    expect(
      feishuCapabilityFlags([FEISHU_CAPABILITY.driveList]),
    ).toEqual({
      searchDocs: true,
      readDoc: false,
      createDoc: false,
      appendContent: false,
      updateContent: false,
    });
  });

  it("gates on live connection state", () => {
    const row = connectedRow();
    expect(isFeishuToolAllowed(row as never, FEISHU_TOOL.createDoc)).toBe(true);
    expect(
      isFeishuToolAllowed(
        { ...row, status: FEISHU_STATUS.DISCONNECTED } as never,
        FEISHU_TOOL.createDoc,
      ),
    ).toBe(false);
    expect(
      isFeishuToolAllowed(
        { ...row, status: FEISHU_STATUS.REAUTH_REQUIRED } as never,
        FEISHU_TOOL.readDoc,
      ),
    ).toBe(false);
    expect(isFeishuToolAllowed(null, FEISHU_TOOL.searchDocs)).toBe(false);
    expect(
      isFeishuToolAllowed(
        { ...row, availableCapabilities: "[]" } as never,
        FEISHU_TOOL.searchDocs,
      ),
    ).toBe(false);
  });

  it("intersects with the agent role allowlist in the registry", () => {
    const allTools = [
      ...computeFeishuAgentTools([
        FEISHU_CAPABILITY.driveList,
        FEISHU_CAPABILITY.wikiRead,
        FEISHU_CAPABILITY.docxRead,
        FEISHU_CAPABILITY.docxWrite,
      ]),
    ];
    const base = {
      userId: USER,
      model: {} as never,
      provider: "test",
      modelName: "m",
      writer: {} as never,
      feishuTools: allTools,
    };
    const pilot = buildAgentTools({ ...base, agentRole: "pilot" });
    expect(Object.keys(pilot)).toEqual(
      expect.arrayContaining([
        "feishu_search_docs",
        "feishu_read_doc",
        "feishu_create_doc",
        "feishu_append_content",
        "feishu_update_content",
      ]),
    );
    expect(pilot.feishu_create_doc?.needsApproval).toBe(true);
    const insight = buildAgentTools({ ...base, agentRole: "insight" });
    expect(insight.feishu_search_docs).toBeTruthy();
    expect(insight.feishu_read_doc).toBeTruthy();
    expect(insight.feishu_create_doc).toBeUndefined();
    expect(insight.feishu_append_content).toBeUndefined();
    const reflect = buildAgentTools({ ...base, agentRole: "reflect" });
    expect(reflect.feishu_search_docs).toBeTruthy();
    expect(reflect.feishu_create_doc).toBeUndefined();
    const none = buildAgentTools({ ...base, feishuTools: [] });
    expect(none.feishu_search_docs).toBeUndefined();
    // A name outside the app allowlist can never leak through — the returned
    // set is the full effective surface, so the assertion is on Feishu names.
    const injected = effectiveAgentToolNames({
      agentRole: "pilot",
      feishuTools: ["feishu_delete_doc", "feishu_send_message"],
    });
    expect(injected.some((n) => n.startsWith("feishu_"))).toBe(false);
  });

  it("keeps every Feishu write approval-gated in every mode", () => {
    for (const mode of ["ask", "rules", "full"] as const) {
      for (const name of [
        "feishu_create_doc",
        "feishu_append_content",
        "feishu_update_content",
      ]) {
        expect(agentToolApproval(name, false, mode)).toBe("always");
      }
    }
  });
});

// ─── Credential lifecycle ───────────────────────────────────────────────────

describe("connect / verify / disconnect", () => {
  it("connects: validates the pair remotely, seals the bundle, stores only safe fields", async () => {
    const state: FakeState = { connection: null };
    const { call } = makeRemote();
    const result = await connectFeishu(
      USER,
      { appId: APP_ID, appSecret: APP_SECRET },
      { db: makeDb(state) as never, call: call as never },
    );
    expect(result.status).toBe("CONNECTED");
    expect(result.appId).toBe(APP_ID);
    expect(result.capabilities.searchDocs).toBe(true);
    expect(result.capabilities.readDoc).toBe(true);
    expect(result.capabilities.createDoc).toBe(true);
    // The secret only ever lives inside the sealed envelope — every other
    // stored field is inspectable and none may carry it.
    const row = state.connection!;
    expect(row.encryptedCredential).toBeTruthy();
    expect(row.credentialIv).toBeTruthy();
    const inspectable = JSON.stringify({ ...row, encryptedCredential: "", credentialIv: "" });
    expect(inspectable).not.toContain(APP_SECRET);
  });

  it("rejects malformed input without a remote call", async () => {
    const state: FakeState = { connection: null };
    const { call, calls } = makeRemote();
    await expect(
      connectFeishu(
        USER,
        { appId: "x", appSecret: APP_SECRET },
        { db: makeDb(state) as never, call: call as never },
      ),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.VALIDATION_FAILED });
    expect(calls).toHaveLength(0);
  });

  it("maps a rejected pair to INVALID_CREDENTIALS and stores nothing", async () => {
    const state: FakeState = { connection: null };
    const { call } = makeRemote({
      tenant_access_token: async () => ({
        status: 200,
        code: 10003,
        msg: "invalid app_secret",
      }),
    });
    await expect(
      connectFeishu(
        USER,
        { appId: APP_ID, appSecret: APP_SECRET },
        { db: makeDb(state) as never, call: call as never },
      ),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.INVALID_CREDENTIALS });
    expect(state.connection?.status).toBe("DISCONNECTED");
  });

  it("reconnect with a blank secret reuses the stored bundle", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const { call } = makeRemote();
    const result = await connectFeishu(
      USER,
      { appId: APP_ID, appSecret: "" },
      { db: makeDb(state) as never, call: call as never },
    );
    expect(result.status).toBe("CONNECTED");
    // But never for a different app id — that would mint a credential-free
    // row for an app we cannot authenticate as.
    await expect(
      connectFeishu(
        USER,
        { appId: "cli_other0001", appSecret: "" },
        { db: makeDb(state) as never, call: call as never },
      ),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.VALIDATION_FAILED });
  });

  it("disconnect clears credential + capability state and stops new calls", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const db = makeDb(state);
    const { call } = makeRemote();
    const result = await disconnectFeishu(USER, { db: db as never });
    expect(result.status).toBe("DISCONNECTED");
    const row = state.connection!;
    expect(row.encryptedCredential).toBeNull();
    expect(row.credentialIv).toBeNull();
    expect(row.appId).toBeNull();
    expect(row.availableCapabilities).toBeNull();
    await expect(
      resolveFeishuAccessToken(USER, {
        db: db as never,
        call: call as never,
      }),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.NOT_CONNECTED });
    expect(await resolveFeishuAgentToolNames(USER, { db: db as never })).toEqual(
      [],
    );
  });

  it("verify writes capability refresh only while still CONNECTED — a mid-probe disconnect wins", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const db = makeDb(state);
    const { call } = makeRemote({
      "tenant_access_token": async () => {
        // The user disconnected while the probe was in flight — exercise the
        // real disconnect path so the row mutates exactly like production.
        await disconnectFeishu(USER, { db: db as never });
        return ok({ tenant_access_token: "t-tenant-2", expire: 3600 });
      },
    });
    const result = await verifyFeishuConnection(USER, {
      db: db as never,
      call: call as never,
    });
    expect(result.status).toBe("DISCONNECTED");
    // The conditional write did not resurrect capability state.
    expect(state.connection!.availableCapabilities).toBeNull();
  });

  it("verify flips invalid credentials to REAUTH_REQUIRED and clears the bundle", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const db = makeDb(state);
    const { call } = makeRemote({
      tenant_access_token: async () => ({
        status: 200,
        code: 99991661,
        msg: "invalid tenant access token",
      }),
    });
    const result = await verifyFeishuConnection(USER, {
      db: db as never,
      call: call as never,
    });
    expect(result.status).toBe("REAUTH_REQUIRED");
    const row = state.connection!;
    expect(row.encryptedCredential).toBeNull();
    expect(row.availableCapabilities).toBeNull();
    await expect(
      resolveFeishuAccessToken(USER, {
        db: db as never,
        call: call as never,
      }),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.REAUTH_REQUIRED });
  });

  it("extension state never exposes the secret or token", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const result = await getFeishuExtensionState(USER, {
      db: makeDb(state) as never,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain("tenant_access_token");
    expect(result.status).toBe("CONNECTED");
  });
});

// ─── Read tools ─────────────────────────────────────────────────────────────

describe("read tools", () => {
  it("search lists app-space files filtered by query — scoped listing, not tenant search", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const { call, calls } = makeRemote({
      "/drive/v1/files": async () =>
        ok({
          files: [
            {
              token: "doxcnAAAA",
              name: "Resume notes",
              type: "docx",
              url: "https://feishu.cn/docx/doxcnAAAA",
            },
            { token: "shtcnBBBB", name: "Tracker", type: "sheet" },
          ],
          has_more: false,
        }),
    });
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb(state) as never,
      call: call as never,
    });
    const output = (await tools.feishu_search_docs.execute!(
      { query: "resume" },
      { toolCallId: "tc-1", messages: [] },
    )) as { found: boolean; results: { id: string; title: string }[] };
    expect(output.found).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].title).toBe("Resume notes");
    // The token exchange happened — the App Secret itself is never in the
    // request bodies (it goes only to the token endpoint).
    const tokenCall = calls.find((c) =>
      c.path.includes("tenant_access_token"),
    )!;
    expect(JSON.stringify(tokenCall.body)).toContain(APP_SECRET);
    for (const c of calls.filter(
      (c) => !c.path.includes("tenant_access_token"),
    )) {
      expect(JSON.stringify(c)).not.toContain(APP_SECRET);
    }
  });

  it("read resolves a wiki node to its docx object and reports non-docx honestly", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const { call } = makeRemote({
      "wiki/v2/spaces/get_node": async () =>
        ok({
          node: {
            node_token: "wikcnNODE",
            obj_token: "doxcnDOC",
            obj_type: "docx",
            title: "Offer log",
            space_id: "sp-1",
          },
        }),
      // "raw_content" must precede the document path — the raw_content URL
      // contains the document path fragment too.
      raw_content: async () => ok({ content: "line one\nline two" }),
      "/docx/v1/documents/doxcnDOC": async () =>
        ok({ document: { document_id: "doxcnDOC", title: "Offer log", revision_id: 7 } }),
    });
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb(state) as never,
      call: call as never,
    });
    const output = (await tools.feishu_read_doc.execute!(
      { target: "https://feishu.cn/wiki/wikcnNODE" },
      { toolCallId: "tc-2", messages: [] },
    )) as { found: boolean; documentId?: string; content?: string; url?: string };
    expect(output.found).toBe(true);
    expect(output.documentId).toBe("doxcnDOC");
    expect(output.content).toContain("line two");

    const sheetRemote = makeRemote({
      "wiki/v2/spaces/get_node": async () =>
        ok({
          node: {
            node_token: "wikcnNODE2",
            obj_token: "shtcnX",
            obj_type: "sheet",
            title: "Sheet",
            space_id: "sp-1",
          },
        }),
    });
    const tools2 = buildFeishuAgentTools({
      userId: USER,
      db: makeDb(state) as never,
      call: sheetRemote.call as never,
    });
    const unsupported = (await tools2.feishu_read_doc.execute!(
      { target: "https://feishu.cn/wiki/wikcnNODE2" },
      { toolCallId: "tc-3", messages: [] },
    )) as { found: boolean; code?: string };
    expect(unsupported).toEqual({
      found: false,
      code: FEISHU_ERROR.UNSUPPORTED_TARGET,
    });
  });

  it("read fails closed after disconnect — no remote call runs", async () => {
    const state: FakeState = { connection: null };
    const { call, calls } = makeRemote();
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb(state) as never,
      call: call as never,
    });
    const output = (await tools.feishu_read_doc.execute!(
      { target: "doxcnAAAA" },
      { toolCallId: "tc-4", messages: [] },
    )) as { found: boolean; code?: string };
    expect(output).toEqual({
      found: false,
      code: FEISHU_ERROR.NOT_CONNECTED,
    });
    expect(calls).toHaveLength(0);
  });
});

// ─── Detached write tools ───────────────────────────────────────────────────

describe("detached write stubs", () => {
  const proposalRow = (overrides: Partial<Row> = {}): Row => ({
    id: "prop-1",
    userId: USER,
    conversationId: CONV,
    toolCallId: "tc-w1",
    status: "APPROVED",
    inputHash: "hash-1",
    outcomeJson: null,
    harnessTaskId: "task-1",
    ...overrides,
  });

  it("rejects execution outside the admitted approval turn", async () => {
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb({ connection: null }) as never,
      request: { operation: "send" } as ConversationRequest,
    });
    await expect(
      tools.feishu_create_doc.execute!(
        { title: "x" },
        { toolCallId: "tc-w0", messages: [] },
      ),
    ).rejects.toBeInstanceOf(ConversationRequestError);
  });

  it("returns PROPOSAL_MISSING when no durable proposal exists", async () => {
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb({ connection: null, proposals: [] }) as never,
      request: approvalRequest("tc-w1"),
    });
    const output = (await tools.feishu_create_doc.execute!(
      { title: "Offer notes" },
      { toolCallId: "tc-w1", messages: [] },
    )) as { saved: boolean; code: string };
    expect(output.saved).toBe(false);
    expect(output.code).toBe("PROPOSAL_MISSING");
  });

  it("fails closed on an input-hash mismatch", async () => {
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb({
        connection: null,
        proposals: [proposalRow()],
      }) as never,
      request: approvalRequest("tc-w1"),
    });
    const output = (await tools.feishu_create_doc.execute!(
      { title: "changed input" },
      { toolCallId: "tc-w1", messages: [] },
    )) as { saved: boolean; code: string };
    expect(output.saved).toBe(false);
    expect(output.code).toBe("PROPOSAL_INPUT_CONFLICT");
  });

  it("returns a queued stub for an approved proposal with a live task — never saved:true", async () => {
    const { detachedWriteInputHash } = await import(
      "@/lib/agent/detachedWrite"
    );
    const input = { title: "Offer notes" };
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb({
        connection: null,
        proposals: [
          proposalRow({ inputHash: detachedWriteInputHash(input) }),
        ],
        tasks: [{ id: "task-1", status: "RUNNING" }],
      }) as never,
      request: approvalRequest("tc-w1"),
    });
    const output = (await tools.feishu_create_doc.execute!(
      input,
      { toolCallId: "tc-w1", messages: [] },
    )) as { saved: boolean; status: string; code: string };
    expect(output).toMatchObject({
      saved: false,
      status: "queued",
      code: "QUEUED",
      taskId: "task-1",
    });
  });

  it("replays a persisted receipt — only the stored outcome may claim saved", async () => {
    const { detachedWriteInputHash } = await import(
      "@/lib/agent/detachedWrite"
    );
    const input = { title: "Offer notes" };
    const receipt = {
      saved: true,
      tool: "feishu_create_doc",
      documentId: "doxcnREAL",
      url: "https://feishu.cn/docx/doxcnREAL",
      title: "Offer notes",
    };
    const tools = buildFeishuAgentTools({
      userId: USER,
      db: makeDb({
        connection: null,
        proposals: [
          proposalRow({
            inputHash: detachedWriteInputHash(input),
            outcomeJson: JSON.stringify(receipt),
          }),
        ],
      }) as never,
      request: approvalRequest("tc-w1"),
    });
    const output = (await tools.feishu_create_doc.execute!(
      input,
      { toolCallId: "tc-w1", messages: [] },
    )) as { saved: boolean; documentId?: string };
    expect(output).toMatchObject({ saved: true, documentId: "doxcnREAL" });
  });
});

// ─── Detached registry ──────────────────────────────────────────────────────

describe("detached write registry", () => {
  it("merges notion + feishu specs under one contract", () => {
    expect(isDetachedWriteTool("feishu_create_doc")).toBe(true);
    expect(isDetachedWriteTool("notion_create_page")).toBe(true);
    expect(isDetachedWriteTool("feishu_search_docs")).toBe(false);
    expect(detachedProviderOf("feishu_update_content")).toBe("feishu");
    expect(detachedProviderOf("notion_delete_pages")).toBe("notion");
    expect(detachedProviderOf("add_job")).toBeNull();
    expect(DETACHED_WRITE_SPECS.feishu_create_doc.provider).toBe("feishu");
    expect(DETACHED_WRITE_SPECS.notion_create_page.provider).toBe("notion");
  });

  it("isDetachedToolAllowed reads the provider's live connection row", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const db = makeDb(state);
    await expect(
      isDetachedToolAllowed(USER, "feishu_append_content", db as never),
    ).resolves.toBe(true);
    state.connection!.status = FEISHU_STATUS.DISCONNECTED;
    await expect(
      isDetachedToolAllowed(USER, "feishu_append_content", db as never),
    ).resolves.toBe(false);
    await expect(
      isDetachedToolAllowed(USER, "not_a_tool", db as never),
    ).resolves.toBe(false);
  });
});

// ─── Remote write execution ─────────────────────────────────────────────────

describe("executeFeishuWrite", () => {
  it("create_doc returns a verifiable receipt with id + url", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const custom: CallFn = async (input) => {
      if (input.path.includes("tenant_access_token")) {
        return ok({ tenant_access_token: "t-1", expire: 3600 });
      }
      if (input.method === "POST" && input.path.endsWith("/docx/v1/documents")) {
        return ok({
          document: { document_id: "doxcnNEW", title: "Notes", revision_id: 3 },
        });
      }
      if (input.path.includes("metas/batch_query")) {
        return ok({ metas: [{ url: "https://feishu.cn/docx/doxcnNEW" }] });
      }
      if (input.path.includes("/children")) {
        const body = input.body as { children: unknown[] };
        return ok({ children: body.children.map(() => ({})) });
      }
      return { status: 404, code: null };
    };
    const result = await executeFeishuWrite(
      USER,
      FEISHU_TOOL.createDoc,
      { title: "Notes", content: "hello **world**" },
      { db: makeDb(state) as never, call: custom as never },
    );
    const text = result.content[0]?.text ?? "";
    const receipt = JSON.parse(text) as Record<string, unknown>;
    expect(receipt.document_id).toBe("doxcnNEW");
    expect(receipt.url).toBe("https://feishu.cn/docx/doxcnNEW");
    expect(receipt.content_appended).toBe(true);
  });

  it("append short-count lands as outcome-unknown, not a false success", async () => {
    const state: FakeState = {
      connection: connectedRow(await sealedBundle()),
    };
    const custom: CallFn = async (input) => {
      if (input.path.includes("tenant_access_token")) {
        return ok({ tenant_access_token: "t-1", expire: 3600 });
      }
      if (input.path.includes("metas/batch_query")) {
        return ok({ metas: [{ url: "https://feishu.cn/docx/doxcnAAAA" }] });
      }
      if (input.path.includes("/children")) {
        return ok({ children: [{}] }); // fewer than requested → partial
      }
      return { status: 404, code: null };
    };
    await expect(
      executeFeishuWrite(
        USER,
        FEISHU_TOOL.appendContent,
        { target: "doxcnAAAA", content: "one\n\ntwo\n\nthree" },
        { db: makeDb(state) as never, call: custom as never },
      ),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.OUTCOME_UNKNOWN });
  });

  it("a disconnected state never reaches the remote — token resolution fails first", async () => {
    const state: FakeState = { connection: null };
    const { calls } = makeRemote();
    const remoteCalls: CallInput[] = [];
    const spy: CallFn = async (input) => {
      remoteCalls.push(input);
      return ok({});
    };
    await expect(
      executeFeishuWrite(
        USER,
        FEISHU_TOOL.createDoc,
        { title: "x" },
        { db: makeDb(state) as never, call: spy as never },
      ),
    ).rejects.toMatchObject({ code: FEISHU_ERROR.NOT_CONNECTED });
    expect(remoteCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

// ─── Pure mappers and error classification ──────────────────────────────────

describe("pure helpers", () => {
  it("normalizeFeishuTarget classifies URLs and bare tokens", () => {
    expect(normalizeFeishuTarget("https://feishu.cn/docx/doxcnAAAA")).toEqual({
      kind: "docx",
      token: "doxcnAAAA",
    });
    expect(normalizeFeishuTarget("https://feishu.cn/wiki/wikcnBBBB")).toEqual({
      kind: "wiki",
      token: "wikcnBBBB",
    });
    expect(normalizeFeishuTarget("doxcnAAAA")).toEqual({
      kind: "docx",
      token: "doxcnAAAA",
    });
    expect(normalizeFeishuTarget("shtcnAAAA")).toEqual({
      kind: "sheet",
      token: "shtcnAAAA",
    });
    expect(normalizeFeishuTarget("bascnAAAA")).toEqual({
      kind: "bitable",
      token: "bascnAAAA",
    });
    expect(normalizeFeishuTarget("not a target")).toBeNull();
    expect(normalizeFeishuTarget("")).toBeNull();
  });

  it("markdownToFeishuBlocks keeps supported structure and never drops text", () => {
    const blocks = markdownToFeishuBlocks(
      "# Title\n\n- **bold** item\n\n1. step\n\n> quoted\n\nplain text",
    );
    const types = blocks.map((b) => b.block_type);
    expect(types).toEqual([3, 12, 13, 15, 2]);
    const flat = JSON.stringify(blocks);
    for (const fragment of ["Title", "bold", "step", "quoted", "plain text"]) {
      expect(flat).toContain(fragment);
    }
    // The approved text survives verbatim in block elements.
    const text = JSON.stringify(markdownToFeishuBlocks("literal *unclosed"));
    expect(text).toContain("literal *unclosed");
  });

  it("feishuApiError maps HTTP and business codes to stable classes", () => {
    expect(feishuApiError({ status: 429, code: null, retryAfterMs: 500 }).code)
      .toBe(FEISHU_ERROR.RATE_LIMITED);
    expect(feishuApiError({ status: 403, code: null }).code).toBe(
      FEISHU_ERROR.PERMISSION_DENIED,
    );
    expect(feishuApiError({ status: 404, code: null }).code).toBe(
      FEISHU_ERROR.OBJECT_NOT_FOUND,
    );
    expect(feishuApiError({ status: 500, code: null }).code).toBe(
      FEISHU_ERROR.OUTCOME_UNKNOWN,
    );
    expect(feishuApiError({ status: 200, code: 99991661 }).code).toBe(
      FEISHU_ERROR.REAUTH_REQUIRED,
    );
    expect(feishuApiError({ status: 200, code: 99991400 }).code).toBe(
      FEISHU_ERROR.RATE_LIMITED,
    );
    expect(feishuApiError({ status: 200, code: 99991672 }).code).toBe(
      FEISHU_ERROR.PERMISSION_DENIED,
    );
  });
});


describe("Feishu race and transport regressions", () => {
  it("wiki-only capability does not require drive listing", async () => {
    const state: FakeState = { connection: connectedRow({ ...await sealedBundle(), availableCapabilities: JSON.stringify([FEISHU_CAPABILITY.wikiRead]) }) };
    const remote = makeRemote({ "/drive/v1/files": async () => { throw new Error("drive must not run"); }, "/wiki/v2/spaces": async () => ok({ items: [{ space_id: "space-1", name: "Wiki" }] }) });
    const tools = buildFeishuAgentTools({ userId: USER, db: makeDb(state) as never, call: remote.call });
    const result = await tools.feishu_search_docs.execute!({}, { toolCallId: "wiki-search", messages: [] });
    expect(result).toMatchObject({ found: true });
    expect(remote.calls.some(c => c.path.includes("/drive/v1/files"))).toBe(false);
  });

  it.each([{ status: 400, code: 1770001 }, { status: 404, code: null }, { status: 400, code: 12345 }])("ambiguous probe %j grants no doc capability", async (response) => {
    const result = await probeFeishuCapabilities("token", async () => response);
    expect(result.capabilities).not.toContain(FEISHU_CAPABILITY.docxRead);
    expect(result.capabilities).not.toContain(FEISHU_CAPABILITY.docxWrite);
    expect(result.error).toBeDefined();
  });

  it("old verification cannot replace a new app's capabilities", async () => {
    const state: FakeState = { connection: connectedRow(await sealedBundle()) };
    const db = makeDb(state);
    const newer = makeRemote();
    const old = makeRemote({ "/drive/v1/files": async () => {
      await connectFeishu(USER, { appId: "cli_new_app", appSecret: APP_SECRET }, { db: db as never, call: newer.call });
      return { status: 403, code: null };
    }, "/wiki/v2/spaces": async () => ({ status: 403, code: null }), raw_content: async () => ({ status: 403, code: null }), batch_update: async () => ({ status: 403, code: null }) });
    const result = await verifyFeishuConnection(USER, { db: db as never, call: old.call });
    expect(result.appId).toBe("cli_new_app");
    expect(result.capabilities.readDoc).toBe(true);
    expect(result.capabilities.searchDocs).toBe(true);
  });

  it("disconnect after an append batch stops further batches and preserves uncertainty", async () => {
    const state: FakeState = { connection: connectedRow(await sealedBundle()) };
    const db = makeDb(state);
    let batches = 0;
    const remote = makeRemote({ "/children": async (input) => {
      batches++;
      await disconnectFeishu(USER, { db: db as never });
      return ok({ children: (input.body as { children: unknown[] }).children });
    } });
    await expect(executeFeishuWrite(USER, FEISHU_TOOL.appendContent, {
      target: "doxcnAAAA", content: Array.from({ length: 51 }, (_, i) => `line ${i}`).join("\n\n"),
    }, { db: db as never, call: remote.call })).rejects.toMatchObject({ code: FEISHU_ERROR.OUTCOME_UNKNOWN });
    expect(batches).toBe(1);
  });

  it("parses the official root-level token envelope through fetch", async () => {
    setFeishuApiFetch(async () => new Response(JSON.stringify({
      code: 0, msg: "ok", tenant_access_token: "fixture-token", expire: 7200,
    }), { status: 200 }));
    await expect(fetchTenantAccessToken(APP_ID, APP_SECRET)).resolves.toEqual({ token: "fixture-token", expiresInSec: 7200 });
  });

  it("keeps timeout active when a caller signal is present", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    setFeishuApiFetch(async (_url, init) => {
      const signal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
        timeout.abort();
      });
    });
    await expect(feishuRequest({ method: "GET", path: "/open-apis/test", signal: new AbortController().signal })).rejects.toMatchObject({ code: FEISHU_ERROR.OUTCOME_UNKNOWN });
  });

  it("first connect cannot resurrect a concurrent disconnect", async () => {
    const state: FakeState = { connection: null };
    const db = makeDb(state);
    const { call } = makeRemote({ tenant_access_token: async () => {
      await disconnectFeishu(USER, { db: db as never });
      return ok({ tenant_access_token: "late-token", expire: 3600 });
    } });
    const result = await connectFeishu(USER, { appId: APP_ID, appSecret: APP_SECRET }, { db: db as never, call });
    expect(result.status).toBe("DISCONNECTED");
    expect(state.connection!.encryptedCredential).toBeNull();
  });

  it.each([true, false])("late token result (success=%s) cannot alter a newer connection", async (success) => {
    const state: FakeState = { connection: connectedRow(await sealedBundle()) };
    const db = makeDb(state);
    const newer = makeRemote({ tenant_access_token: async () => ok({ tenant_access_token: "new-token", expire: 3600 }) });
    const old = makeRemote({ tenant_access_token: async () => {
      await disconnectFeishu(USER, { db: db as never });
      await connectFeishu(USER, { appId: "cli_new_app", appSecret: APP_SECRET }, { db: db as never, call: newer.call });
      return success ? ok({ tenant_access_token: "old-token", expire: 3600 }) : { status: 200, code: 10003 };
    } });
    await expect(resolveFeishuAccessToken(USER, { db: db as never, call: old.call })).rejects.toBeDefined();
    expect(state.connection!.status).toBe("CONNECTED");
    expect(state.connection!.appId).toBe("cli_new_app");
    await expect(resolveFeishuAccessToken(USER, { db: db as never, call: newer.call })).resolves.toBe("new-token");
  });

  it("refresh is single-flight even while credentials are unsealed", async () => {
    const state: FakeState = { connection: connectedRow(await sealedBundle()) };
    const db = makeDb(state);
    const remote = makeRemote();
    await Promise.all([resolveFeishuAccessToken(USER, { db: db as never, call: remote.call }), resolveFeishuAccessToken(USER, { db: db as never, call: remote.call })]);
    expect(remote.calls.filter(c => c.path.includes("tenant_access_token"))).toHaveLength(1);
  });

  it.each([401, 429, 500])("does not infer doc scopes from HTTP %s", async (status) => {
    const result = await probeFeishuCapabilities("token", async () => ({ status, code: null }));
    expect(result.capabilities).not.toContain(FEISHU_CAPABILITY.docxRead);
    expect(result.capabilities).not.toContain(FEISHU_CAPABILITY.docxWrite);
    expect(result.error).toBeDefined();
  });

  it("later batch denial preserves partial append as unknown", async () => {
    let count = 0;
    const blocks = markdownToFeishuBlocks(Array.from({ length: 51 }, (_, i) => `line ${i}`).join("\n\n"));
    await expect(appendDocxChildren("token", "doc", "doc", blocks, async () => ++count === 1
      ? ok({ children: Array.from({ length: 50 }, () => ({})) }) : { status: 403, code: null })).rejects.toMatchObject({ code: FEISHU_ERROR.OUTCOME_UNKNOWN });
    expect(count).toBe(2);
  });

  it.each([{}, { blocks: [] }])("missing/short edit receipts remain unknown (%j)", async (data) => {
    await expect(batchUpdateDocxBlocks("token", "doc", [{ block_id: "block" }], async () => ok(data))).rejects.toMatchObject({ code: FEISHU_ERROR.OUTCOME_UNKNOWN });
  });

  it("accepts new doc tokens and rejects foreign or deceptive hosts", () => {
    expect(normalizeFeishuTarget("UXEAd6cRUoj5pexJZr0cdwaFnpd")).toEqual({ kind: "docx", token: "UXEAd6cRUoj5pexJZr0cdwaFnpd" });
    expect(normalizeFeishuTarget("https://team.feishu.cn/docx/UXEAd6cRUoj5pexJZr0cdwaFnpd")?.kind).toBe("docx");
    for (const host of ["evil.example", "feishu.cn.evil.example", "evil-feishu.cn"]) expect(normalizeFeishuTarget(`https://${host}/docx/doxcnAAAA`)).toBeNull();
    expect(normalizeFeishuTarget("http://feishu.cn/docx/doxcnAAAA")).toBeNull();
  });
});
