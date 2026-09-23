import { NextResponse } from "next/server";
import {
  assertInternalRequest,
  InternalApiError,
} from "@/lib/ai/internal-auth";
import { resolveConnectionTicket } from "@/lib/ai/connection-tickets";
import {
  ConnectionOpError,
  getConnectionOperationContext,
} from "@/lib/ai/connection-service";
import { AI_CONNECTION_OP_ERROR_CODES } from "@/lib/ai/connections";

function internalAuthFailure(error: unknown) {
  const notConfigured =
    error instanceof InternalApiError && error.code === "NOT_CONFIGURED";
  return NextResponse.json(
    { ok: false, code: "UNAUTHORIZED" },
    { status: notConfigured ? 404 : 401 },
  );
}

/**
 * Redeems a session-minted ticket into the operation context Electron main
 * needs: the operationId it reports completion against plus, for
 * connection-scoped operations, the verified connection binding (opaque
 * profile ref + stored identity). Single-use: a ticket resolves at most
 * once.
 */
export async function POST(request: Request) {
  try {
    assertInternalRequest(request);
  } catch (error) {
    return internalAuthFailure(error);
  }

  const body = await request.json().catch(() => null);
  const ticket =
    body && typeof body === "object" && typeof body.ticket === "string"
      ? body.ticket
      : null;
  if (!ticket) {
    return NextResponse.json(
      { ok: false, code: AI_CONNECTION_OP_ERROR_CODES.INVALID_TICKET },
      { status: 400 },
    );
  }

  const record = resolveConnectionTicket(ticket);
  if (!record) {
    return NextResponse.json(
      { ok: false, code: AI_CONNECTION_OP_ERROR_CODES.INVALID_TICKET },
      { status: 400 },
    );
  }

  if (record.operation === "login") {
    return NextResponse.json({
      ok: true,
      operationId: record.operationId,
      operation: record.operation,
      backendKind: record.backendKind,
    });
  }

  try {
    const connection = await getConnectionOperationContext({
      userId: record.userId,
      connectionId: record.connectionId ?? "",
    });
    // Project the fields the runtime actually needs — userId and lifecycle
    // internals never leave the server.
    return NextResponse.json({
      ok: true,
      operationId: record.operationId,
      operation: record.operation,
      backendKind: record.backendKind,
      connection: {
        id: connection.id,
        backendKind: connection.backendKind,
        runtimeProfileRef: connection.runtimeProfileRef,
        accountIdentity: connection.accountIdentity,
        status: connection.status,
      },
    });
  } catch (error) {
    if (error instanceof ConnectionOpError) {
      const status =
        error.code === AI_CONNECTION_OP_ERROR_CODES.CONNECTION_NOT_FOUND
          ? 404
          : 409;
      return NextResponse.json({ ok: false, code: error.code }, { status });
    }
    throw error;
  }
}
