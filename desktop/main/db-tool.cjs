// Vocatrya desktop SQLite helper.
//
// Executed as `<bundled-node> db-tool.cjs <command> [args]` with a minimal
// controlled environment (DATABASE_URL only). It reuses the already-bundled
// Prisma query engine (no additional native SQLite dependency) to perform
// backup-critical SQL: VACUUM INTO, integrity checks, and read-only queries.
// Only invoked with statements constructed by desktop/main code; never with
// renderer or user input.
"use strict";

const path = require("node:path");

function fail(message) {
  // Sanitized: messages contain SQLite/Prisma diagnostics and local paths
  // only. The controlled environment carries no secrets, so there is nothing
  // secret to leak here.
  process.stderr.write(`db-tool failed: ${message}\n`);
  process.exit(1);
}

function serialize(value) {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "bigint") return entry.toString();
    if (Buffer.isBuffer(entry)) return entry.toString("base64");
    if (entry instanceof Uint8Array) return Buffer.from(entry).toString("base64");
    return entry;
  });
}

function quoteFileLiteral(filePath) {
  return `'${String(filePath).replaceAll("'", "''")}'`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is required");

  const [command, arg] = process.argv.slice(2);
  if (!command) fail("a command is required: vacuum-into | integrity | fk-check | query | exec");

  let PrismaClient;
  try {
    // Resolves from the assembled backend bundle (backend/node_modules) in
    // production, or from the repo node_modules during development/tests.
    // eslint-disable-next-line global-require, import/no-unresolved
    ({ PrismaClient } = require("@prisma/client"));
  } catch (error) {
    fail(`unable to load @prisma/client: ${error.message}`);
  }

  const client = new PrismaClient();
  try {
    if (command === "vacuum-into") {
      if (!arg) fail("vacuum-into requires a destination path");
      const destination = path.resolve(arg);
      await client.$executeRawUnsafe(`VACUUM INTO ${quoteFileLiteral(destination)};`);
      process.stdout.write(`${serialize({ ok: true })}\n`);
    } else if (command === "integrity") {
      const rows = await client.$queryRawUnsafe("PRAGMA integrity_check;");
      process.stdout.write(`${serialize({ ok: true, rows })}\n`);
    } else if (command === "fk-check") {
      const rows = await client.$queryRawUnsafe("PRAGMA foreign_key_check;");
      process.stdout.write(`${serialize({ ok: true, rows })}\n`);
    } else if (command === "query") {
      if (!arg) fail("query requires a SQL statement");
      const rows = await client.$queryRawUnsafe(arg);
      process.stdout.write(`${serialize({ ok: true, rows })}\n`);
    } else if (command === "exec") {
      if (!arg) fail("exec requires a SQL statement");
      const count = await client.$executeRawUnsafe(arg);
      process.stdout.write(`${serialize({ ok: true, count: Number(count) })}\n`);
    } else {
      fail(`unknown command: ${command}`);
    }
  } catch (error) {
    fail(error.message);
  } finally {
    await client.$disconnect();
  }
}

main();
