// ChatConversation creation-time AI lock — semantics pinned here:
//   - resolve-once at row creation, never re-resolved on update
//   - INVALID_ASSIGNMENT persists the broken pair (fail-closed, no fallback)
//   - NOT_CONFIGURED creates a null-lock (legacy) row
//   - concurrent first turns converge on ONE lock (P2002 → canonical row)
//   - historical null/null rows decode as legacy, never get guessed
import {
  chatLockFromRow,
  resolveChatCreationLock,
} from "@/lib/agent/chatConversationLock";
import { persistChatMessages } from "@/lib/agent/chatConversationStore";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    chatConversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

describe("persistChatMessages", () => {
  // The fake "database row" — create writes it, update merges onto it, and
  // the race test can set it mid-flight to model a concurrent winner.
  let dbRow: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    dbRow = null;
    (prisma.chatConversation.findUnique as any).mockImplementation(
      async () => dbRow,
    );
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "NOT_CONFIGURED",
    });
    (prisma.chatConversation.create as any).mockImplementation(
      async ({ data }: any) => {
        dbRow = { id: "new", createdAt: new Date(), updatedAt: new Date(), ...data };
        return dbRow;
      },
    );
    (prisma.chatConversation.update as any).mockImplementation(
      async ({ data }: any) => {
        dbRow = { ...dbRow, ...data };
        return dbRow;
      },
    );
  });

  it("existing row: updates messages only, lock columns untouched", async () => {
    dbRow = row({ resolvedConnectionId: "conn-a", resolvedModel: "m-a" });
    const result = await persistChatMessages("user-1", [msg("x")]);
    const update = (prisma.chatConversation.update as any).mock.calls[0][0];
    expect(Object.keys(update.data)).toEqual(["messages"]);
    expect(resolveBusinessAIConfig).not.toHaveBeenCalled();
    expect(result.resolvedConnectionId).toBe("conn-a");
  });

  it("new row: resolves the lock inside the create", async () => {
    (resolveBusinessAIConfig as any).mockResolvedValue({
      status: "RESOLVED",
      connectionId: "conn-a",
      model: "m-a",
    });
    const result = await persistChatMessages("user-1", [msg("x")]);
    const create = (prisma.chatConversation.create as any).mock.calls[0][0];
    expect(create.data).toMatchObject({
      userId: "user-1",
      resolvedConnectionId: "conn-a",
      resolvedModel: "m-a",
    });
    expect(result.resolvedConnectionId).toBe("conn-a");
  });

  it("create race: adopts the winner's row and lock", async () => {
    // Two first turns race: the loser hits P2002 and must take the
    // canonical row's lock, not its own resolution.
    (prisma.chatConversation.create as any).mockImplementation(async () => {
      // The winner lands first — by the time this create rejects, the
      // canonical row is visible.
      dbRow = row({
        resolvedConnectionId: "conn-winner",
        resolvedModel: "m-winner",
      });
      throw new Prisma.PrismaClientKnownRequestError("P2002", {
        code: "P2002",
        clientVersion: "test",
      } as never);
    });
    const result = await persistChatMessages("user-1", [msg("x")]);
    expect(result.resolvedConnectionId).toBe("conn-winner");
    // The loser's messages still land — write-on-receipt is preserved.
    expect(prisma.chatConversation.update).toHaveBeenCalled();
  });
});
