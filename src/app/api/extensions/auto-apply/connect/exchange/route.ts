import { NextRequest, NextResponse } from "next/server";
import {
  AUTO_APPLY_CONNECT_ERROR,
  AutoApplyConnectError,
  exchangePairingCode,
} from "@/lib/extensions/autoApply/connect";
import {
  connectErrorResponse,
  NO_STORE,
  requireExtensionClient,
} from "../guards";

/**
 * POST /api/extensions/auto-apply/connect/exchange
 *
 * Plugin-facing pairing exchange: trades the one-shot pairing code (shown
 * to the user in the app) for a long-lived bearer token. Unauthenticated
 * by design — the pairing code itself is the credential — and single-use.
 */
export const POST = async (req: NextRequest) => {
  const denied = requireExtensionClient(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const payload =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof payload.code === "string" ? payload.code : "";
  if (!code) {
    return NextResponse.json(
      {
        ok: false,
        error: "Pairing code is required",
        code: AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await exchangePairingCode(code, {
      name: payload.clientName,
      version: payload.clientVersion,
    });
    return NextResponse.json(
      { ok: true, ...result },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return connectErrorResponse(error);
  }
};
