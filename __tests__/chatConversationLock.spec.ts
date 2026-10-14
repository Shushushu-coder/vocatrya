// ChatConversation creation-time AI lock — semantics pinned here:
//   - resolve-once at row creation, never re-resolved on update
//   - INVALID_ASSIGNMENT persists the broken pair (fail-closed, no fallback)
//   - NOT_CONFIGURED creates a null-lock (legacy) row
//   - an explicit selection is validated and never falls back
//   - a later message write cannot change the stored lock
//   - historical null/null rows decode as legacy, never get guessed
import {
  chatLockFromRow,
  resolveChatCreationLock,
  resolveExplicitChatSelection,
} from "@/lib/agent/chatConversationLock";
import {
  createChatConversationRecord,
  updateChatConversationMessages,
} from "@/lib/agent/chatConversationStore";
import { AIBusinessError } from "@/lib/ai/connections";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    chatConversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    aIConnection: {
      findFirst: vi.fn(),
    },
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(`P${code}`);
      this.code = code;
      this.name = "PrismaClientKnownRequestError";
    }
  }
  return {
    PrismaClient: vi.fn(function () {
      return mPrismaClient;
    }),
    Prisma: { PrismaClientKnownRequestError },
  };
});

vi.mock("@/lib/ai/assignments", () => ({
  resolveBusinessAIConfig: vi.fn(),
}));

const msg = (id: string) =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
  }) as never;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "conv-1",
  userId: "user-1",
  messages: "[]",
  resolvedConnectionId: null,
  resolvedModel: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("chatLockFromRow", () => {
  it("decodes a locked row as account", () => {
    expect(
      chatLockFromRow(row({ resolvedConnectionId: "c1", resolvedModel: "m" })),
    ).toEqual({ kind: "account", connectionId: "c1", model: "m" });
  });

  it("decodes a null-lock row as legacy — historical rows are never guessed", () => {
    expect(chatLockFromRow(row())).toEqual({ kind: "legacy" });
  });

  it("a connection id with a null model still counts as locked", () => {
    // MODEL_UNAVAILABLE surfaces at turn time, not by dropping the lock.
    expect(
      chatLockFromRow(row({ resolvedConnectionId: "c1" })),
    ).toEqual({ kind: "account", connectionId: "c1", model: null });
  });
});

describe("resolveChatCreationLock", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks to a RESOLVED assignment pair", async () => {
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "RESOLVED",
      connectionId: "conn-a",
      model: "model-a",
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
    });
    expect(await resolveChatCreationLock("user-1")).toEqual({
      resolvedConnectionId: "conn-a",
      resolvedModel: "model-a",
    });
    expect(resolveBusinessAIConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", purpose: "CAREER_DIALOGUE" }),
    );
  });

  it("locks to a broken explicit assignment — never falls back", async () => {
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "INVALID_ASSIGNMENT",
      code: "CONNECTION_DISCONNECTED",
      connectionId: "conn-broken",
      model: "model-b",
    });
    expect(await resolveChatCreationLock("user-1")).toEqual({
      resolvedConnectionId: "conn-broken",
      resolvedModel: "model-b",
    });
  });

  it("creates a null lock when nothing is configured", async () => {
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "NOT_CONFIGURED",
    });
    expect(await resolveChatCreationLock("user-1")).toEqual({
      resolvedConnectionId: null,
      resolvedModel: null,
    });
  });
});

describe("conversation message writes", () => {
  let dbRow: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    dbRow = null;
    (prisma.chatConversation.findFirst as any).mockImplementation(
      async () => dbRow,
    );
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "NOT_CONFIGURED",
    });
    (prisma.chatConversation.create as any).mockImplementation(
      async ({ data }: any) => {
        dbRow = {
          id: "new",
          title: data.title ?? null,
          context: data.context ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        return dbRow;
      },
    );
    (prisma.chatConversation.updateMany as any).mockImplementation(
      async ({ where, data }: any) => {
        if (!dbRow || dbRow.id !== where.id || dbRow.userId !== where.userId) {
          return { count: 0 };
        }
        dbRow = { ...dbRow, ...data };
        return { count: 1 };
      },
    );
  });

  it("raw transcript replacement is refused and leaves runtime lock intact", async () => {
    dbRow = row({ resolvedConnectionId: "conn-a", resolvedModel: "m-a" });
    await expect(updateChatConversationMessages("user-1", "conv-1", [msg("x")])).rejects.toThrow("CONVERSATION_TURN_CONFLICT");
    expect(prisma.chatConversation.updateMany).not.toHaveBeenCalled();
    expect(resolveBusinessAIConfig).not.toHaveBeenCalled();
    expect(dbRow.resolvedConnectionId).toBe("conn-a");
  });
  it("new row: resolves the lock inside the create and does not rewrite it later", async () => {
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "RESOLVED",
      connectionId: "conn-a",
      model: "m-a",
    });
    const messages = Array.from({ length: 52 }, (_, i) => msg(`m${i}`));
    const created = await createChatConversationRecord({
      userId: "user-1",
      messages,
      context: { version: 1, items: [] },
    });
    const create = (prisma.chatConversation.create as any).mock.calls[0][0];
    expect(JSON.parse(create.data.messages)).toEqual(messages);
    expect(create.data).toMatchObject({
      userId: "user-1",
      resolvedConnectionId: "conn-a",
      resolvedModel: "m-a",
    });
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "RESOLVED",
      connectionId: "conn-later",
      model: "m-later",
    });
    await expect(updateChatConversationMessages("user-1", created.id, [msg("y")])).rejects.toThrow("CONVERSATION_TURN_CONFLICT");
    expect(created.resolvedConnectionId).toBe("conn-a");
    expect(created.resolvedModel).toBe("m-a");
  });
});

describe("resolveExplicitChatSelection", () => {
  const eligible = {
    id: "conn-explicit",
    provider: "OPENAI",
    backendKind: "CODEX_RUNTIME",
    status: "CONNECTED",
    authType: "ACCOUNT_LOGIN",
    credentialRef: null,
    accountIdentity: null,
    runtimeProfileRef: "rp_11111111-2222-4333-8444-555555555555",
    archivedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aIConnection.findFirst as any).mockResolvedValue(eligible);
  });

  it("locks a new conversation to a validated explicit pair", async () => {
    await expect(
      resolveExplicitChatSelection("user-1", {
        connectionId: "conn-explicit",
        model: "gpt-5.6-luna",
      }),
    ).resolves.toEqual({
      resolvedConnectionId: "conn-explicit",
      resolvedModel: "gpt-5.6-luna",
    });
    expect(resolveBusinessAIConfig).not.toHaveBeenCalled();
    expect(prisma.aIConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-explicit", userId: "user-1" },
      }),
    );
  });

  it("does not fall back when the explicit connection is not owned", async () => {
    (prisma.aIConnection.findFirst as any).mockResolvedValue(null);
    await expect(
      resolveChatCreationLock("user-1", {
        connectionId: "foreign",
        model: "gpt-5.6-luna",
      }),
    ).rejects.toBeInstanceOf(AIBusinessError);
    expect(resolveBusinessAIConfig).not.toHaveBeenCalled();
  });
});
