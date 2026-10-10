import "server-only";
import prisma from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { HostedManagedClient } from "./managed-client";
import { classifyAIConnection, AIBusinessError } from "./connections";
import { managedBusinessError } from "./managed-dispatch";

/** Internal system primitive. Public AIConnection CRUD remains account-only. */
export async function ensureManagedConnectionForLocalUser(userId: string, client = new HostedManagedClient(), db: Pick<PrismaClient, "aIConnection"> = prisma) {
  try {
    await client.identity(userId); // Hosted authority; local User.id is never an authentication claim.
    const where = { userId, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", archivedAt: null };
    let connection = await db.aIConnection.findFirst({ where });
    if (!connection) {
      try { connection = await db.aIConnection.create({ data: { ...where, displayName: "Vocatrya Managed AI", status: "CONNECTED", credentialRef: null, runtimeProfileRef: null, accountIdentity: null } }); }
      catch (error) { connection = await db.aIConnection.findFirst({ where }); if (!connection) throw error; }
    }
    if (classifyAIConnection(connection) !== "MANAGED") throw new AIBusinessError("MANAGED_BINDING_UNAVAILABLE", "Invalid Managed connection");
    return await db.aIConnection.update({ where: { id: connection.id }, data: { status: "CONNECTED", lastVerifiedAt: new Date() } });
  } catch (error) { throw managedBusinessError(error); }
}

/**
 * Canonical server-side Managed bootstrap (M4). Product surfaces call this
 * when they need the user's Managed source to exist — e.g. an
 * assignManagedBusinessSource flow or a managed-capable preflight. The
 * connection is system-provisioned; it never appears in account CRUD.
 */
export async function bootstrapManagedAiForUser(
  userId: string,
  client: HostedManagedClient = new HostedManagedClient(),
  db: Pick<PrismaClient, "aIConnection"> = prisma,
): Promise<{ connectionId: string; displayName: string; status: string }> {
  const connection = await ensureManagedConnectionForLocalUser(userId, client, db);
  return {
    connectionId: connection.id,
    displayName: connection.displayName,
    status: connection.status,
  };
}
