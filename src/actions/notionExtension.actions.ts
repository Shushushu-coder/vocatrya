"use server";

/**
 * EXT-NOTION server actions — the detail page's only server surface. Each
 * returns the non-secret extension state; token material never leaves the
 * service layer.
 */
import { headers } from "next/headers";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  disconnectNotion,
  getNotionExtensionState,
  startNotionConnect,
  verifyNotionConnection,
  type NotionExtensionState,
} from "@/lib/extensions/notion/service";
import { isNotionError } from "@/lib/extensions/notion/errors";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code?: string; message?: string };

function fail(error: unknown, fallback: string): ActionResult<never> {
  if (isNotionError(error)) {
    return { success: false, code: error.code };
  }
  const handled = handleError(error, fallback) as { message?: string };
  return { success: false, message: handled?.message ?? fallback };
}

/**
 * The app origin the OAuth callback redirects back to. Loopback Electron
 * backends bind an OS-assigned port, so the origin is read from the request
 * headers rather than configured.
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
  if (!host) throw new Error("NOTION_APP_ORIGIN_UNAVAILABLE");
  return `${proto}://${host}`;
}

export async function getNotionExtensionStateAction(): Promise<
  ActionResult<NotionExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await getNotionExtensionState(user.id) };
  } catch (error) {
    return fail(error, "Failed to read Notion connection state");
  }
}

export async function verifyNotionConnectionAction(): Promise<
  ActionResult<NotionExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await verifyNotionConnection(user.id) };
  } catch (error) {
    return fail(error, "Failed to verify the Notion connection");
  }
}

export async function startNotionConnectAction(): Promise<
  ActionResult<{ authorizationUrl: string }>
> {
  try {
    const user = await requireUser();
    const origin = await appOrigin();
    return {
      success: true,
      data: await startNotionConnect(user.id, origin),
    };
  } catch (error) {
    return fail(error, "Failed to start the Notion connection");
  }
}

export async function disconnectNotionAction(): Promise<
  ActionResult<NotionExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await disconnectNotion(user.id) };
  } catch (error) {
    return fail(error, "Failed to disconnect Notion");
  }
}
