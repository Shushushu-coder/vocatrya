/** Raw SQLite constraints are migration invariants, outside Prisma's DSL.
 * Read-only gate: migrations must restore them explicitly; never auto-repair.
 * @param {import("@prisma/client").PrismaClient} db
 */
export async function assertRequiredMigrationInvariants(db) {
  const name = "AIConnection_userId_active_managed_key";
  const rows = await db.$queryRawUnsafe(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'AIConnection' AND name = ?", name,
  );
  // SQLite string predicates are case-sensitive; normalize SQL syntax only.
  const normalize = (sql) => sql.split(/('[^']*')/).map((part) =>
    part.startsWith("'") ? part : part.replace(/["`\[\]\s;]/g, "").toLowerCase(),
  ).join("");
  const expected = "CREATE UNIQUE INDEX AIConnection_userId_active_managed_key ON AIConnection(userId) WHERE provider = 'VOCATRYA' AND backendKind = 'MANAGED_GATEWAY' AND authType = 'MANAGED' AND archivedAt IS NULL";
  if (rows.length !== 1 || normalize(rows[0].sql) !== normalize(expected)) {
    throw new Error(`Required raw migration invariant missing or changed: ${name}. Restore it explicitly after AIConnection rebuilds.`);
  }
}
