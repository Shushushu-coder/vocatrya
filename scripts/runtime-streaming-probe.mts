// Runtime streaming validation probe — development harness for
// VOCATRYA_ACCOUNT_RUNTIME_STREAMING_VALIDATION.
//
// Runs the synthetic probe corpus (P1 short / P2 long / P3 unicode /
// P4 abort) against existing CONNECTED managed AIConnection rows through
// the REAL desktop execution boundary: ticket → connection-service
// .executeTextStream → adapter streaming invocation in a fresh
// Vocatrya-owned temp cwd → normalized {text-delta|completed|error}
// events with arrival offsets.
//
// This is NOT a production path: the backend loopback hop is replaced by
// an in-process ticket stub that resolves only real AIConnection rows —
// every other security invariant (managed profile, env isolation,
// shell:false, no user files) is exercised unchanged.
//
// Usage:
//   node --experimental-sqlite --experimental-strip-types \
//     scripts/runtime-streaming-probe.mts \
//       --db .codex-tmp/desktop-poc/data/desktop-poc.db \
//       --profiles-root .codex-tmp/desktop-poc/runtime-profiles \
//       [--connection <id> | --all] [--model <modelId>] \
//       [--exec-root .codex-tmp/streaming-probe] [--timeout-ms 180000]
//
// Exit code 0 when the suite ran; 2 when no CONNECTED connection was
// found (PENDING_MANAGED_AUTH for every runtime); 1 on harness misuse.
//
// Logging discipline (spec §29): reports carry counts/offsets/durations
// only — never prompt text, response text, account identity, profile
// paths, or credential material.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { createConnectionService } = require(
  "../desktop/main/runtime/connection-service.js",
);
const { getAccountRuntimeCapabilities } = require(
  "../desktop/main/runtime/capabilities.js",
);

// ---------------------------------------------------------------------------
// Synthetic probe corpus (spec §15/§16) — no Career Dialogue / Resume / JD
// data; prompts ask for plain assistant text only (never tool use, never
// chain-of-thought).
// ---------------------------------------------------------------------------
const PROBES = [
  {
    id: "P1_SHORT",
    prompt:
      "用简体中文列出6个短句，每句不超过10个字，主题：清晨的城市。只输出这6行，不要标题或解释。",
    expectLines: [4, 10],
  },
  {
    id: "P2_LONG",
    prompt:
      "请用简体中文写一篇约1000字的短文，介绍城市公共交通的发展历史。只输出正文段落，不要标题、列表或代码块。",
    minChars: 600,
  },
  {
    id: "P3_UNICODE",
    prompt:
      "逐行输出以下内容，不要任何解释：第一行中文“数据流验证”，第二行 ASCII 'stream OK 123'，第三行数字 9876543210，第四行标点 !@#￥%……&*()_+-=[]，第五行中日混合「テスト与测试」。",
  },
];

const P4_ABORT = {
  id: "P4_ABORT",
  prompt:
    "请用简体中文写一篇约2000字的长文，详细介绍世界铁路的发展历史。只输出正文，不要标题。",
};

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

// Summarize a streaming run for the report — counts and offsets only.
function summarizeStream(result: any) {
  const s = result?.stream ?? {};
  return {
    mechanism: s.mechanism ?? null,
    eventCount: s.eventCount ?? 0,
    deltaCount: s.deltaCount ?? 0,
    deltaChunkCount: s.deltaChunkCount ?? 0,
    totalDeltaChars: s.totalDeltaChars ?? 0,
    firstDeltaOffsetMs: s.firstDeltaOffsetMs ?? null,
    lastDeltaOffsetMs: s.lastDeltaOffsetMs ?? null,
    completedOffsetMs: s.completedOffsetMs ?? null,
    vendorEventCount: s.vendorEventCount ?? null,
    malformedLineCount: s.malformedLineCount ?? null,
    ignoredLineCount: s.ignoredLineCount ?? null,
    reconstruction: s.reconstruction ?? null,
    aborted: s.aborted === true,
  };
}

async function runProbe(
  service: any,
  conn: ConnectionRow,
  probe: any,
  model: string | undefined,
  timeoutMs: number,
) {
  const deltas: number[] = [];
  const events: string[] = [];
  const result = await service.executeTextStream({
    ticket: `probe:${conn.id}`,
    connectionId: conn.id,
    model,
    prompt: probe.prompt,
    verificationProbe: true,
    timeoutMs,
    onEvent: (event: any) => {
      events.push(event.type);
      if (event.type === "text-delta") deltas.push(event.delta?.length ?? 0);
    },
  });
  return { result, events, deltas };
}

async function runAbortProbe(
  service: any,
  conn: ConnectionRow,
  model: string | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const events: string[] = [];
  let abortedAtFirstDelta = false;
  let deltasAfterAbort = 0;
  const result = await service.executeTextStream({
    ticket: `probe:${conn.id}`,
    connectionId: conn.id,
    model,
    prompt: P4_ABORT.prompt,
    verificationProbe: true,
    timeoutMs,
    signal: controller.signal,
    onEvent: (event: any) => {
      if (controller.signal.aborted && event.type === "text-delta") {
        deltasAfterAbort += 1;
      }
      events.push(event.type);
      if (event.type === "text-delta" && !abortedAtFirstDelta) {
        abortedAtFirstDelta = true;
        controller.abort();
      }
    },
  });
  return { result, events, abortedAtFirstDelta, deltasAfterAbort };
}

