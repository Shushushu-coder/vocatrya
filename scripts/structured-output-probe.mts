// Structured-output validation probe — development harness for
// VOCATRYA_CROSS_RUNTIME_STRUCTURED_OUTPUT_VALIDATION.
//
// Runs the 9-trial synthetic corpus (3 schemas × 3 fixtures) against an
// existing CONNECTED managed AIConnection through the REAL desktop
// execution boundary: ticket → connection-service.executeText → adapter
// invocation in a fresh Vocatrya-owned temp cwd → assistant text →
// parse → schema validate → at most one retry.
//
// This is NOT a production path: the backend loopback hop is replaced by
// an in-process ticket stub that resolves only real AIConnection rows
// from the database — every other security invariant (managed profile,
// env isolation, shell:false, no user files) is exercised unchanged.
//
// Usage:
//   node --experimental-sqlite --experimental-strip-types \
//     scripts/structured-output-probe.mts \
//       --db .codex-tmp/desktop-poc/data/desktop-poc.db \
//       --profiles-root .codex-tmp/desktop-poc/runtime-profiles \
//       [--connection <id> | --all] [--model <modelId>] \
//       [--exec-root .codex-tmp/structured-probe] [--timeout-ms 120000]
//
// Exit code 0 when the suite ran; 2 when no CONNECTED connection was
// found (PENDING_MANAGED_AUTH for every runtime); 1 on harness misuse.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  runStructuredValidationSuite,
  type StructuredExecuteFn,
  type StructuredExecuteOutcome,
} from "../src/lib/ai/structured-output.ts";
import { STRUCTURED_VALIDATION_TRIALS } from "../src/lib/ai/structured-validation-fixtures.ts";

const require = createRequire(import.meta.url);
const { createConnectionService } = require(
  "../desktop/main/runtime/connection-service.js",
);
const { getAccountRuntimeCapabilities } = require(
  "../desktop/main/runtime/capabilities.js",
);

interface ConnectionRow {
  id: string;
  provider: string;
  backendKind: string;
  status: string;
  runtimeProfileRef: string | null;
  accountIdentity: string | null;
}

interface CliArgs {
  db?: string;
  profilesRoot?: string;
  connection?: string;
  all?: boolean;
  model?: string;
  execRoot?: string;
  timeoutMs?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--all") {
      args.all = true;
      continue;
    }
    const value = argv[++i];
    switch (key) {
      case "--db":
        args.db = value;
        break;
      case "--profiles-root":
        args.profilesRoot = value;
        break;
      case "--connection":
        args.connection = value;
        break;
      case "--model":
        args.model = value;
        break;
      case "--exec-root":
        args.execRoot = value;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(value);
        break;
      default:
        throw new Error(`unknown argument: ${key}`);
    }
  }
  return args;
}

function loadConnections(dbPath: string): ConnectionRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, provider, backendKind, status, runtimeProfileRef, " +
          "accountIdentity FROM AIConnection WHERE archivedAt IS NULL",
      )
      .all() as unknown as ConnectionRow[];
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.profilesRoot) {
    process.stderr.write(
      "usage: structured-output-probe --db <sqlite> --profiles-root <dir> " +
        "[--connection <id> | --all] [--model <id>] [--exec-root <dir>] " +
        "[--timeout-ms <n>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const profilesRoot = path.resolve(args.profilesRoot);
  const execRoot = path.resolve(args.execRoot ?? ".codex-tmp/structured-probe");
  fs.mkdirSync(execRoot, { recursive: true });

  const connections = loadConnections(path.resolve(args.db));
  const targets = connections.filter((conn) => {
    if (conn.status !== "CONNECTED") return false;
    if (!conn.runtimeProfileRef) return false;
    if (args.connection) return conn.id === args.connection;
    if (args.all) return true;
    return false;
  });

  if (targets.length === 0) {
    // PENDING_MANAGED_AUTH — not a failure of the harness.
    const pending = connections.map((c) => ({
      connectionId: c.id,
      backendKind: c.backendKind,
      status: c.status,
      eligibility: "PENDING_MANAGED_AUTH",
    }));
    process.stdout.write(
      JSON.stringify({ status: "PENDING_MANAGED_AUTH", connections: pending }, null, 2) +
        "\n",
    );
    process.exitCode = 2;
    return;
  }

  // In-process ticket stub: `probe:<connectionId>` resolves to the real
  // AIConnection row — the same shape the backend's internal resolve route
  // returns. completeOperation is a no-op hygiene callback.
  const db = new DatabaseSync(path.resolve(args.db), { readOnly: true });
  const backend = {
    async resolveTicket(ticket: string) {
      const id = ticket.startsWith("probe:") ? ticket.slice(6) : "";
      const conn = db
        .prepare(
          "SELECT id, provider, backendKind, status, runtimeProfileRef, " +
            "accountIdentity FROM AIConnection WHERE id = ? AND archivedAt IS NULL",
        )
        .get(id) as ConnectionRow | undefined;
      if (!conn) return { ok: false, code: "INVALID_TICKET" };
      return {
        ok: true,
        operationId: `probe_${randomUUID()}`,
        operation: "executeText",
        backendKind: conn.backendKind,
        connection: conn,
      };
    },
    async completeOperation() {
      return { ok: true };
    },
  };

  const service = createConnectionService({
    profilesRoot,
    smokeWorkRoot: execRoot,
    execWorkRoot: execRoot,
    backend,
  });

  const reports: unknown[] = [];
  for (const conn of targets) {
    const capabilities = getAccountRuntimeCapabilities(conn.backendKind);
    const execute: StructuredExecuteFn = async ({
      prompt,
      schema,
      schemaName,
      signal,
    }): Promise<StructuredExecuteOutcome> => {
      const result = await service.executeText({
        ticket: `probe:${conn.id}`,
        connectionId: conn.id,
        model: args.model ?? "",
        prompt,
        structuredOutput: { schema, schemaName },
        // The probe is the verification harness itself — it must exercise
        // PENDING runtimes. This flag is in-process only: the internal HTTP
        // endpoint never forwards it, so business calls always run the
        // verification gate.
        verificationProbe: true,
        timeoutMs: args.timeoutMs ?? 120_000,
        signal,
      });
      if (!result.ok) {
        return { ok: false, code: result.code ?? "INFERENCE_FAILED" };
      }
      return {
        ok: true,
        text: result.text,
        structuredStrategy: result.structuredStrategy ?? null,
        stopReason: result.stopReason ?? null,
        durationMs: result.durationMs,
      };
    };

    const suite = await runStructuredValidationSuite({
      trials: STRUCTURED_VALIDATION_TRIALS,
      execute,
    });
    reports.push({
      connectionId: conn.id,
      backendKind: conn.backendKind,
      provider: conn.provider,
      model: args.model ?? "(runtime default)",
      declaredStrategy: capabilities?.structuredOutput?.strategy ?? null,
      trials: suite.trials.map((trial) => ({
        fixtureId: trial.fixtureId,
        schemaId: trial.schemaId,
        status: trial.status,
        attempts: trial.attempts.map((a) => ({
          kind: a.kind,
          outcome: a.outcome,
          structuredStrategy: a.structuredStrategy,
          issueCount: a.issues.length,
          durationMs: a.durationMs,
        })),
        firstPassValid: trial.firstPassValid,
        retried: trial.retried,
        validAfterRetry: trial.validAfterRetry,
        nativeViolation: trial.nativeViolation,
        issueSummary: trial.issueSummary,
      })),
      totals: suite.totals,
    });
  }

  process.stdout.write(JSON.stringify({ reports }, null, 2) + "\n");
  db.close();
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
