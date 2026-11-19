import {
  createChatConversation,
  deleteChatConversation,
  getAgentChatPreflight,
  getAgentToolPermissions,
  getChatConversation,
  listChatConversations,
  loadActiveChatConversation,
  resolveDraftPageContext,
  saveChatConversation,
} from "@/actions/agentChat.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import { AIBusinessError } from "@/lib/ai/connections";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getAccountRuntimeCapabilities } = require(
  "../desktop/main/runtime/capabilities.js",
);

const prisma = new PrismaClient();

// The runtime-state channel is the only network seam in the preflight —
// everything else stays real (resolver, lock, connection lookups).
vi.mock("@/lib/ai/streaming-execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/streaming-execution")>();
  return { ...actual, fetchAccountRuntimeState: vi.fn() };
});
const runtimeState = vi.mocked(fetchAccountRuntimeState);

vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({
    success: true,
    data: { settings: { ai: { provider: "ollama", model: "legacy-model" } } },
  })),
}));

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    chatConversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    aIBusinessAssignment: {
      findMany: vi.fn(),
    },
    aIConnection: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    userSettings: {
      findUnique: vi.fn(),
    },
    agentOperationProposal: {
      findMany: vi.fn(async () => []),
    },
    job: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    resume: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mPrismaClient),
    ),
  };
  return {
    PrismaClient: vi.fn(function () {
      return mPrismaClient;
    }),
    Prisma: {
      PrismaClientKnownRequestError: class extends Error {
        code: string;
        constructor(code: string) {
          super(code);
          this.code = code;
        }
      },
    },
  };
});

vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));

vi.mock("@/lib/career/runtimeMode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/career/runtimeMode")>();
  return { ...actual, resolveCareerRuntimeMode: vi.fn(async () => ({ mode: "LEGACY_ONLY", origin: "legacy", rolloutScope: "none", reason: "test" })) };
});
vi.mock("@/lib/career/freshSurfacePolicy", () => ({ isFreshNativeFullSurface: () => true }));
vi.mock("@/lib/extensions/notion/service", () => ({ resolveNotionAgentToolNames: vi.fn(async () => ["notion_read", "notion_create_page"]) }));

const mockUser = { id: "user-1" };
const msg = (id: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});

