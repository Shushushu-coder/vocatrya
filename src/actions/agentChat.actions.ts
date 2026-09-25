"use server";

import type { UIMessage } from "ai";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  getChatConversationRow,
  persistChatMessages,
} from "@/lib/agent/chatConversationStore";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { CHAT_LOCK_PURPOSE } from "@/lib/agent/chatConversationLock";

export const getChatConversation = async (): Promise<{
  success: boolean;
  data?: UIMessage[];
  message?: string;
}> => {
  try {
    const user = await requireUser();

    const row = await getChatConversationRow(user.id);
    if (!row) return { success: true, data: [] };

    // A corrupt row must not break the whole dashboard layout, which awaits
    // this on every render — an empty transcript is the safe answer.
    try {
      return { success: true, data: JSON.parse(row.messages) as UIMessage[] };
    } catch {
      console.error("Chat conversation JSON was unreadable; returning empty.");
      return { success: true, data: [] };
    }
  } catch (error) {
    return handleError(error, "Failed to load the conversation.");
  }
};

export const saveChatConversation = async (
  messages: UIMessage[],
): Promise<{ success: boolean; message?: string }> => {
  try {
    const user = await requireUser();
    // Routed through the store so a create also writes the creation-time
    // AI lock — every row-creating path resolves identically.
    await persistChatMessages(user.id, messages);
    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to save the conversation.");
  }
};

export const clearChatConversation = async (): Promise<{
  success: boolean;
  message?: string;
}> => {
  try {
    const user = await requireUser();

    // deleteMany, not delete: deleting a row that does not exist must not
    // throw, since Clear is the hard reset and has to always work. Deleting
    // the row also drops the AI lock — the next message starts a new
    // session that resolves the CURRENT assignment.
    await prisma.chatConversation.deleteMany({ where: { userId: user.id } });

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to clear the conversation.");
  }
};

export type AgentChatPreflight =
  | {
      kind: "account";
      connectionId: string;
      provider: string;
      backendKind: string;
      model: string;
      displayName: string;
      locked: boolean;
    }
  | { kind: "blocked"; code: string; connectionId?: string }
  | { kind: "legacy" };

/**
 * Read-only view of what the NEXT chat turn would run on. The composer uses
 * it instead of probing legacy settings when an account lock or a
 * CAREER_DIALOGUE assignment governs the conversation. Never executes
 * anything — readiness is re-checked at the route on every turn.
 */
export const getAgentChatPreflight = async (): Promise<{
  success: boolean;
  data?: AgentChatPreflight;
  message?: string;
}> => {
  try {
    const user = await requireUser();

    const row = await getChatConversationRow(user.id);
    const lock = row ? chatLockFromRow(row) : null;

    if (lock?.kind === "account") {
      const connection = await prisma.aIConnection.findFirst({
        where: { id: lock.connectionId, userId: user.id },
        select: {
          id: true,
          provider: true,
          backendKind: true,
          displayName: true,
          status: true,
          archivedAt: true,
        },
      });
      if (!connection || connection.archivedAt) {
        return {
          success: true,
          data: {
            kind: "blocked",
            code: "ASSIGNED_CONNECTION_UNAVAILABLE",
            connectionId: lock.connectionId,
          },
        };
      }
      if (connection.status !== "CONNECTED") {
        return {
          success: true,
          data: {
            kind: "blocked",
            code:
              connection.status === "REAUTH_REQUIRED"
                ? "REAUTH_REQUIRED"
                : connection.status === "DISCONNECTED"
                  ? "CONNECTION_DISCONNECTED"
                  : "CONNECTION_ERROR",
            connectionId: connection.id,
          },
        };
      }
      if (!lock.model) {
        return {
          success: true,
          data: { kind: "blocked", code: "MODEL_UNAVAILABLE" },
        };
      }
      return {
        success: true,
        data: {
          kind: "account",
          connectionId: connection.id,
          provider: connection.provider,
          backendKind: connection.backendKind,
          model: lock.model,
          displayName: connection.displayName,
          locked: true,
        },
      };
    }

    if (row) {
      // Null lock — the conversation predates locking or was created while
      // nothing was configured. Legacy live-settings semantics.
      return { success: true, data: { kind: "legacy" } };
    }

    // No conversation yet — preview what the first turn would lock to.
    const resolution = await resolveBusinessAIConfig({
      userId: user.id,
      purpose: CHAT_LOCK_PURPOSE,
    });
    if (resolution.status === "RESOLVED") {
      const connection = await prisma.aIConnection.findFirst({
        where: { id: resolution.connectionId, userId: user.id },
        select: { displayName: true },
      });
      return {
        success: true,
        data: {
          kind: "account",
          connectionId: resolution.connectionId,
          provider: resolution.provider,
          backendKind: resolution.backendKind,
          model: resolution.model,
          displayName: connection?.displayName ?? resolution.provider,
          locked: false,
        },
      };
    }
    if (resolution.status === "INVALID_ASSIGNMENT") {
      return {
        success: true,
        data: {
          kind: "blocked",
          code: resolution.code,
          connectionId: resolution.connectionId,
        },
      };
    }
    return { success: true, data: { kind: "legacy" } };
  } catch (error) {
    return handleError(error, "Failed to check the assistant configuration.");
  }
};
