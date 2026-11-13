import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  authenticateConnection,
  touchConnection,
} from "@/lib/extensions/autoApply/connect";
import { getAutoApplyExtensionStatus } from "@/lib/extensions/autoApply/status";
import {
  bearerToken,
  connectErrorResponse,
  NO_STORE,
  requireExtensionClient,
  unauthorized,
} from "../guards";

/**
 * GET /api/extensions/auto-apply/connect/status
 *
 * Lightweight liveness/freshness check for the paired plugin: reports the
 * latest source timestamp so the plugin can flag "Vocatrya 资料有更新"
 * without downloading the whole profile.
 */
export const GET = async (req: NextRequest) => {
  const denied = requireExtensionClient(req);
  if (denied) return denied;
  const token = bearerToken(req);
  if (!token) return unauthorized();

  try {
    const connection = await authenticateConnection(token);
    const status = await getAutoApplyExtensionStatus(prisma, connection.userId);
    await touchConnection(connection.id, { lastSeenAt: new Date() });
    return NextResponse.json(
      {
        ok: true,
        connectionId: connection.id,
        careerRead: status.available,
        sourceUpdatedAt: status.lastSourceUpdatedAt,
        serverTime: new Date().toISOString(),
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return connectErrorResponse(error);
  }
};
