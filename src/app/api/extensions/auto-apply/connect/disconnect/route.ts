import { NextRequest, NextResponse } from "next/server";
import {
  revokeConnectionByToken,
} from "@/lib/extensions/autoApply/connect";
import {
  bearerToken,
  connectErrorResponse,
  NO_STORE,
  requireExtensionClient,
  unauthorized,
} from "../guards";

/**
 * POST /api/extensions/auto-apply/connect/disconnect
 *
 * Plugin-side disconnect: the presented token revokes itself. After this
 * the token can never pull data again, matching an in-app revoke.
 */
export const POST = async (req: NextRequest) => {
  const denied = requireExtensionClient(req);
  if (denied) return denied;
  const token = bearerToken(req);
  if (!token) return unauthorized();

  try {
    await revokeConnectionByToken(token);
    return NextResponse.json(
      { ok: true, revoked: true },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return connectErrorResponse(error);
  }
};
