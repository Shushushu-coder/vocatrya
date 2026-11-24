"use server";

/**
 * EXT-FEISHU server actions — the detail page's only server surface. Each
 * returns the non-secret extension state; the App Secret crosses this
 * boundary only on the connect call and is sealed before the service layer
 * returns.
 */
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  connectFeishu,
  disconnectFeishu,
  getFeishuExtensionState,
  verifyFeishuConnection,
  type FeishuExtensionState,
} from "@/lib/extensions/feishu/service";
import { isFeishuError } from "@/lib/extensions/feishu/errors";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code?: string; message?: string };

function fail(error: unknown, fallback: string): ActionResult<never> {
  if (isFeishuError(error)) {
    return { success: false, code: error.code };
  }
  const handled = handleError(error, fallback) as { message?: string };
  return { success: false, message: handled?.message ?? fallback };
}

export async function getFeishuExtensionStateAction(): Promise<
  ActionResult<FeishuExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await getFeishuExtensionState(user.id) };
  } catch (error) {
    return fail(error, "Failed to read Feishu connection state");
  }
}

export async function verifyFeishuConnectionAction(): Promise<
  ActionResult<FeishuExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await verifyFeishuConnection(user.id) };
  } catch (error) {
    return fail(error, "Failed to verify the Feishu connection");
  }
}

export async function connectFeishuAction(input: {
  appId: string;
  appSecret?: string;
}): Promise<ActionResult<FeishuExtensionState>> {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: await connectFeishu(user.id, {
        appId: input.appId,
        appSecret: input.appSecret ?? "",
      }),
    };
  } catch (error) {
    return fail(error, "Failed to connect Feishu");
  }
}

export async function disconnectFeishuAction(): Promise<
  ActionResult<FeishuExtensionState>
> {
  try {
    const user = await requireUser();
    return { success: true, data: await disconnectFeishu(user.id) };
  } catch (error) {
    return fail(error, "Failed to disconnect Feishu");
  }
}