describe("agentChat actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    // No conversation row, no assignments: the create path resolves to
    // NOT_CONFIGURED → a null-lock (legacy) row.
    (prisma.chatConversation.findFirst as any).mockResolvedValue(null);
    (prisma.chatConversation.findMany as any).mockResolvedValue([]);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([]);
    (prisma.chatConversation.create as any).mockImplementation(
      async ({ data }: any) => ({
        id: "created-1",
        revision: 0,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        updatedAt: new Date("2026-10-01T00:00:00.000Z"),
        title: data.title ?? null,
        context: data.context ?? null,
        ...data,
      }),
    );
    (prisma.chatConversation.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.chatConversation.deleteMany as any).mockResolvedValue({ count: 1 });
  });

  const ownedRow = (overrides: Record<string, unknown> = {}) => ({
    id: "row-1",
    revision: 0,
    userId: "user-1",
    title: "Saved title",
    context: null,
    messages: JSON.stringify([msg("a")]),
    resolvedConnectionId: "conn-a",
    resolvedModel: "m-1",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  });

  it("permissions use the persisted role rather than a supplied role", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(ownedRow({ agentRole: "reflect" }));
    const result = await getAgentToolPermissions({ conversationId: "row-1", agentRole: "pilot" });
    expect(result.success).toBe(true);
    expect(result.data?.tools.map(tool => tool.name)).toEqual(["list_jobs", "get_job", "notion_read", "suggest_role"]);
    expect(prisma.chatConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "row-1", userId: "user-1" } }));
  });

  it("permissions reject conversations the caller does not own", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(null);
    expect(await getAgentToolPermissions({ conversationId: "foreign", agentRole: "pilot" })).toMatchObject({ success: false, code: "CONVERSATION_NOT_FOUND" });
  });

  it("preserves an intentional active draft instead of loading the newest row", async () => {
    const result = await loadActiveChatConversation(APP_CONSTANTS.AGENT_CHAT_DRAFT_CONVERSATION_ID);
    expect(result).toEqual({ success: true, data: null });
    expect(prisma.chatConversation.findFirst).not.toHaveBeenCalled();
  });

  it("retains newest-conversation fallback for clients without a preference", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(ownedRow());
    const result = await loadActiveChatConversation();
    expect(result.data?.id).toBe("row-1");
    expect(prisma.chatConversation.findFirst).toHaveBeenCalled();
  });

  it("getChatConversation scopes the read by conversationId and userId", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(ownedRow());
    const result = await getChatConversation("row-1");
    expect(prisma.chatConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-1", userId: "user-1" } }),
    );
    expect(result.data?.messages).toEqual([msg("a")]);
  });

  it("getChatConversation rejects a conversation the caller does not own", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(null);
    const result = await getChatConversation("foreign");
    expect(result.success).toBe(false);
    expect(result.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("getChatConversation returns an empty transcript when the JSON is corrupt", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      ownedRow({ messages: "{ not json" }),
    );
    const result = await getChatConversation("row-1");
    expect(result.success).toBe(true);
    expect(result.data?.messages).toEqual([]);
  });

  it("createChatConversation persists a null lock when nothing is configured", async () => {
    const result = await createChatConversation({
      messages: [msg("a")] as any,
      firstUserText: "分析字节跳动产品岗位",
    });
    const call = (prisma.chatConversation.create as any).mock.calls[0][0];
    expect(call.data.userId).toBe("user-1");
    expect(call.data.resolvedConnectionId).toBeNull();
    expect(call.data.resolvedModel).toBeNull();
    expect(call.data.title).toBe("分析字节跳动产品岗位");
    expect(result.success).toBe(true);
    expect(saveChatConversation.length).toBe(2);
  });

  it("saveChatConversation cannot replace an existing transcript without request ownership", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(ownedRow());
    expect(await saveChatConversation("row-1", [msg("a")] as any)).toMatchObject({ success: false, code: "CONVERSATION_TURN_CONFLICT" });
    expect(prisma.chatConversation.updateMany).not.toHaveBeenCalled();
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });
  it("raw save cannot recreate a missing conversation", async () => {
    expect((await saveChatConversation("missing", [msg("a")] as any)).success).toBe(false);
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });
  it("deleteChatConversation deletes only the caller's named row", async () => {
    await deleteChatConversation("row-1");
    expect(prisma.chatConversation.deleteMany).toHaveBeenCalledWith({
      where: { id: "row-1", userId: "user-1" },
    });
  });

  it("listChatConversations returns only the caller's rows and no transcript", async () => {
    (prisma.chatConversation.findMany as any).mockResolvedValue([
      {
        id: "row-1",
        title: null,
        messages: JSON.stringify([msg("hello there")]),
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    ]);
    const result = await listChatConversations();
    expect(prisma.chatConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", archivedAt: null },
      }),
    );
    expect(result.data?.[0]).toMatchObject({
      id: "row-1",
      title: null,
      titleFallback: "hello there",
    });
    expect(result.data?.[0]).not.toHaveProperty("messages");
  });

  it("rejects a context entity the caller does not own", async () => {
    (prisma.job.findUnique as any).mockResolvedValue(null);
    const result = await createChatConversation({
      context: [{ kind: "job", entityId: "opportunity-1", source: "MANUAL" }],
    });
    expect(result.success).toBe(false);
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it("does not treat an unknown page id as a job in the active read family", async () => {
    (prisma.job.findUnique as any).mockResolvedValue(null);
    const result = await resolveDraftPageContext({ jobId: "opportunity-1" });
    expect(result.success).toBe(true);
    expect(result.data?.items).toEqual([]);
    expect(prisma.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "opportunity-1", userId: "user-1" },
      }),
    );
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it("every action fails closed without a session", async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    expect((await getChatConversation("row-1")).success).toBe(false);
    expect((await saveChatConversation("row-1", [])).success).toBe(false);
    expect((await deleteChatConversation("row-1")).success).toBe(false);
    expect((await createChatConversation()).success).toBe(false);
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    expect(prisma.chatConversation.updateMany).not.toHaveBeenCalled();
    expect(prisma.chatConversation.deleteMany).not.toHaveBeenCalled();
  });
});

