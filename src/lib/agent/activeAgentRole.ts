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

type SlotMap = Partial<Record<AgentRole, StoredRoleSlot>>;

let boundOwner: string | null = null;
let writeListener: (() => void) | null = null;

export function bindAgentSlotOwner(userId: string | null): void {
  boundOwner = userId;
}

export function boundAgentSlotOwner(): string | null {
  return boundOwner;
}

export function setAgentSlotWriteListener(listener: (() => void) | null): void {
  writeListener = listener;
}

function notifySlotWrite(): void {
  try {
    writeListener?.();
  } catch {
    // The listener records durable failure. A throw must not roll back the
    // local slot the user already sees.
  }
}

export function readAgentSlotOwner(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(APP_CONSTANTS.AGENT_CHAT_SLOT_OWNER_KEY);
  return raw ? raw : null;
}

function slotsVisibleToBoundOwner(): boolean {
  if (!boundOwner) return true;
  const stamp = readAgentSlotOwner();
  if (!stamp) return true;
  return stamp === boundOwner;
}

function foreignOwner(): boolean {
  if (!boundOwner) return false;
  const stamp = readAgentSlotOwner();
  return Boolean(stamp) && stamp !== boundOwner;
}

function stampBoundOwner(): void {
  if (!boundOwner || typeof window === "undefined" || foreignOwner()) return;
  window.localStorage.setItem(APP_CONSTANTS.AGENT_CHAT_SLOT_OWNER_KEY, boundOwner);
}

export function readAgentSlotGeneration(): number {
  if (typeof window === "undefined") return 0;
  const raw = Number(
    window.localStorage.getItem(APP_CONSTANTS.AGENT_CHAT_SLOT_GENERATION_KEY),
  );
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

export function writeAgentSlotGeneration(generation: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    APP_CONSTANTS.AGENT_CHAT_SLOT_GENERATION_KEY,
    String(generation),
  );
}

export function readActiveAgentRole(): AgentRole | null {
  if (typeof window === "undefined" || !slotsVisibleToBoundOwner()) return null;
  const raw = window.localStorage.getItem(
    APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY,
  );
  return isAgentRole(raw) ? raw : null;
}

export function writeActiveAgentRole(role: AgentRole): void {
  if (typeof window === "undefined" || foreignOwner()) return;
  stampBoundOwner();
  window.localStorage.setItem(APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY, role);
}

export function notifyAgentSlotWrite(): void {
  notifySlotWrite();
}

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
  if (typeof window === "undefined" || !slotsVisibleToBoundOwner()) return {};
  return readStoredSlots();
}

function readStoredSlots(): SlotMap {
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
  if (typeof window === "undefined" || foreignOwner()) return;
  const slots = readAgentRoleSlots();
  const sanitized = sanitizeSlot(slot);
  if (sanitized) slots[role] = sanitized;
  else delete slots[role];
  stampBoundOwner();
  window.localStorage.setItem(
    APP_CONSTANTS.AGENT_CHAT_ROLE_SLOTS_KEY,
    JSON.stringify(slots),
  );
  notifySlotWrite();
}

export function readRawAgentSlotDocument(): {
  owner: string | null;
  activeRole: AgentRole | null;
  slots: SlotMap;
  generation: number;
} {
  if (typeof window === "undefined") {
    return { owner: null, activeRole: null, slots: {}, generation: 0 };
  }
  const role = window.localStorage.getItem(APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY);
  return {
    owner: readAgentSlotOwner(),
    activeRole: isAgentRole(role) ? role : null,
    slots: readStoredSlots(),
    generation: readAgentSlotGeneration(),
  };
}

export function replaceVisibleAgentSlots(input: {
  userId: string;
  activeRole: AgentRole | null;
  slots: SlotMap;
  generation: number;
}): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(APP_CONSTANTS.AGENT_CHAT_SLOT_OWNER_KEY, input.userId);
  if (input.activeRole) {
    window.localStorage.setItem(APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY, input.activeRole);
  } else {
    window.localStorage.removeItem(APP_CONSTANTS.AGENT_CHAT_ACTIVE_ROLE_KEY);
  }
  const slots: SlotMap = {};
  for (const role of ["insight", "pilot", "reflect"] as const) {
    const slot = sanitizeSlot(input.slots[role]);
    if (slot) slots[role] = slot;
  }
  window.localStorage.setItem(
    APP_CONSTANTS.AGENT_CHAT_ROLE_SLOTS_KEY,
    JSON.stringify(slots),
  );
  writeAgentSlotGeneration(input.generation);
}
