/**
 * Phase D connection operation tickets — the ownership-proof seam between
 * the authenticated renderer session and the Electron main process.
 *
 * Flow: an authed server action mints a single-use ticket bound to
 * {userId, operation, backendKind, connectionId?}. The renderer hands the
 * ticket to Electron main over IPC; main redeems it through the internal
 * loopback API (`resolve`), performs the runtime operation, then reports
 * the outcome (`complete`, keyed by operationId). Tickets expire quickly
 * and are consumed at most once at each step.
 *
 * Storage is a module-level Map: the desktop backend is a single-process
 * local server, so in-memory state is sufficient and nothing needs a
 * schema change.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AIConnectionOperation } from "@/lib/ai/connections";

export const CONNECTION_TICKET_TTL_MS = 10 * 60 * 1000;

export interface ConnectionTicketRecord {
  /** Secret value the renderer passes to Electron main. */
  ticket: string;
  /** Server-side handle the runtime reports completion against. */
  operationId: string;
  userId: string;
  operation: AIConnectionOperation;
  backendKind: string;
  connectionId: string | null;
  expiresAt: number;
  /** Set once the ticket has been redeemed via resolve. */
  resolved: boolean;
}

const tickets = new Map<string, ConnectionTicketRecord>();
const ticketByOperationId = new Map<string, string>();

function sweepExpired(now: number): void {
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) {
      tickets.delete(ticket);
      ticketByOperationId.delete(record.operationId);
    }
  }
}

export function mintConnectionTicket(input: {
  userId: string;
  operation: AIConnectionOperation;
  backendKind: string;
  connectionId?: string | null;
  now?: number;
}): ConnectionTicketRecord {
  const now = input.now ?? Date.now();
  sweepExpired(now);
  const record: ConnectionTicketRecord = {
    ticket: randomBytes(24).toString("base64url"),
    operationId: `op_${randomUUID()}`,
    userId: input.userId,
    operation: input.operation,
    backendKind: input.backendKind,
    connectionId: input.connectionId ?? null,
    expiresAt: now + CONNECTION_TICKET_TTL_MS,
    resolved: false,
  };
  tickets.set(record.ticket, record);
  ticketByOperationId.set(record.operationId, record.ticket);
  return record;
}

/**
 * Redeems a ticket: must exist, be unexpired, and not yet resolved. Marks
 * the record resolved so the same ticket cannot be replayed.
 */
export function resolveConnectionTicket(
  ticket: string,
  { now }: { now?: number } = {},
): ConnectionTicketRecord | null {
  const at = now ?? Date.now();
  sweepExpired(at);
  const record = tickets.get(ticket);
  if (!record || record.resolved || record.expiresAt <= at) return null;
  record.resolved = true;
  return record;
}

/**
 * Consumes a resolved ticket by operationId. Returns the record exactly
 * once; afterwards the operation is fully spent.
 */
export function completeConnectionOperation(
  operationId: string,
  { now }: { now?: number } = {},
): ConnectionTicketRecord | null {
  const at = now ?? Date.now();
  sweepExpired(at);
  const ticket = ticketByOperationId.get(operationId);
  if (!ticket) return null;
  const record = tickets.get(ticket);
  tickets.delete(ticket);
  ticketByOperationId.delete(operationId);
  return record ?? null;
}

/** Test hook — clears all outstanding tickets. */
export function resetConnectionTickets(): void {
  tickets.clear();
  ticketByOperationId.clear();
}
