"use server";

import db from "@/lib/db";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  isAIBackendKind,
  assertAccountExecutionIdentity,
  AIBusinessError,
  classifyAIConnection,
  isAIConnectionOperation,
  isAIConnectionProvider,
  isSupportedAccountProviderForBackend,
  supportedAccountProvidersForBackend,
  BYOK_BACKEND_KIND,
} from "@/lib/ai/connections";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import {
  listSelectableAccountConnectionsForUser,
  type ConnectionSummary,
} from "@/lib/ai/connection-service";
import { ensureByokConnectionsForUser } from "@/lib/ai/byok";

export async function listAiConnections(): Promise<{
  success: boolean;
  data?: ConnectionSummary[];
  message?: string;
}> {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: await listSelectableAccountConnectionsForUser(user.id),
    };
  } catch (error) {
    return handleError(error, "Failed to fetch AI connections") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Assignment pickers list every user-pinnable source: account-login
 * connections plus BYOK API-key connections (self-healed against the
 * ApiKey table on read). Managed connections are provisioned by the
 * managed assignment entry point instead — callers never pick their id.
 */
export async function listAssignableAiConnections(): Promise<{
  success: boolean;
  data?: ConnectionSummary[];
  message?: string;
}> {
  try {
    const user = await requireUser();
    await ensureByokConnectionsForUser(user.id);
    const rows = await db.aIConnection.findMany({
      where: { userId: user.id, archivedAt: null },
      select: {
        id: true,
        provider: true,
        authType: true,
        backendKind: true,
        displayName: true,
        accountIdentity: true,
        status: true,
        runtimeProfileRef: true,
        credentialRef: true,
        lastVerifiedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      success: true,
      data: rows
        .filter((row) => {
          const kind = classifyAIConnection(row);
          return kind === "ACCOUNT_LOGIN" || kind === "BYOK";
        })
        .map(({ credentialRef: _credentialRef, ...row }) => row),
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
  accountProvider?: string;
  connectionId?: string;
}): Promise<{
  success: boolean;
  data?: { ticket: string };
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    // executeText tickets are minted by the business execution seam
    // (src/lib/ai/execution.ts), never by renderer-facing actions.
    if (
      !input ||
      !isAIConnectionOperation(input.operation) ||
      input.operation === "executeText"
    ) {
      return { success: false, code: "INVALID_OPERATION", message: "Invalid operation" };
    }
    const backendKind = input.backendKind;
    if (typeof backendKind !== "string" || !isAIBackendKind(backendKind) || backendKind === "MANAGED_GATEWAY" || backendKind === BYOK_BACKEND_KIND) {
      return { success: false, code: "UNSUPPORTED_BACKEND", message: "Unsupported backend" };
    }

    // The requested account provider is a renderer *request* — it only
    // becomes binding after server-side validation against the runtime's
    // supported-provider matrix. Single-provider backends default to their
    // sole provider; multi-provider runtimes require an explicit choice.
    const supported = supportedAccountProvidersForBackend(backendKind);
    let accountProvider: string | null = null;
    if (input.operation === "login") {
      if (typeof input.accountProvider === "string" && input.accountProvider) {
        if (
          !isAIConnectionProvider(input.accountProvider) ||
          !isSupportedAccountProviderForBackend(backendKind, input.accountProvider)
        ) {
          return {
            success: false,
            code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
            message: "Provider is not supported on this runtime",
          };
        }
        accountProvider = input.accountProvider;
      } else if (supported.length === 1) {
        accountProvider = supported[0];
      } else {
        return {
          success: false,
          code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
          message: "An account provider is required for this runtime",
        };
      }
    }

    let connectionId: string | null = null;
    if (input.operation !== "login") {
      if (typeof input.connectionId !== "string" || !input.connectionId) {
        return { success: false, code: "CONNECTION_NOT_FOUND", message: "Connection not found" };
      }
      const connection = await db.aIConnection.findUnique({
        where: { id: input.connectionId },
        select: { userId: true, backendKind: true, provider: true, authType: true, credentialRef: true, runtimeProfileRef: true, accountIdentity: true, archivedAt: true },
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
      if (
        typeof input.accountProvider === "string" &&
        input.accountProvider &&
        input.accountProvider !== connection.provider
      ) {
        return {
          success: false,
          code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
          message: "Provider does not match this connection",
        };
      }
      try { assertAccountExecutionIdentity(connection); } catch (error) {
        if (error instanceof AIBusinessError) return { success: false, code: error.code, message: error.message };
        throw error;
      }
      connectionId = input.connectionId;
      accountProvider = connection.provider;
    }

    const record = mintConnectionTicket({
      userId: user.id,
      operation: input.operation,
      backendKind,
      accountProvider,
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