describe("getAgentChatPreflight", () => {
  beforeEach(() => {
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (prisma.chatConversation.findFirst as any).mockResolvedValue(null);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([]);
  });

  const VERIFIED_STREAMING_CAPS = {
    implemented: true,
    execution: {
      localOneShot: true,
      streaming: true,
      streamingVerification: "PASS",
      streamingVerifiedRuntimeVersion: "0.154.0",
    },
    // Career Dialogue also needs the verified structured-decision step.
    structuredOutput: {
      strategy: "NATIVE_JSON_SCHEMA",
      mechanism: "codex exec --output-schema <schema-file>",
      verification: "PASS",
      verifiedRuntimeVersion: "0.154.0",
    },
  };
  const verifiedState = {
    capabilities: VERIFIED_STREAMING_CAPS,
    runtimeVersion: "0.154.0",
    runtimeReady: true,
  };

  const lockedConnection = (overrides: Record<string, unknown> = {}) => ({
    id: "conn-1",
    provider: "OPENAI",
    backendKind: "CODEX_RUNTIME",
    authType: "ACCOUNT_LOGIN", credentialRef: null, runtimeProfileRef: "rp_test", accountIdentity: null,
    displayName: "ChatGPT via Codex",
    status: "CONNECTED",
    archivedAt: null,
    ...overrides,
  });

  const lockedConversation = (overrides: Record<string, unknown> = {}) => ({
    id: "row-1",
    userId: "user-1",
    messages: "[]",
    resolvedConnectionId: "conn-1",
    resolvedModel: "gpt-5.6-sol",
    ...overrides,
  });

  it("reports a locked account turn ready when streaming is verified", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue(verifiedState);
    const result = await getAgentChatPreflight({ conversationId: "row-1" });
    expect(result.data).toMatchObject({
      kind: "account",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      locked: true,
    });
  });

  it("blocks a locked turn when the runtime cannot stream", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      ...verifiedState,
      capabilities: {
        ...VERIFIED_STREAMING_CAPS,
        execution: {
          ...VERIFIED_STREAMING_CAPS.execution,
          streaming: false,
          streamingVerification: "PENDING",
          streamingVerifiedRuntimeVersion: null,
        },
      },
    });
    const result = await getAgentChatPreflight({ conversationId: "row-1" });
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_SUPPORTED",
      connectionId: "conn-1",
    });
  });

  it("blocks on runtime version drift from the verified build", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      ...verifiedState,
      runtimeVersion: "9.9.9",
    });
    const result = await getAgentChatPreflight({ conversationId: "row-1" });
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_VERIFIED",
      model: "gpt-5.6-sol",
      displayName: "ChatGPT via Codex",
      locked: true,
    });
  });

  it("stays open for direct chat when streaming passes and structured decisions are unverified", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      ...verifiedState,
      capabilities: {
        ...VERIFIED_STREAMING_CAPS,
        structuredOutput: {
          strategy: "NATIVE_JSON_SCHEMA",
          mechanism: "codex exec --output-schema <schema-file>",
          verification: "PENDING",
          verifiedRuntimeVersion: null,
        },
      },
    });
    const result = await getAgentChatPreflight({ conversationId: "row-1" });
    expect(result.data).toMatchObject({
      kind: "account",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      locked: true,
    });
  });

  it("fails closed when the runtime channel is unreachable", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockRejectedValue(
      new AIBusinessError("BACKEND_UNAVAILABLE", "down"),
    );
    const result = await getAgentChatPreflight({ conversationId: "row-1" });
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "BACKEND_UNAVAILABLE",
    });
  });

  // Resolver rows carry the nested connection relation — the preflight
  // then queries the connection itself for the display fields.
  const assignmentRow = () => ({
    id: "assign-1",
    purpose: "GLOBAL_DEFAULT",
    connectionId: "conn-1",
    model: "gpt-5.6-sol",
    connection: {
      ...lockedConnection(),
      userId: "user-1",
      runtimeProfileRef: "rp_11111111-2222-4333-8444-555555555555",
    },
  });

  it("preflight-checks the GLOBAL_DEFAULT a new conversation would lock to", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
    // GLOBAL_DEFAULT row → RESOLVED → then streaming readiness decides.
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([
      assignmentRow(),
    ]);
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      ...verifiedState,
      capabilities: {
        ...VERIFIED_STREAMING_CAPS,
        execution: {
          ...VERIFIED_STREAMING_CAPS.execution,
          streamingVerification: "PENDING",
        },
      },
    });
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_VERIFIED",
    });
  });

  it("shows a ready GLOBAL_DEFAULT resolution with its model", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([
      assignmentRow(),
    ]);
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue(verifiedState);
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "account",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      locked: false,
    });
  });

  it("readies GLOBAL_DEFAULT gpt-5.6-luna on the certified Codex 0.165.0", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([
      { ...assignmentRow(), model: "gpt-5.6-luna" },
    ]);
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      capabilities: getAccountRuntimeCapabilities("CODEX_RUNTIME"),
      runtimeVersion: "0.165.0",
      runtimeReady: true,
    });
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "account",
      connectionId: "conn-1",
      model: "gpt-5.6-luna",
      locked: false,
    });
    expect(result.data).not.toMatchObject({ code: "STREAMING_NOT_VERIFIED" });
    expect(result.data).not.toMatchObject({
      code: "STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
  });

  it("blocks GLOBAL_DEFAULT when the installed Codex runtime is 0.161.0", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([
      assignmentRow(),
    ]);
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      capabilities: getAccountRuntimeCapabilities("CODEX_RUNTIME"),
      runtimeVersion: "0.161.0",
      runtimeReady: true,
    });
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_VERIFIED",
    });
  });

  it("reports a null-lock conversation as legacy and does not invent a lock", async () => {
    (prisma.chatConversation.findFirst as any).mockResolvedValue({
      id: "row-old",
      userId: "user-1",
      messages: "[]",
      resolvedConnectionId: null,
      resolvedModel: null,
    });
    const result = await getAgentChatPreflight({ conversationId: "row-old" });
    expect(result.data).toMatchObject({
      kind: "legacy",
      model: "legacy-model",
      persisted: true,
    });
    expect(result.data).not.toMatchObject({ locked: true });
  });

  it("does not fall back when an explicit draft selection is ineligible", async () => {
    (prisma.aIConnection.findFirst as any).mockResolvedValue(null);
    const before = (prisma.aIBusinessAssignment.findMany as any).mock.calls
      .length;
    const result = await getAgentChatPreflight({
      explicit: { connectionId: "missing", model: "gpt-5.6-luna" },
    });
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "ASSIGNED_CONNECTION_UNAVAILABLE",
    });
    expect((prisma.aIBusinessAssignment.findMany as any).mock.calls.length).toBe(
      before,
    );
  });
});
