import { PrismaClient } from "@prisma/client";
import {
  ensureFreshNativeState,
  freshNativeActivationLogLine,
  type FreshNativeBootstrapOutcome,
} from "./freshBootstrap";

export type FreshNativeStartupLog = (line: string) => void;

/**
 * Trusted startup wrapper around ensureFreshNativeState.
 *
 * The database is the one this process already resolved. Pass an open
 * client, or omit it and Prisma uses the process DATABASE_URL. This
 * function does not accept a filesystem path and is not an IPC surface.
 *
 * npm run dev and next start do not migrate, and they do not call this.
 * Desktop prepareDatabase and the Docker entrypoint call it only after
 * prisma migrate deploy succeeds.
 */
export async function ensureFreshNativeStateForActiveDatabase(options?: {
  db?: PrismaClient;
  log?: FreshNativeStartupLog;
}): Promise<FreshNativeBootstrapOutcome> {
  const log: FreshNativeStartupLog =
    options?.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const ownsClient = options?.db == null;
  const db = options?.db ?? new PrismaClient();
  try {
    const outcome = await ensureFreshNativeState(db);
    log(freshNativeActivationLogLine(outcome.result));
    return outcome;
  } catch (error) {
    log("fresh-native activation: failed");
    throw error;
  } finally {
    if (ownsClient) {
      await db.$disconnect();
    }
  }
}
