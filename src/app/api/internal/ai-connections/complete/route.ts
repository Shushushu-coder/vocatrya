import { NextResponse } from "next/server";
import {
  assertInternalRequest,
  InternalApiError,
} from "@/lib/ai/internal-auth";
import { completeConnectionOperation } from "@/lib/ai/connection-tickets";
import {
  applyDisconnect,
  applyReconnectAuthenticated,
  applyReconnectIdentityConflict,
  applyVerifyResult,
  ConnectionOpError,
  createVerifiedAccountConnection,
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

function invalidResult() {
  return NextResponse.json(
    { ok: false, code: "INVALID_RESULT" },
    { status: 400 },
  );
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Completion sink for runtime operations. Electron main reports only the
 * verified outcome — an auth state enum, an opaque profile ref, an optional
 * non-secret identity — never tokens, paths, or raw process output. This is
 * the only path that mutates AIConnection rows for account-login flows.
 */
export async function POST(request: Request) {
  try {
    assertInternalRequest(request);
  } catch (error) {
    return internalAuthFailure(error);
  }

  const body = await request.json().catch(() => null);
  const operationId =
    body && typeof body === "object" && typeof body.operationId === "string"
      ? body.operationId
      : null;
  const result =
    body && typeof body === "object" && body.result && typeof body.result === "object"
      ? (body.result as Record<string, unknown>)
      : null;
  if (!operationId || !result) {
    return invalidResult();
  }

  const record = completeConnectionOperation(operationId);
  if (!record) {
    return NextResponse.json(
      { ok: false, code: AI_CONNECTION_OP_ERROR_CODES.INVALID_TICKET },
      { status: 400 },
    );
  }

  try {
    switch (record.operation) {
      case "login": {
        if (result.outcome !== "authenticated") return invalidResult();
        const runtimeProfileRef = asNullableString(result.runtimeProfileRef);
        if (!runtimeProfileRef) return invalidResult();
        const connection = await createVerifiedAccountConnection({
          userId: record.userId,
          backendKind: record.backendKind,
          runtimeProfileRef,
          accountIdentity: asNullableString(result.accountIdentity),
        });
        return NextResponse.json({ ok: true, connection });
      }
      case "reconnect": {
        if (result.outcome === "authenticated") {
          const connection = await applyReconnectAuthenticated({
            userId: record.userId,
            connectionId: record.connectionId ?? "",
            accountIdentity: asNullableString(result.accountIdentity),
          });
          return NextResponse.json({ ok: true, connection });
        }
        if (result.outcome === "identity_conflict") {
          const connection = await applyReconnectIdentityConflict({
            userId: record.userId,
            connectionId: record.connectionId ?? "",
          });
          return NextResponse.json({
            ok: false,
            code: AI_CONNECTION_OP_ERROR_CODES.ACCOUNT_IDENTITY_CONFLICT,
            connection,
          });
        }
        if (result.outcome === "auth_state") {
          const connection = await applyVerifyResult({
            userId: record.userId,
            connectionId: record.connectionId ?? "",
            authState: asNullableString(result.authState) ?? "UNKNOWN",
          });
          return NextResponse.json({ ok: true, connection });
        }
        return invalidResult();
      }
      case "verify": {
        if (result.outcome !== "auth_state") return invalidResult();
        const connection = await applyVerifyResult({
          userId: record.userId,
          connectionId: record.connectionId ?? "",
          authState: asNullableString(result.authState) ?? "UNKNOWN",
        });
        return NextResponse.json({ ok: true, connection });
      }
      case "disconnect": {
        if (result.outcome !== "disconnected") return invalidResult();
        const connection = await applyDisconnect({
          userId: record.userId,
          connectionId: record.connectionId ?? "",
        });
        return NextResponse.json({ ok: true, connection });
      }
      case "listModels":
      case "smoke": {
        // Read-only operations: completing them just spends the ticket.
        return NextResponse.json({ ok: true });
      }
      default:
        return invalidResult();
    }
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
