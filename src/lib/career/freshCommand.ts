import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import { activateFreshAbNative } from "./freshActivation";
import { checkFreshAbEligibility } from "./freshEligibility";

export type ParsedFreshInitArgs = {
  confirm: boolean;
  forceRequested: boolean;
  dbPath?: string;
};

export function parseFreshInitArgs(argv: string[]): ParsedFreshInitArgs {
  const tokens = [...argv];
  let confirm = false;
  let forceRequested = false;
  let dbPath: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--confirm") {
      confirm = true;
      continue;
    }
    if (token === "--force" || token.startsWith("--force=")) {
      forceRequested = true;
      continue;
    }
    if (token === "--db" || token === "--database") {
      dbPath = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--db=")) {
      dbPath = token.slice("--db=".length);
    }
  }

  return { confirm, forceRequested, dbPath };
}

export function resolveFreshInitDbPath(
  repoRoot: string,
  parsed: ParsedFreshInitArgs,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (parsed.dbPath) {
    return path.resolve(parsed.dbPath);
  }
  const url = env.DATABASE_URL?.trim() ?? "";
  if (url.startsWith("file:")) {
    const filePath = url.slice("file:".length).replace(/^\/*/, "");
    return path.resolve(filePath);
  }
  return path.resolve(repoRoot, "prisma", "dev.db");
}

function assertSafeDevDb(
  repoRoot: string,
  dbPath: string,
  confirm: boolean,
): void {
  const base = path.basename(dbPath).toLowerCase();
  if (base === "smoke-i18n.db" || base.includes("smoke")) {
    throw new CareerRuntimeError(
      "FRESH_DB_REFUSED",
      `Refusing to touch ${dbPath}`,
    );
  }
  if (
    confirm &&
    path.resolve(dbPath).toLowerCase() !==
      path.resolve(repoRoot, "prisma", "dev.db").toLowerCase()
  ) {
    throw new CareerRuntimeError(
      "FRESH_DB_REFUSED",
      `Fresh activation may only mutate ${path.resolve(repoRoot, "prisma", "dev.db")}`,
    );
  }
}

export type FreshCommandResult = {
  exitCode: number;
  stdout: string;
  writesAttempted: boolean;
};

export async function executeFreshInitCommand(options: {
  argv: string[];
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<FreshCommandResult> {
  const parsed = parseFreshInitArgs(options.argv);
  const env = options.env ?? process.env;

  if (parsed.forceRequested) {
    return {
      exitCode: 2,
      stdout: "ab:init-fresh does not accept --force.\n",
      writesAttempted: false,
    };
  }

  const dbPath = resolveFreshInitDbPath(options.repoRoot, parsed, env);
  try {
    assertSafeDevDb(options.repoRoot, dbPath, parsed.confirm);
  } catch (error) {
    return {
      exitCode: 2,
      stdout: `${error instanceof Error ? error.message : "database refused"}\n`,
      writesAttempted: false,
    };
  }

  if (!fs.existsSync(dbPath)) {
    return {
      exitCode: 2,
      stdout: `database not found: ${dbPath}\n`,
      writesAttempted: false,
    };
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbPath.replace(/\\/g, "/")}` } },
  });

  try {
    const eligibility = await checkFreshAbEligibility(prisma);
    const lines = [
      `command=${parsed.confirm ? "init" : "check"}`,
      `dbPath=${dbPath}`,
      `eligible=${eligibility.eligible}`,
      `alreadyFreshReady=${eligibility.alreadyFreshReady}`,
      `blockers=${eligibility.blockers.join("|") || "none"}`,
      `legacyDomain=${JSON.stringify(eligibility.legacyDomainRowCounts)}`,
      `abDomain=${JSON.stringify(eligibility.abDomainRowCounts)}`,
      `bookkeeping=${JSON.stringify(eligibility.migrationBookkeepingCounts)}`,
    ];

    if (!parsed.confirm) {
      lines.push("writesAttempted=false");
      lines.push("hint=pass --confirm to initialize FRESH_READY");
      return {
        exitCode: eligibility.eligible ? 0 : 1,
        stdout: `${lines.join("\n")}\n`,
        writesAttempted: false,
      };
    }

    const result = await activateFreshAbNative(prisma);
    lines.push(`created=${result.created}`);
    lines.push(`status=${result.status}`);
    lines.push(`idempotent=${result.idempotent}`);
    lines.push("writesAttempted=true");
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      writesAttempted: true,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "fresh activation failed";
    return {
      exitCode: 1,
      stdout: `command=init\nerror=${message}\n`,
      writesAttempted: parsed.confirm,
    };
  } finally {
    await prisma.$disconnect();
  }
}
