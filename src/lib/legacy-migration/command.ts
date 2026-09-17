import fs from "node:fs";
import path from "node:path";
import { runPhase2DryRun } from "./phase2Auditor";
import { runLegacyMigration, renderPhase3Markdown } from "./migrator";
import { PHASE3_MIGRATION_VERSION } from "./identities";
import type { MigrationMode, Phase3Report, RunMigrateOptions } from "./types";

export type ParsedLegacyMigrationArgs = {
  command: MigrationMode;
  dbPath?: string;
  confirmWritable: boolean;
  allowDisposableCopy: boolean;
  forceRequested: boolean;
  outputDir?: string;
};

export function parseLegacyMigrationArgs(
  argv: string[],
): ParsedLegacyMigrationArgs {
  const tokens = [...argv];
  let command: MigrationMode = "audit";
  if (tokens[0] === "audit" || tokens[0] === "plan" || tokens[0] === "migrate") {
    command = tokens.shift() as MigrationMode;
  }

  let dbPath: string | undefined;
  let outputDir: string | undefined;
  let confirmWritable = false;
  let allowDisposableCopy = false;
  let forceRequested = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--confirm-writable") {
      confirmWritable = true;
      continue;
    }
    if (token === "--allow-disposable-copy") {
      allowDisposableCopy = true;
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
      continue;
    }
    if (token === "--output") {
      outputDir = tokens[i + 1];
      i += 1;
      continue;
    }
  }

  return {
    command,
    dbPath,
    confirmWritable,
    allowDisposableCopy,
    forceRequested,
    outputDir,
  };
}

export type CommandResult = {
  exitCode: number;
  stdout: string;
  report: Phase3Report | null;
  writesAttempted: boolean;
};

export async function executeLegacyMigrationCommand(options: {
  argv: string[];
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const parsed = parseLegacyMigrationArgs(options.argv);
  const env = options.env ?? process.env;

  if (parsed.command === "audit") {
    const report = runPhase2DryRun({
      repoRoot: options.repoRoot,
      env,
      disposableDbPath: parsed.dbPath,
      outputDir: parsed.outputDir,
    });
    const stdout = [
      `command=audit`,
      `writesAttempted=false`,
      `PHASE2_AUDIT_STATUS=${report.acceptance.PHASE2_AUDIT_STATUS}`,
      `REAL_DATABASE_WRITE_OPERATIONS=0`,
      "",
    ].join("\n");
    return {
      exitCode: report.acceptance.PHASE2_AUDIT_STATUS === "BLOCKED" ? 1 : 0,
      stdout,
      report: null,
      writesAttempted: false,
    };
  }

  const dbPath = parsed.dbPath;
  if (!dbPath) {
    return {
      exitCode: 2,
      stdout:
        "plan/migrate require --db <sqlite-path>. Default audit command performs zero writes.\n",
      report: null,
      writesAttempted: false,
    };
  }

  const runOptions: RunMigrateOptions = {
    dbPath,
    repoRoot: options.repoRoot,
    mode: parsed.command,
    confirmWritable: parsed.confirmWritable,
    allowDisposableCopy: parsed.allowDisposableCopy,
    forceRequested: parsed.forceRequested,
    env,
    outputDir: parsed.outputDir,
  };

  const phase3 = await runLegacyMigration(runOptions);
  if (parsed.outputDir) {
    fs.mkdirSync(parsed.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(parsed.outputDir, "phase3-report.json"),
      `${JSON.stringify(phase3, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(parsed.outputDir, "PHASE3_REPORT.md"),
      renderPhase3Markdown(phase3),
      "utf8",
    );
  }

  const stdout = [
    `command=${parsed.command}`,
    `migrationVersion=${PHASE3_MIGRATION_VERSION}`,
    `phaseResult=${phase3.phaseResult}`,
    `writeCount=${phase3.writeCount}`,
    `runId=${phase3.runId ?? "(none)"}`,
    `REAL_USER_DATA_MUTATED=${phase3.REAL_USER_DATA_MUTATED}`,
    `PRODUCTION_BACKFILL_EXECUTED=${phase3.PRODUCTION_BACKFILL_EXECUTED}`,
    "",
  ].join("\n");

  const exitCode = phase3.phaseResult === "PASS" ? 0 : 1;
  return {
    exitCode,
    stdout,
    report: phase3,
    writesAttempted: parsed.command === "migrate",
  };
}
