import {
  getAgentChatPreflight,
  getChatConversation,
  saveChatConversation,
  clearChatConversation,
} from "@/actions/agentChat.actions";
import { getCurrentUser } from "@/utils/user.utils";
import { fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import { AIBusinessError } from "@/lib/ai/connections";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";

const prisma = new PrismaClient();

// The runtime-state channel is the only network seam in the preflight —
// everything else stays real (resolver, lock, connection lookups).
vi.mock("@/lib/ai/streaming-execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/streaming-execution")>();
  return { ...actual, fetchAccountRuntimeState: vi.fn() };
});
const runtimeState = vi.mocked(fetchAccountRuntimeState);

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    chatConversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
    (prisma.aIBusinessAssignment.findMany as any).mockResolvedValue([]);
    (prisma.chatConversation.create as any).mockImplementation(
      async ({ data }: any) => data,
    );
    (prisma.chatConversation.update as any).mockImplementation(
      async ({ data }: any) => data,
    );
  });

  it("getChatConversation scopes the read by userId", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue({
      messages: JSON.stringify([msg("a")]),
    });
    const result = await getChatConversation();
    expect(prisma.chatConversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(result.data).toEqual([msg("a")]);
  });

  it("getChatConversation returns an empty transcript when there is no row", async () => {
    const result = await getChatConversation();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("getChatConversation returns an empty transcript when the JSON is corrupt", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue({
      messages: "{ not json",
    });
    const result = await getChatConversation();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("saveChatConversation creates the row on userId and never accepts one as an argument", async () => {
    await saveChatConversation([msg("a")] as any);
    const call = (prisma.chatConversation.create as any).mock.calls[0][0];
    expect(call.data.userId).toBe("user-1");
    // Created while nothing is configured: the lock columns are null.
    expect(call.data.resolvedConnectionId).toBeNull();
    expect(call.data.resolvedModel).toBeNull();
    expect(saveChatConversation.length).toBe(1);
  });

  it("saveChatConversation updates messages only when the row exists", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue({
      id: "row-1",
      userId: "user-1",
      messages: "[]",
      resolvedConnectionId: "conn-a",
      resolvedModel: "m-1",
    });
    await saveChatConversation([msg("a")] as any);
    const call = (prisma.chatConversation.update as any).mock.calls[0][0];
    expect(call.where).toEqual({ userId: "user-1" });
    // The update touches only the transcript — a saved conversation never
    // re-resolves or rewrites its creation-time lock.
    expect(Object.keys(call.data)).toEqual(["messages"]);
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    expect(prisma.aIBusinessAssignment.findMany).not.toHaveBeenCalled();
  });

  it("saveChatConversation trims to the newest AGENT_CHAT_MAX_STORED_MESSAGES", async () => {
    const many = Array.from(
      { length: APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES + 5 },
      (_, i) => msg(`m${i}`),
    );
    await saveChatConversation(many as any);
    const call = (prisma.chatConversation.create as any).mock.calls[0][0];
    const stored = JSON.parse(call.data.messages);
    expect(stored).toHaveLength(APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES);
    expect(stored[stored.length - 1].id).toBe(`m${many.length - 1}`);
  });

  it("clearChatConversation deletes only the caller's row", async () => {
    await clearChatConversation();
    expect(prisma.chatConversation.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("every action fails closed without a session", async () => {
    (getCurrentUser as any).mockResolvedValue(null);
    expect((await getChatConversation()).success).toBe(false);
    expect((await saveChatConversation([])).success).toBe(false);
    expect((await clearChatConversation()).success).toBe(false);
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    expect(prisma.chatConversation.deleteMany).not.toHaveBeenCalled();
  });
});

describe("getAgentChatPreflight", () => {
  beforeEach(() => {
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (prisma.chatConversation.findUnique as any).mockResolvedValue(null);
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
    (prisma.chatConversation.findUnique as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue(verifiedState);
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "account",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      locked: true,
    });
  });

  it("blocks a locked turn when the runtime cannot stream", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(
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
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_SUPPORTED",
      connectionId: "conn-1",
    });
  });

  it("blocks on runtime version drift from the verified build", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockResolvedValue({
      ...verifiedState,
      runtimeVersion: "9.9.9",
    });
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STREAMING_NOT_VERIFIED",
    });
  });

  it("blocks when the runtime streams but its structured decisions are unverified", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(
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
    const result = await getAgentChatPreflight();
    expect(result.data).toMatchObject({
      kind: "blocked",
      code: "STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
  });

  it("fails closed when the runtime channel is unreachable", async () => {
    (prisma.chatConversation.findUnique as any).mockResolvedValue(
      lockedConversation(),
    );
    (prisma.aIConnection.findFirst as any).mockResolvedValue(
      lockedConnection(),
    );
    runtimeState.mockRejectedValue(
      new AIBusinessError("BACKEND_UNAVAILABLE", "down"),
    );
    const result = await getAgentChatPreflight();
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
});
