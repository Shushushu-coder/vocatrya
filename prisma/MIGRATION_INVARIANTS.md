# Required raw migration invariants

Generate schema changes with `npx prisma migrate dev --create-only` and inspect
all generated SQL before deploying with `npx prisma migrate deploy`.
After deploy, run `npm run db:verify-migration-invariants` against the same
DATABASE_URL. This read-only gate fails on a missing or modified constraint;
it does not repair the database or replace database uniqueness with app logic.

Prisma cannot represent the active Managed partial unique index in its schema
DSL. Every migration that rebuilds AIConnection (RedefineTables / DROP + RENAME)
must explicitly recreate it after renaming the replacement table:

```sql
CREATE UNIQUE INDEX "AIConnection_userId_active_managed_key"
ON "AIConnection"("userId")
WHERE "provider" = 'VOCATRYA' AND "backendKind" = 'MANAGED_GATEWAY'
  AND "authType" = 'MANAGED' AND "archivedAt" IS NULL;
```

Keep one active Managed connection per user; archived replacements remain
allowed. Do not replace this with unconditional historical uniqueness.

`npm test` runs the full-chain gate plus a representative later table-rebuild
fixture and real P2002 constraint checks. The manual migration-verification CI
job runs the same spec. A future generated rebuild that omits the raw index
fails the full-chain gate even if the representative fixture still passes.
