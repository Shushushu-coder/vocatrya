import { NextRequest, NextResponse } from "next/server";
import { assertCareerDataCopyable } from "@/lib/career/access";
import prisma from "@/lib/db";
import {
  authenticateConnection,
  buildPairedProfile,
  parseRequestedSections,
  touchConnection,
} from "@/lib/extensions/autoApply/connect";
import {
  bearerToken,
  connectErrorResponse,
  NO_STORE,
  requireExtensionClient,
  unauthorized,
} from "../guards";

/**
 * GET /api/extensions/auto-apply/connect/profile?sections=basic,education
 *
 * On-demand profile pull for a paired plugin. Bearer-auth only; the token
 * maps to exactly one user, so profiles can never cross user boundaries.
 * `sections` narrows the pair-time grant and is intersected with it.
 */
export const GET = async (req: NextRequest) => {
  const denied = requireExtensionClient(req);
  if (denied) return denied;
  const token = bearerToken(req);
  if (!token) return unauthorized();

  try {
    const connection = await authenticateConnection(token);
    await assertCareerDataCopyable(prisma as never);
    const { searchParams } = new URL(req.url);
    const requested = parseRequestedSections(searchParams.get("sections"));
    const payload = await buildPairedProfile(connection, requested);

    const now = new Date();
    await touchConnection(connection.id, {
      lastSeenAt: now,
      lastSyncAt: now,
      lastProfileUpdatedAt: payload.profileV2.updatedAt,
    });

    return NextResponse.json(
      { ok: true, ...payload },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return connectErrorResponse(error);
  }
};