// Per-runtime verdict (spec §18/§19): PASS only when every normal probe
// reconstructed deterministically, P2 showed >=2 deltas across >=2 stdout
// deliveries before completion, and the abort probe terminated cleanly.
function verdict(probeResults: any[], abortResult: any) {
  const failures: string[] = [];
  for (const { probe, outcome } of probeResults) {
    if (!outcome.result?.ok) {
      failures.push(`${probe.id}:${outcome.result?.code ?? "FAILED"}`);
      continue;
    }
    const s = outcome.result.stream ?? {};
    if (!["MATCH", "MATCH_TRIMMED", "DELTA_ONLY"].includes(s.reconstruction)) {
      failures.push(`${probe.id}:RECONSTRUCTION_${s.reconstruction}`);
    }
    if (probe.id === "P2_LONG") {
      if ((s.deltaCount ?? 0) < 2) failures.push("P2:NO_REAL_TEXT_DELTA");
      if ((s.deltaChunkCount ?? 0) < 2) {
        failures.push("P2:SINGLE_DELIVERY_NO_INCREMENTAL");
      }
      if (
        s.firstDeltaOffsetMs == null ||
        s.completedOffsetMs == null ||
        s.firstDeltaOffsetMs >= s.completedOffsetMs
      ) {
        failures.push("P2:DELTA_NOT_BEFORE_COMPLETION");
      }
    }
  }
  if (!abortResult.abortedAtFirstDelta) {
    failures.push("P4:NO_DELTA_TO_ABORT");
  } else {
    if (abortResult.result?.code !== "ABORTED") {
      failures.push(`P4:ABORT_${abortResult.result?.code ?? "FAILED"}`);
    }
    if (abortResult.deltasAfterAbort > 0) {
      failures.push("P4:LATE_DELTAS_AFTER_ABORT");
    }
  }
  return failures.length === 0
    ? { status: "PASS" }
    : { status: "FAIL", failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.profilesRoot) {
    process.stderr.write(
      "usage: runtime-streaming-probe --db <sqlite> --profiles-root <dir> " +
        "[--connection <id> | --all] [--model <id>] [--exec-root <dir>] " +
        "[--timeout-ms <n>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const profilesRoot = path.resolve(args.profilesRoot);
  const execRoot = path.resolve(args.execRoot ?? ".codex-tmp/streaming-probe");
  fs.mkdirSync(execRoot, { recursive: true });
  const timeoutMs = args.timeoutMs ?? 180_000;

  const connections = loadConnections(path.resolve(args.db));
  const targets = connections.filter((conn) => {
    if (conn.status !== "CONNECTED") return false;
    if (!conn.runtimeProfileRef) return false;
    if (args.connection) return conn.id === args.connection;
    if (args.all) return true;
    return false;
  });

  if (targets.length === 0) {
    const pending = connections.map((c) => ({
      connectionId: c.id,
      backendKind: c.backendKind,
      status: c.status,
      eligibility: "PENDING_MANAGED_AUTH",
    }));
    process.stdout.write(
      JSON.stringify(
        { status: "PENDING_MANAGED_AUTH", connections: pending },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 2;
    return;
  }

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
    const probeResults: any[] = [];
    for (const probe of PROBES) {
      try {
        const outcome = await runProbe(service, conn, probe, args.model, timeoutMs);
        probeResults.push({ probe, outcome });
      } catch (error: any) {
        probeResults.push({
          probe,
          outcome: { result: { ok: false, code: "HARNESS_ERROR" } },
        });
      }
    }
    let abortResult: any = null;
    try {
      abortResult = await runAbortProbe(service, conn, args.model, timeoutMs);
    } catch {
      abortResult = { abortedAtFirstDelta: false, result: null, deltasAfterAbort: 0, events: [] };
    }

    const report = {
      connectionId: conn.id,
      backendKind: conn.backendKind,
      provider: conn.provider,
      model: args.model ?? "(runtime default)",
      declaredMechanism: capabilities?.execution?.streamingMechanism ?? null,
      probes: probeResults.map(({ probe, outcome }) => ({
        probe: probe.id,
        ok: outcome.result?.ok === true,
        code: outcome.result?.ok ? null : outcome.result?.code ?? null,
        runtimeVersion: outcome.result?.runtimeVersion ?? null,
        textChars: typeof outcome.result?.text === "string" ? outcome.result.text.length : null,
        ...summarizeStream(outcome.result),
      })),
      abort: abortResult
        ? {
            abortedAtFirstDelta: abortResult.abortedAtFirstDelta,
            code: abortResult.result?.code ?? null,
            deltasAfterAbort: abortResult.deltasAfterAbort,
            ...summarizeStream(abortResult.result),
          }
        : null,
      verdict: verdict(probeResults, abortResult),
    };
    reports.push(report);
  }

  process.stdout.write(JSON.stringify({ reports }, null, 2) + "\n");
  db.close();
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
