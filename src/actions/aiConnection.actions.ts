"use server";

import db from "@/lib/db";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  isAIBackendKind,
  isAIConnectionOperation,
} from "@/lib/ai/connections";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import {
  listConnectionsForUser,
  type ConnectionSummary,
} from "@/lib/ai/connection-service";

export async function listAiConnections(): Promise<{
  success: boolean;
  data?: ConnectionSummary[];
  message?: string;
}> {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: await listConnectionsForUser(user.id),
    };
  } catch (error) {
    return handleError(error, "Failed to fetch AI connections") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Mints the single-use ticket the renderer hands to Electron main for one
 * runtime operation. This is where ownership is proven: connection-scoped
 * operations are refused unless the row belongs to the session user and is
 * not archived. The runtime later redeems the ticket through the internal
 * loopback API, which re-verifies the binding.
 */
export async function mintAiConnectionTicket(input: {
  operation: string;
  backendKind?: string;
  connectionId?: string;
}): Promise<{
  success: boolean;
  data?: { ticket: string };
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    if (!input || !isAIConnectionOperation(input.operation)) {
      return { success: false, code: "INVALID_OPERATION", message: "Invalid operation" };
    }
    const backendKind = input.backendKind;
    if (typeof backendKind !== "string" || !isAIBackendKind(backendKind)) {
      return { success: false, code: "UNSUPPORTED_BACKEND", message: "Unsupported backend" };
    }

    let connectionId: string | null = null;
    if (input.operation !== "login") {
      if (typeof input.connectionId !== "string" || !input.connectionId) {
        return { success: false, code: "CONNECTION_NOT_FOUND", message: "Connection not found" };
      }
      const connection = await db.aIConnection.findUnique({
        where: { id: input.connectionId },
        select: { userId: true, backendKind: true, archivedAt: true },
      });
      if (!connection || connection.userId !== user.id) {
        return { success: false, code: "CONNECTION_NOT_FOUND", message: "Connection not found" };
      }
      if (connection.archivedAt) {
        return { success: false, code: "CONNECTION_ARCHIVED", message: "Connection is archived" };
      }
      if (connection.backendKind !== backendKind) {
        return { success: false, code: "UNSUPPORTED_BACKEND", message: "Backend mismatch" };
      }
      connectionId = input.connectionId;
    }

    const record = mintConnectionTicket({
      userId: user.id,
      operation: input.operation,
      backendKind,
      connectionId,
    });
    return { success: true, data: { ticket: record.ticket } };
  } catch (error) {
    return handleError(error, "Failed to create connection ticket") as {
      success: boolean;
      message: string;
    };
  }
}
