"use server";

/**
 * EXT-AUTO-APPLY connect server actions — session-authenticated management
 * surface for the detail page. Pairing codes are shown to the user once;
 * only the secret hash persists. Access tokens never leave the service
 * layer and are never returned to the app UI.
 */
import { headers } from "next/headers";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import { assertCareerDataCopyable } from "@/lib/career/access";
import prisma from "@/lib/db";
import {
  AutoApplyConnectError,
  createPairingRequest,
  listConnections,
  parseSectionGrant,
  revokeConnection,
  type AutoApplyConnectionSummary,
} from "@/lib/extensions/autoApply/connect";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code?: string; message?: string };

function fail(error: unknown, fallback: string): ActionResult<never> {
  if (error instanceof AutoApplyConnectError) {
    return { success: false, code: error.code, message: error.message };
  }
  const handled = handleError(error, fallback) as { message?: string };
  return { success: false, message: handled?.message ?? fallback };
}

/**
 * The plugin needs the concrete loopback origin to call — desktop backends
 * bind an OS-assigned port, so it is read from the request headers rather
 * than configured. Same approach as the Notion connect flow.
 */
async function appOrigin(): Promise<string> {
  const headerList = await headers();
  const origin = headerList.get("origin") ?? headerList.get("referer");
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      // Fall through to host.
    }
  }
  const host = headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  if (!host) throw new Error("AUTO_APPLY_APP_ORIGIN_UNAVAILABLE");
  return `${proto}://${host}`;
}

export async function listAutoApplyConnectionsAction(): Promise<
  ActionResult<{ connections: AutoApplyConnectionSummary[] }>
> {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: { connections: await listConnections(user.id) },
    };
  } catch (error) {
    return fail(error, "Failed to list extension connections");
  }
}

export async function createAutoApplyPairingAction(
  rawSections: unknown,
): Promise<
  ActionResult<{ pairingString: string; expiresAt: string; appOrigin: string }>
> {
  try {
    const user = await requireUser();
    // Pairing authorizes later profile pulls — enforce the read/copy gate
    // up front so a disabled runtime never hands out credentials.
    await assertCareerDataCopyable(prisma as never);
    const sections = parseSectionGrant(rawSections);
    const origin = await appOrigin();
    const pairing = await createPairingRequest(user.id, origin, sections);
    return {
      success: true,
      data: {
        pairingString: pairing.pairingString,
        expiresAt: pairing.expiresAt,
        appOrigin: origin,
      },
    };
  } catch (error) {
    return fail(error, "Failed to create pairing code");
  }
}

export async function revokeAutoApplyConnectionAction(
  connectionId: string,
): Promise<ActionResult<{ revoked: boolean }>> {
  try {
    const user = await requireUser();
    if (typeof connectionId !== "string" || !connectionId) {
      return { success: false, code: "INVALID_REQUEST" };
    }
    return {
      success: true,
      data: { revoked: await revokeConnection(user.id, connectionId) },
    };
  } catch (error) {
    return fail(error, "Failed to revoke extension connection");
  }
}
