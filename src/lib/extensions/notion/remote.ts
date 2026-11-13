import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import {
  NOTION_ASYNC_TASK_BASE_DELAY_MS,
  NOTION_ASYNC_TASK_MAX_POLLS,
  NOTION_REMOTE,
} from "./constants";
import { NOTION_ERROR, NotionError, isNotionError } from "./errors";
import {
  callNotionRemoteTool,
  mapNotionRemoteError,
  remoteToolText,
  type NotionToolCallResult,
} from "./mcpClient";
import { resolveNotionAccessToken } from "./service";
import {
  NOTION_STATUS,
  getNotionConnection,
} from "./store";
import { isNotionToolAllowed } from "./capabilities";

type Db = Pick<PrismaClient, "notionConnection">;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A completed remote call or a mapped NotionError — never a raw throw. */
export async function invokeNotionTool(
  userId: string,
  agentToolName: string,
  remoteToolName: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal; db?: Db },
): Promise<NotionToolCallResult> {
  const db = options?.db ?? prisma;
  const row = await getNotionConnection(userId, db);
  // Execution-time gate: connection state and the last verified remote tool
  // set are re-checked on every call — a disconnect or a workspace-side
  // permission change between turn start and tool run must not execute.
  if (!isNotionToolAllowed(row, agentToolName)) {
    if (row?.status === NOTION_STATUS.REAUTH_REQUIRED) {
      throw new NotionError(NOTION_ERROR.REAUTH_REQUIRED);
    }
    throw new NotionError(
      row ? NOTION_ERROR.TOOL_UNAVAILABLE : NOTION_ERROR.NOT_CONNECTED,
    );
  }
  const accessToken = await resolveNotionAccessToken(userId, { db });
  try {
    const result = await callNotionRemoteTool(
      accessToken,
      remoteToolName,
      args,
      { signal: options?.signal },
    );
    await db.notionConnection
      .updateMany({
        where: { userId },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return await settleAsyncTask(accessToken, result);
  } catch (error) {
    const mapped = isNotionError(error)
      ? error
      : mapNotionRemoteError(error);
    if (mapped.code === NOTION_ERROR.REAUTH_REQUIRED) {
      await db.notionConnection.updateMany({
        where: { userId },
        data: {
          status: NOTION_STATUS.REAUTH_REQUIRED,
          encryptedCredential: null,
          credentialIv: null,
          lastError: mapped.code,
        },
      });
    }
    throw mapped;
  }
}

/**
 * A remote write can answer with a pollable async_task handle instead of a
 * synchronous result. Poll briefly — bounded — and treat "still running" as
 * OUTCOME_UNKNOWN so the caller verifies before retrying instead of
 * double-writing.
 */
async function settleAsyncTask(
  accessToken: string,
  result: NotionToolCallResult,
): Promise<NotionToolCallResult> {
  const structured = result.structuredContent as
    | Record<string, unknown>
    | undefined;
  const task =
    (structured?.async_task as Record<string, unknown> | undefined) ??
    (structured?.asyncTask as Record<string, unknown> | undefined);
  const taskId = typeof task?.id === "string" ? task.id : null;
  if (!taskId) return result;

  for (let poll = 0; poll < NOTION_ASYNC_TASK_MAX_POLLS; poll += 1) {
    await sleep(NOTION_ASYNC_TASK_BASE_DELAY_MS * (poll + 1));
    try {
      const status = await callNotionRemoteTool(
        accessToken,
        NOTION_REMOTE.asyncTask,
        { task_id: taskId },
      );
      const parsed = tryParseJson(remoteToolText(status));
      const state =
        (parsed?.status as string | undefined) ??
        (status.structuredContent as Record<string, unknown> | undefined)
          ?.status;
      if (state === "succeeded") {
        return status;
      }
      if (state === "failed") {
        throw new NotionError(NOTION_ERROR.REMOTE_FAILED);
      }
    } catch (error) {
      if (isNotionError(error)) throw error;
      throw mapNotionRemoteError(error);
    }
  }
  throw new NotionError(NOTION_ERROR.OUTCOME_UNKNOWN, { retryable: true });
}

export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export { remoteToolText };
