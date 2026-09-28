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
 * Storage lives on globalThis, not module scope: the Next.js standalone
 * server compiles each route/page entry into its own webpack bundle, and a
 * module-level Map would be duplicated per bundle — a ticket minted by the
 * settings page's server action would be invisible to the /resolve route.
 * A process-wide singleton keyed on globalThis survives that bundling
 * (same technique as the Prisma client singleton in src/lib/db.ts). The
 * desktop backend is a single-process local server, so in-memory state is
 * sufficient and nothing needs a schema change.
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
  /**
   * Account provider the login must authenticate for (server-validated at
   * mint time against the runtime's supported-provider matrix). Null only
   * for connection-scoped operations, where the connection row carries it.
   */
  accountProvider: string | null;
  connectionId: string | null;
  expiresAt: number;
  /** Set once the ticket has been redeemed via resolve. */
  resolved: boolean;
}

interface ConnectionTicketStore {
  tickets: Map<string, ConnectionTicketRecord>;
  ticketByOperationId: Map<string, string>;
}

// Symbol.for pins one store per process across every webpack bundle that
// loads this module — bundle-private module state was the root cause of
// the "session expired" failure on every ACCOUNT_LOGIN connect.
const TICKET_STORE_KEY = Symbol.for("vocatrya.aiConnectionTickets.v1");

function ticketStore(): ConnectionTicketStore {
  const globalScope = globalThis as unknown as Record<
    symbol,
    ConnectionTicketStore | undefined
  >;
  let store = globalScope[TICKET_STORE_KEY];
  if (!store) {
    store = {
      tickets: new Map<string, ConnectionTicketRecord>(),
      ticketByOperationId: new Map<string, string>(),
    };
    globalScope[TICKET_STORE_KEY] = store;
  }
  return store;
}

function sweepExpired(store: ConnectionTicketStore, now: number): void {
  for (const [ticket, record] of store.tickets) {
    if (record.expiresAt <= now) {
      store.tickets.delete(ticket);
      store.ticketByOperationId.delete(record.operationId);
    }
  }
}

export function mintConnectionTicket(input: {
  userId: string;
  operation: AIConnectionOperation;
  backendKind: string;
  accountProvider?: string | null;
  connectionId?: string | null;
  now?: number;
}): ConnectionTicketRecord {
  const now = input.now ?? Date.now();
  const store = ticketStore();
  sweepExpired(store, now);
  const record: ConnectionTicketRecord = {
    ticket: randomBytes(24).toString("base64url"),
    operationId: `op_${randomUUID()}`,
    userId: input.userId,
    operation: input.operation,
    backendKind: input.backendKind,
    accountProvider: input.accountProvider ?? null,
    connectionId: input.connectionId ?? null,
    expiresAt: now + CONNECTION_TICKET_TTL_MS,
    resolved: false,
  };
  store.tickets.set(record.ticket, record);
  store.ticketByOperationId.set(record.operationId, record.ticket);
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
  const store = ticketStore();
  sweepExpired(store, at);
  const record = store.tickets.get(ticket);
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
  const store = ticketStore();
  sweepExpired(store, at);
  const ticket = store.ticketByOperationId.get(operationId);
  if (!ticket) return null;
  const record = store.tickets.get(ticket);
  store.tickets.delete(ticket);
  store.ticketByOperationId.delete(operationId);
  return record ?? null;
}

/** Test hook — clears all outstanding tickets. */
export function resetConnectionTickets(): void {
  const store = ticketStore();
  store.tickets.clear();
  store.ticketByOperationId.clear();
}
