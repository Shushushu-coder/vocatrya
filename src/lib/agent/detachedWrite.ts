import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import type {
  AgentFeishuWriteResult,
  AgentFeishuWriteVerify,
  AgentNotionWriteResult,
  AgentNotionWriteVerify,
} from "@/models/agent.model";
import {
  NOTION_WRITE_SPECS,
  notionWriteInputHash,
  type NotionWriteSpec,
} from "./notionWriteSpec";
import { FEISHU_WRITE_SPECS } from "./feishuWriteSpec";
import { isNotionAgentToolName } from "@/lib/extensions/notion/constants";
import { isFeishuAgentToolName } from "@/lib/extensions/feishu/constants";
import { isNotionToolAllowed } from "@/lib/extensions/notion/capabilities";
import { isFeishuToolAllowed } from "@/lib/extensions/feishu/capabilities";
import { getNotionConnection } from "@/lib/extensions/notion/store";
import { getFeishuConnection } from "@/lib/extensions/feishu/store";

/**
 * The merged detached-write registry: every tool whose execution is a
 * proposal → durable task → remote call → receipt, across providers. The
 * chat surface, proposal ledger and harness executor all resolve specs and
 * connection gates through here so a second provider never forks the
 * contract — it only supplies its own connection row and remote call.
 */
export type DetachedWriteProvider = "notion" | "feishu";

export type DetachedWriteVerify =
  | AgentNotionWriteVerify
  | AgentFeishuWriteVerify;

export type DetachedWriteResult =
  | AgentNotionWriteResult
  | AgentFeishuWriteResult;

export type DetachedWriteSpec = Omit<
  NotionWriteSpec,
  "receipt" | "verifyOf"
> & {
  provider: DetachedWriteProvider;
  receipt(
    resultText: string,
    input: Record<string, unknown>,
  ): DetachedWriteResult;
  verifyOf(input: Record<string, unknown>): DetachedWriteVerify;
};

export const DETACHED_WRITE_SPECS: Record<string, DetachedWriteSpec> =
  Object.fromEntries(
    [
      ...Object.entries(NOTION_WRITE_SPECS).map(
        ([name, spec]) =>
          [name, { ...spec, provider: "notion" as const }] as const,
      ),
      ...Object.entries(FEISHU_WRITE_SPECS).map(([name, spec]) => [
        name,
        spec,
      ]),
    ].map(([name, spec]) => [name, spec as DetachedWriteSpec]),
  );

export function detachedWriteSpec(name: string): DetachedWriteSpec | undefined {
  return DETACHED_WRITE_SPECS[name];
}

export function isDetachedWriteTool(name: string): boolean {
  return name in DETACHED_WRITE_SPECS;
}

export function detachedProviderOf(
  name: string,
): DetachedWriteProvider | null {
  const spec = DETACHED_WRITE_SPECS[name];
  if (spec) return spec.provider;
  if (isNotionAgentToolName(name)) return "notion";
  if (isFeishuAgentToolName(name)) return "feishu";
  return null;
}

/** The dedupe/write identity — verifiedNoDuplicate never changes it. */
export const detachedWriteInputHash = notionWriteInputHash;

type Db = Pick<PrismaClient, "notionConnection" | "feishuConnection">;

/**
 * Provider-aware execution gate: the live connection row for this tool's
 * provider must still allow it. Used wherever a decision or a dispatch
 * re-asserts capability after the proposal was created.
 */
export async function isDetachedToolAllowed(
  userId: string,
  toolName: string,
  db: Db = prisma,
): Promise<boolean> {
  const provider = detachedProviderOf(toolName);
  if (provider === "feishu") {
    return isFeishuToolAllowed(await getFeishuConnection(userId, db), toolName);
  }
  if (provider === "notion") {
    return isNotionToolAllowed(await getNotionConnection(userId, db), toolName);
  }
  return false;
}

/**
 * The connection identity a proposal binds: later dispatch compares it to
 * the live row and refuses WORKSPACE_CHANGED — an approved write cannot hop
 * to a silently different workspace/app.
 */
export async function detachedConnectionMaterial(
  userId: string,
  toolName: string,
  db: Db = prisma,
): Promise<Record<string, unknown>> {
  const provider = detachedProviderOf(toolName);
  if (provider === "feishu") {
    const row = await getFeishuConnection(userId, db);
    return {
      appId: typeof row?.appId === "string" ? row.appId : null,
    };
  }
  const row = await getNotionConnection(userId, db);
  return {
    workspaceId: typeof row?.workspaceId === "string" ? row.workspaceId : null,
  };
}
