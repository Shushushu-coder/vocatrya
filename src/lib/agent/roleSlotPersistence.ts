import { isAgentRole, type AgentRole } from "./agentRoles";
import {
  bindAgentSlotOwner,
  boundAgentSlotOwner,
  readActiveAgentRole,
  readAgentRoleSlots,
  readAgentSlotGeneration,
  readRawAgentSlotDocument,
  replaceVisibleAgentSlots,
  setAgentSlotWriteListener,
  writeAgentSlotGeneration,
  type StoredRoleSlot,
} from "./activeAgentRole";

export type DurableAgentSlots = {
  activeRole: AgentRole | null;
  slots: Partial<Record<AgentRole, StoredRoleSlot>>;
  generation: number;
};

export type AgentSlotWriteResult = "ok" | "stale" | "failed" | "skipped";
export type AgentSlotRestoreResult =
  | "applied"
  | "kept-local"
  | "absent"
  | "stale"
  | "unavailable";

let generation = 0;
let lastPublished = "";

export function currentAgentSlotGeneration(): number {
  return generation;
}

export function resetAgentSlotPersistenceForTests(): void {
  generation = 0;
  lastPublished = "";
  bindAgentSlotOwner(null);
  setAgentSlotWriteListener(null);
}

function bridge() {
  if (typeof window === "undefined") return null;
  return window.vocatryaAgentSlots ?? null;
}

function bodySerial(body: {
  activeRole: AgentRole | null;
  slots: Partial<Record<AgentRole, StoredRoleSlot>>;
}): string {
  return JSON.stringify({ activeRole: body.activeRole, slots: body.slots });
}

function currentBody(): {
  activeRole: AgentRole | null;
  slots: Partial<Record<AgentRole, StoredRoleSlot>>;
} {
  return { activeRole: readActiveAgentRole(), slots: readAgentRoleSlots() };
}

function parseDurable(raw: string): DurableAgentSlots | null {
  try {
    const value = JSON.parse(raw) as {
      generation?: unknown;
      activeRole?: unknown;
      slots?: unknown;
    };
    if (!Number.isInteger(value.generation) || Number(value.generation) < 1) return null;
    const activeRole = isAgentRole(value.activeRole) ? value.activeRole : null;
    if (typeof value.slots !== "object" || value.slots === null || Array.isArray(value.slots)) {
      return null;
    }
    return {
      generation: value.generation as number,
      activeRole,
      slots: value.slots as DurableAgentSlots["slots"],
    };
  } catch {
    return null;
  }
}

function remember(body: {
  activeRole: AgentRole | null;
  slots: Partial<Record<AgentRole, StoredRoleSlot>>;
}, nextGeneration: number) {
  generation = nextGeneration;
  writeAgentSlotGeneration(nextGeneration);
  lastPublished = bodySerial(body);
}

// Mirrors the visible slots for the bound user. A same-serial repeat is a
// no-op, so pagehide can flush safely without rewriting a newer snapshot.
// A rejected or failed write leaves both the in-memory slots and any older
// durable snapshot untouched.
export function publishAgentSlots(): AgentSlotWriteResult {
  const userId = boundAgentSlotOwner();
  const api = bridge();
  if (!userId || !api) return "skipped";
  const body = currentBody();
  const serial = bodySerial(body);
  if (serial === lastPublished) return "skipped";
  const nextGeneration = Math.max(generation, readAgentSlotGeneration()) + 1;
  try {
    const result = api.write(userId, JSON.stringify({ ...body, generation: nextGeneration }));
    if (result.ok) {
      remember(body, nextGeneration);
      return "ok";
    }
    return result.code === "stale" ? "stale" : "failed";
  } catch {
    return "failed";
  }
}

function readDurable(userId: string): { record: DurableAgentSlots | null; failed: boolean } {
  const api = bridge();
  if (!api) return { record: null, failed: false };
  try {
    const raw = api.read(userId);
    if (!raw) return { record: null, failed: false };
    const record = parseDurable(raw);
    return record ? { record, failed: false } : { record: null, failed: true };
  } catch {
    return { record: null, failed: true };
  }
}

function flushForeign(raw: ReturnType<typeof readRawAgentSlotDocument>): void {
  const api = bridge();
  if (!api || !raw.owner) return;
  try {
    api.write(
      raw.owner,
      JSON.stringify({
        activeRole: raw.activeRole,
        slots: raw.slots,
        generation: Math.max(raw.generation, 0) + 1,
      }),
    );
  } catch {
    // The other account's local copy stays in place when its own write fails.
  }
}

// Applies a durable snapshot only when this mount has not already changed
// role, session, or user. Same-origin localStorage still wins, including a
// legacy document with no owner stamp. An empty stored context is a clear.
export function restoreDurableAgentSlots(
  userId: string,
  atGeneration: number,
): AgentSlotRestoreResult {
  if (userId !== boundAgentSlotOwner() || atGeneration !== generation) return "stale";
  const durable = readDurable(userId);
  if (durable.failed) return "unavailable";
  if (userId !== boundAgentSlotOwner() || atGeneration !== generation) return "stale";

  const raw = readRawAgentSlotDocument();
  const foreign = raw.owner !== null && raw.owner !== userId;
  if (foreign) {
    flushForeign(raw);
    if (userId !== boundAgentSlotOwner() || atGeneration !== generation) return "stale";
    if (!durable.record) {
      replaceVisibleAgentSlots({ userId, activeRole: null, slots: {}, generation: 0 });
      lastPublished = bodySerial({ activeRole: null, slots: {} });
      return "absent";
    }
    replaceVisibleAgentSlots({ userId, ...durable.record });
    remember(
      { activeRole: durable.record.activeRole, slots: durable.record.slots },
      durable.record.generation,
    );
    return "applied";
  }

  const hasLocal = raw.activeRole !== null || Object.keys(raw.slots).length > 0;
  if (hasLocal) {
    generation = Math.max(generation, raw.generation, durable.record?.generation ?? 0);
    const body = currentBody();
    if (!durable.record) publishAgentSlots();
    else lastPublished = bodySerial(body);
    return "kept-local";
  }

  if (!durable.record) return "absent";
  replaceVisibleAgentSlots({ userId, ...durable.record });
  remember(
    { activeRole: durable.record.activeRole, slots: durable.record.slots },
    durable.record.generation,
  );
  return "applied";
}

export function installAgentSlotMirror(): void {
  setAgentSlotWriteListener(() => {
    publishAgentSlots();
  });
}
