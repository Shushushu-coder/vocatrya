"use client";

import { APP_CONSTANTS } from "@/lib/constants";
import { isAgentRole, type AgentRole } from "./agentRoles";
import type { AgentConversationContextV1 } from "./conversationContext";
import type { ExplicitModelSelection } from "./chatTypes";

/**
 * Per-role slot persistence (D1). Each role keeps its own last-active
 * conversation id, draft context, explicit model pick and unsent composer
 * text; switching roles snapshots the outgoing slot and restores the
 * incoming one, and the "active role" key makes a reload reopen the same
 * slot. Unknown/corrupt payloads degrade to empty slots — never to an
 * exception on panel mount.
 */

export type StoredRoleSlot = {
  conversationId: string | null;
  draft: string | null;
  context?: AgentConversationContextV1;
  explicit?: ExplicitModelSelection | null;
};

export function readActiveAgentRole(): AgentRole | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(
    APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY,
  );
  return isAgentRole(raw) ? raw : null;
}

export function writeActiveAgentRole(role: AgentRole): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY, role);
}

type SlotMap = Partial<Record<AgentRole, StoredRoleSlot>>;

function isValidContext(value: unknown): value is AgentConversationContextV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function sanitizeSlot(raw: unknown): StoredRoleSlot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const slot = raw as Record<string, unknown>;
  const conversationId =
    typeof slot.conversationId === "string" && slot.conversationId
      ? slot.conversationId
      : null;
  const draft =
    typeof slot.draft === "string" && slot.draft ? slot.draft : null;
  const context = isValidContext(slot.context) ? slot.context : undefined;
  const explicit =
    typeof slot.explicit === "object" && slot.explicit !== null
      ? (slot.explicit as ExplicitModelSelection)
      : null;
  if (!conversationId && !draft && !context && !explicit) return null;
  return { conversationId, draft, context, explicit };
}

export function readAgentRoleSlots(): SlotMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(
      APP_CONSTANTS.AGENT_CHAT_ROLE_SLOTS_KEY,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const slots: SlotMap = {};
    for (const role of ["insight", "pilot", "reflect"] as const) {
      const slot = sanitizeSlot(parsed[role]);
      if (slot) slots[role] = slot;
    }
    return slots;
  } catch {
    return {};
  }
}

export function writeAgentRoleSlot(
  role: AgentRole,
  slot: StoredRoleSlot,
): void {
  if (typeof window === "undefined") return;
  const slots = readAgentRoleSlots();
  const sanitized = sanitizeSlot(slot);
  if (sanitized) slots[role] = sanitized;
  else delete slots[role];
  window.localStorage.setItem(
    APP_CONSTANTS.AGENT_CHAT_ROLE_SLOTS_KEY,
    JSON.stringify(slots),
  );
}
