// Business TEXT_ONLY execution — desktop side. Verifies the executeText
// operation against fake adapters/runner: ticket redemption, connection
// status re-gate, managed env, fresh Vocatrya cwd, prompt-via-stdin, and
// the unified error taxonomy. No real runtime is spawned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";
import cacheModule from "./runtime-capability-cache.js";

const { createConnectionService } = serviceModule;
const { createCapabilityCache } = cacheModule;

const FAKE_EXE = "C:\\fake\\codex.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";

let profilesRoot;
let smokeWorkRoot;
let execWorkRoot;
let invocations;
let runnerScript;
let backend;
let service;

function runnerImpl(inv) {
  invocations.push({
    args: inv.args.slice(),
    env: { ...inv.env },
    cwd: inv.cwd,
    executable: inv.executable,
    stdinPipe: inv.stdinPipe,
    onStdinReady: inv.onStdinReady,
  });
  const head = inv.args.join(" ");
  for (const { match, respond } of runnerScript) {
    if (match(head, inv)) return respond(inv);
  }
  throw new Error(`No fake runner response for: ${head}`);
}

// Drives an invocation's declared stdin transport with a stub stream and
// returns what the child would have received plus the EOF flag.
function driveStdin(inv) {
  const stdin = { on() {}, ended: false, chunks: [],
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; } };
  inv.onStdinReady(stdin);
  return { prompt: stdin.chunks.join(""), ended: stdin.ended };
}

function respond(result) {
  return () =>
    Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
}

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Poison the ambient env — nothing credential-shaped may reach the
      // managed process environment.
      OPENAI_API_KEY: "sk-ambient",
      CODEX_API_KEY: "ambient",
      CODEX_ACCESS_TOKEN: "ambient",
      GITHUB_TOKEN: "ghp_ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "codex-cli 0.165.0\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
    // Existing streaming cases cover the one-shot app-server path
    // (busy-key fallback). Persistent reuse has its own suite.
    persistentCodexRuntime: false,
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "OPENAI",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CODEX_RUNTIME",
    displayName: "ChatGPT via Codex",
    accountIdentity: "first@example.com",
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function resolveOk(overrides = {}) {
  return {
    ok: true,
    operationId: "op_exec_1",
    operation: "executeText",
    backendKind: "CODEX_RUNTIME",
    connection: connectionRow(),
    ...overrides,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
  smokeWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-smoke-"));
  execWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-exec-"));
  invocations = [];
  backend = {
    resolveTicket: vi.fn(async () => resolveOk()),
    completeOperation: vi.fn(async () => ({ ok: true })),
  };
  service = createConnectionService({
    profilesRoot,
    smokeWorkRoot,
    execWorkRoot,
    backend,
    deps: makeDeps(),
  });
});

afterEach(() => {
  fs.rmSync(profilesRoot, { recursive: true, force: true });
  fs.rmSync(smokeWorkRoot, { recursive: true, force: true });
  fs.rmSync(execWorkRoot, { recursive: true, force: true });
});

function exec(overrides = {}) {
  return service.executeText({
    ticket: "t_exec",
    connectionId: "conn-1",
    model: "gpt-5.5",
    prompt: "Summarize this job",
    ...overrides,
  });
}

// Default fake: codex exec succeeds and writes last-message.txt into the
// invocation cwd (which must be a fresh dir under execWorkRoot).
function happyExec() {
  return [
    {
      match: (h) => h.includes("exec"),
      respond: (inv) => {
        fs.writeFileSync(
          path.join(inv.cwd, "last-message.txt"),
          "SCORES: match=90\n",
        );
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    },
  ];
}

describe("executeText", () => {
  it("redeems the ticket, runs the locked-down invocation, returns text", async () => {
    runnerScript = happyExec();
    const result = await exec();
    expect(result.ok).toBe(true);
    expect(result.text).toBe("SCORES: match=90");
    expect(result.provider).toBe("OPENAI");
    expect(result.backendKind).toBe("CODEX_RUNTIME");
    expect(result.model).toBe("gpt-5.5");
    expect(result.connectionId).toBe("conn-1");
    expect(typeof result.durationMs).toBe("number");

    // Ticket redeemed as executeText and spent via completeOperation.
    expect(backend.resolveTicket).toHaveBeenCalledWith("t_exec");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_exec_1", {
      outcome: "consumed",
    });

    const inv = invocations.find((i) => i.args.includes("exec"));
    expect(inv).toBeTruthy();
    // `codex exec -` — the prompt rides piped stdin to EOF, never inside
    // argv or a shell string.
    expect(inv.args).not.toContain("Summarize this job");
    const stdin = driveStdin(inv);
    expect(stdin.prompt).toBe("Summarize this job");
    expect(stdin.ended).toBe(true);
    expect(inv.args).toContain("-m");
    expect(inv.args).toContain("gpt-5.5");
    // Fresh Vocatrya-owned cwd under the exec root; cleaned up afterwards.
    expect(inv.cwd.startsWith(execWorkRoot)).toBe(true);
    expect(fs.existsSync(inv.cwd)).toBe(false);
    // Managed profile env; ambient credentials are stripped.
    expect(inv.env.CODEX_HOME.startsWith(profilesRoot)).toBe(true);
    for (const key of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      expect(inv.env[key]).toBeUndefined();
    }
  });

  it("rejects a ticket minted for a different operation", async () => {
    backend.resolveTicket.mockResolvedValueOnce(
      resolveOk({ operation: "smoke" }),
    );
    const result = await exec();
    expect(result).toEqual({ ok: false, code: "INVALID_TICKET" });
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("rejects a ticket bound to a different connectionId", async () => {
    const result = await exec({ connectionId: "conn-other" });
    expect(result).toEqual({ ok: false, code: "CONNECTION_NOT_FOUND" });
  });

  it("re-gates connection status without falling back", async () => {
    for (const [status, code] of [
      ["REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ["DISCONNECTED", "CONNECTION_DISCONNECTED"],
      ["ERROR", "CONNECTION_ERROR"],
    ]) {
      backend.resolveTicket.mockResolvedValueOnce(
        resolveOk({ connection: connectionRow({ status }) }),
      );
      const result = await exec();
      expect(result).toEqual({ ok: false, code });
      expect(invocations.find((i) => i.args.includes("exec"))).toBeUndefined();
    }
  });

  it("maps a timed-out run to AI_EXECUTION_TIMEOUT", async () => {
    runnerScript = [
      { match: (h) => h.includes("exec"), respond: respond({ timedOut: true }) },
    ];
    const result = await exec();
    expect(result).toEqual({ ok: false, code: "AI_EXECUTION_TIMEOUT" });
  });

  it("maps a failed run to INFERENCE_FAILED", async () => {
    runnerScript = [
      {
        match: (h) => h.includes("exec"),
        respond: respond({ exitCode: 1, stderr: "model not found" }),
      },
    ];
    const result = await exec();
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
  });

  it("emits sanitized diagnostics with stderr summary on failure", async () => {
    const events = [];
    const svc = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      execWorkRoot,
      backend,
      deps: makeDeps(),
      diag: (ev) => events.push(ev),
    });
    runnerScript = [
      {
        match: (h) => h.includes("exec"),
        respond: respond({ exitCode: 1, stderr: "model not found\\nerror details" }),
      },
    ];
    const result = await svc.executeText({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.5",
      prompt: "Summarize this job",
      structuredOutput: {
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        schemaName: "test_schema",
      },
    });
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
    const ev = events.find((e) => e.operation === "executeText" && e.exitCode === 1);
    expect(ev).toBeDefined();
    expect(ev.backendKind).toBe("CODEX_RUNTIME");
    expect(ev.provider).toBe("OPENAI");
    expect(ev.model).toBe("gpt-5.5");
    expect(ev.exitCode).toBe(1);
    expect(ev.hasStructuredOutput).toBe(true);
    expect(ev.schemaName).toBe("test_schema");
    expect(ev.stderrSummary).toContain("model not found");
  });

  it("maps reported adapter errors to INFERENCE_FAILED", async () => {
    runnerScript = [
      {
        match: (h) => h.includes("exec"),
        respond: (inv) => {
          fs.writeFileSync(path.join(inv.cwd, "last-message.txt"), "");
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    ];
    const result = await exec();
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
  });

  it("fails when the ticket cannot be resolved (backend down)", async () => {
    backend.resolveTicket.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await exec();
    expect(result).toEqual({ ok: false, code: "BACKEND_UNAVAILABLE" });
  });

  it("never installs, logs in, or updates — only the exec invocation runs", async () => {
    runnerScript = happyExec();
    const result = await exec();
    expect(result.ok).toBe(true);
    const head = invocations.map((i) => i.args[0] ?? "").join("|");
    expect(head).not.toContain("install");
    expect(head).not.toContain("login");
    expect(head).not.toContain("update");
  });
});

describe("executeTextStream", () => {
  // Streaming probes use the in-process verificationProbe flag — the same
  // harness-only bypass the structured-output probe uses.
  const PROBE = { verificationProbe: true };

  // The codex adapter's streaming invocation is `app-server` stdio
  // JSON-RPC: the fake runner hands the driver a writable stdin stub and
  // answers the handshake — initialize → thread/start → turn/start —
  // pushing scripted server notifications through the stdout observer.
  // `onTurn` runs once turn/start resolves, so notification streams can
  // be scripted per-test.
  function appServerScript({ onTurn, tail = {} }) {
    return [
      {
        match: (h) => h.includes("app-server"),
        respond: (inv) => {
          let buf = "";
          const stdin = {
            ended: false,
            write(chunk) {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const msg = JSON.parse(line);
                if (msg.id === undefined) continue; // `initialized`
                const resultFor = {
                  initialize: {},
                  "thread/start": {
                    thread: { id: "thr_1" },
                    model: "gpt-5.5",
                    sandbox: { type: "readOnly", networkAccess: false },
                    approvalPolicy: "never",
                  },
                  "turn/start": {
                    turn: { id: "turn_1", status: "inProgress" },
                  },
                }[msg.method];
                inv.onStdout(
                  Buffer.from(JSON.stringify({ id: msg.id, result: resultFor }) + "\n"),
                );
                if (msg.method === "turn/start") onTurn?.(inv, stdin);
              }
            },
            end() {
              this.ended = true;
            },
          };
          inv.onStdinReady(stdin);
          return Promise.resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            ...tail.result,
          });
        },
      },
    ];
  }

  const line = (obj) => JSON.stringify(obj) + "\n";

  function streamExec(overrides = {}) {
    return service.executeTextStream({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.5",
      prompt: "Summarize this job",
      ...overrides,
    });
  }

  it("refuses business streaming when the installed version drifted from the verified one", async () => {
    // Codex streaming PASS is bound to the verified build (0.165.0) — an
    // upgraded runtime reports a different version and must fail closed.
    runnerScript = [];
    const drifted = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      execWorkRoot,
      backend,
      deps: {
        ...makeDeps(),
        spawnSyncImpl: (cmd, args) => {
          if (cmd === "where.exe")
            return { status: 0, stdout: `${FAKE_EXE}\r\n` };
          return { status: 0, stdout: "codex-cli 9.9.9\n", stderr: "" };
        },
      },
    });
    const result = await drifted.executeTextStream({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.5",
      prompt: "Summarize this job",
    });
    expect(result).toEqual({ ok: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      invocations.find((i) => i.args.includes("app-server")),
    ).toBeUndefined();
  });

  it("drives the JSON-RPC handshake, streams deltas, reconciles on the wire", async () => {
    let seenStdin;
    runnerScript = appServerScript({
      onTurn: (inv, stdin) => {
        seenStdin = stdin;
        // Protocol diagnostics and retried transport errors ride the same
        // stream — they never become content.
        inv.onStdout(
          Buffer.from(
            line({ method: "thread/status/changed", params: {} }) +
              line({ method: "error", params: { willRetry: true, error: {} } }) +
              line({
                method: "item/agentMessage/delta",
                params: { itemId: "i1", delta: "Hel" },
              }),
          ),
        );
        inv.onStdout(
          Buffer.from(
            line({
              method: "item/agentMessage/delta",
              params: { itemId: "i1", delta: "lo" },
            }) +
              line({
                method: "item/completed",
                params: {
                  item: { id: "i1", type: "agentMessage", text: "Hello" },
                },
              }) +
              line({
                method: "turn/completed",
                params: { turn: { id: "turn_1", status: "completed" } },
              }),
          ),
        );
      },
    });
    const seen = [];
    const result = await streamExec({
      ...PROBE,
      onEvent: (e) => seen.push(e),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Hello");
    expect(result.stream.deltaCount).toBe(2);
    expect(result.stream.deltaChunkCount).toBe(2);
    expect(result.stream.reconstruction).toBe("MATCH");
    expect(result.stream.mechanism).toBe("codex app-server");
    expect(
      seen.filter((e) => e.type === "text-delta").map((e) => e.delta),
    ).toEqual(["Hel", "lo"]);
    expect(seen.at(-1).type).toBe("completed");
    // turn/completed ended stdin — the managed server exits on EOF.
    expect(seenStdin.ended).toBe(true);
    // The invocation is app-server stdio, not exec --json.
    const inv = invocations.find((i) => i.args.includes("app-server"));
    expect(inv.args.join(" ")).toContain("--listen stdio://");
    expect(inv.args.join(" ")).not.toContain("--json");
    expect(inv.cwd.startsWith(execWorkRoot)).toBe(true);
  });

  it("aborts on signal — terminal ABORTED, no late deltas delivered", async () => {
    runnerScript = [
      {
        match: (h) => h.includes("app-server"),
        respond: (inv) => {
          let buf = "";
          const stdin = {
            ended: false,
            write(chunk) {
              buf += chunk;
              for (const line of buf.split("\n").filter(Boolean)) {
                const msg = JSON.parse(line);
                if (msg.id === undefined) continue;
                if (msg.method === "turn/start") {
                  inv.onStdout(
                    Buffer.from(
                      JSON.stringify({
                        id: msg.id,
                        result: { turn: { id: "t" } },
                      }) + "\n",
                    ),
                  );
                  // First delta delivers; the abort fires synchronously
                  // inside the observer — the second chunk is suppressed.
                  inv.onStdout(
                    Buffer.from(
                      JSON.stringify({
                        method: "item/agentMessage/delta",
                        params: { itemId: "i1", delta: "Hel" },
                      }) + "\n",
                    ),
                  );
                  expect(inv.signal.aborted).toBe(true);
                  inv.onStdout(
                    Buffer.from(
                      JSON.stringify({
                        method: "item/agentMessage/delta",
                        params: { itemId: "i1", delta: "lo!" },
                      }) + "\n",
                    ),
                  );
                  continue;
                }
                inv.onStdout(
                  Buffer.from(
                    JSON.stringify({
                      id: msg.id,
                      result:
                        msg.method === "thread/start"
                          ? { thread: { id: "thr_1" } }
                          : {},
                    }) + "\n",
                  ),
                );
              }
              buf = "";
            },
            end() {
              this.ended = true;
            },
          };
          inv.onStdinReady(stdin);
          return Promise.resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            aborted: true,
          });
        },
      },
    ];
    const controller = new AbortController();
    const seen = [];
    const result = await streamExec({
      ...PROBE,
      signal: controller.signal,
      onEvent: (e) => {
        seen.push(e);
        if (e.type === "text-delta") controller.abort();
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ABORTED");
    expect(result.stream.aborted).toBe(true);
    // Exactly one delta was delivered; nothing arrives after the abort.
    expect(seen.filter((e) => e.type === "text-delta")).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ type: "error", code: "ABORTED" });
  });

  it("fails closed when the delta channel disagrees with item/completed", async () => {
    runnerScript = appServerScript({
      onTurn: (inv) => {
        inv.onStdout(
          Buffer.from(
            line({
              method: "item/agentMessage/delta",
              params: { itemId: "i1", delta: "Hello" },
            }) +
              line({
                method: "item/completed",
                params: {
                  item: { id: "i1", type: "agentMessage", text: "rewritten" },
                },
              }) +
              line({
                method: "turn/completed",
                params: { turn: { id: "t", status: "completed" } },
              }),
          ),
        );
      },
    });
    const result = await streamExec(PROBE);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STREAM_COMPLETION_INCONSISTENT");
  });

  it("a server that exits mid-turn without turn/completed fails the run", async () => {
    runnerScript = appServerScript({
      onTurn: (inv) => {
        // Partial deltas then silence: stdin EOF / crash ends the process.
        inv.onStdout(
          Buffer.from(
            line({
              method: "item/agentMessage/delta",
              params: { itemId: "i1", delta: "partial" },
            }),
          ),
        );
      },
    });
    const result = await streamExec(PROBE);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INFERENCE_FAILED");
  });
});

describe("executeText structuredOutput contract", () => {
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  // These transport-contract tests exercise the schema mechanism itself —
  // the in-process verificationProbe flag bypasses the business
  // verification gate the same way scripts/structured-output-probe.mts
  // does (the HTTP endpoint can never set it).
  const PROBE = { verificationProbe: true };

  it("native runtime (codex): schema rides --output-schema inside the fresh workDir", async () => {
    runnerScript = happyExec();
    const result = await exec({
      structuredOutput: { schema: SCHEMA, schemaName: "VocatryaProbe" },
      ...PROBE,
    });
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBe("NATIVE_JSON_SCHEMA");

    const inv = invocations.find((i) => i.args.includes("exec"));
    const idx = inv.args.indexOf("--output-schema");
    expect(idx).toBeGreaterThan(-1);
    const schemaPath = inv.args[idx + 1];
    // Vocatrya-owned path inside the (now cleaned) fresh exec cwd.
    expect(schemaPath.startsWith(execWorkRoot)).toBe(true);
    expect(schemaPath.endsWith("VocatryaProbe.schema.json")).toBe(true);
    // The text invocation ends with `codex exec -`; the prompt arrives
    // through piped stdin.
    expect(inv.args[inv.args.length - 1]).toBe("-");
    const stdin = driveStdin(inv);
    expect(stdin.prompt).toBe("Summarize this job");
  });

  it("prompt-only runtime (opencode): same payload, plain text invocation, PROMPT_AND_VALIDATE", async () => {
    const svc = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      execWorkRoot,
      backend,
      deps: {
        ...makeDeps(),
        spawnSyncImpl: (cmd) =>
          cmd === "where.exe"
            ? { status: 0, stdout: `${FAKE_EXE}\r\n` }
            : { status: 0, stdout: "1.18.31\n", stderr: "" },
      },
    });
    backend.resolveTicket.mockResolvedValue(
      resolveOk({
        backendKind: "OPENCODE_RUNTIME",
        connection: connectionRow({
          backendKind: "OPENCODE_RUNTIME",
          provider: "OPENCODE_GO",
          displayName: "OpenCode Go",
        }),
      }),
    );
    runnerScript = [
      {
        match: (h) => h.startsWith("run "),
        respond: respond({
          stdout:
            '{"type":"text","part":{"text":"{\\"name\\":\\"x\\",\\"score\\":1,\\"status\\":\\"PASS\\"}"}}',
        }),
      },
    ];
    const result = await svc.executeText({
      ticket: "t",
      connectionId: "conn-1",
      model: "opencode-go/kimi-k2.5",
      prompt: "task",
      structuredOutput: { schema: SCHEMA, schemaName: "VocatryaProbe" },
      verificationProbe: true,
    });
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBe("PROMPT_AND_VALIDATE");
    expect(result.text).toBe('{"name":"x","score":1,"status":"PASS"}');
    const inv = invocations.find((i) => i.args[0] === "run");
    expect(inv.args.join(" ")).not.toContain("--output-schema");
    expect(inv.args.join(" ")).not.toContain("--json-schema");
  });

  it("plain TEXT_ONLY requests carry no structuredStrategy", async () => {
    runnerScript = happyExec();
    const result = await exec();
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBeNull();
  });
});

describe("executeText structured verification gate", () => {
  const SCHEMA = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const STRUCTURED = { schema: SCHEMA, schemaName: "VocatryaProbe" };

  function devinService(version = "3000.10.31", extraDeps = {}) {
    backend.resolveTicket.mockResolvedValue(
      resolveOk({
        backendKind: "DEVIN_RUNTIME",
        connection: connectionRow({
          backendKind: "DEVIN_RUNTIME",
          provider: "DEVIN",
          displayName: "Devin",
        }),
      }),
    );
    return createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      execWorkRoot,
      backend,
      deps: {
        platform: "win32",
        env: { PATH: "C:\\Windows" },
        existsSyncImpl: (p) => p === FAKE_EXE,
        spawnSyncImpl: (cmd) =>
          cmd === "where.exe"
            ? { status: 0, stdout: `${FAKE_EXE}\r\n` }
            : { status: 0, stdout: `devin ${version}\n`, stderr: "" },
        runner: vi.fn(runnerImpl),
        // Fresh in-memory cache per service: seeds only, no disk.
        capabilityCache: createCapabilityCache({}),
        ...extraDeps,
      },
    });
  }

  function devinExec(svc, overrides = {}) {
    return svc.executeText({
      ticket: "t",
      connectionId: "conn-1",
      model: "claude-opus-5-5-medium",
      prompt: "task",
      structuredOutput: STRUCTURED,
      ...overrides,
    });
  }

  it("refuses structured execution on a version-drifted runtime (no bypass flag)", async () => {
    // Codex structured output is verified on 0.165.0 — a binary reporting
    // a different version is back to unverified and fails closed.
    const drifted = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      execWorkRoot,
      backend,
      deps: {
        ...makeDeps(),
        spawnSyncImpl: (cmd, args) => {
          if (cmd === "where.exe") {
            return { status: 0, stdout: `${FAKE_EXE}\r\n` };
          }
          return { status: 0, stdout: "codex-cli 0.155.0\n", stderr: "" };
        },
      },
    });
    const result = await drifted.executeText({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.5",
      prompt: "Summarize this job",
      structuredOutput: STRUCTURED,
    });
    expect(result).toEqual({
      ok: false,
      code: "STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
    // The gate fires before any exec invocation — the model is never run.
    expect(invocations.find((i) => i.args.includes("exec"))).toBeUndefined();
  });

  it("runs structured execution on the verified Codex version", async () => {
    runnerScript = happyExec();
    const result = await exec({ structuredOutput: STRUCTURED });
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBe("NATIVE_JSON_SCHEMA");
  });

  it("verified Devin runtime + matching version runs PROMPT_AND_VALIDATE", async () => {
    const svc = devinService("3000.10.31");
    runnerScript = [
      {
        match: (h) => h.includes("whoami"),
        respond: respond({ stdout: '{"org_id":"o1"}' }),
      },
      {
        match: (h) => h.startsWith("-p"),
        respond: respond({ stdout: '{"name":"x"}' }),
      },
    ];
    const result = await devinExec(svc);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"name":"x"}');
    expect(result.structuredStrategy).toBe("PROMPT_AND_VALIDATE");
    const inv = invocations.find((i) => i.args[0] === "-p");
    expect(inv.cwd.startsWith(execWorkRoot)).toBe(true);
  });

  const PROBE_OK = '{"probe":"VOCATRYA_CAPABILITY_PROBE","ok":true}';
  const probeCalls = () =>
    invocations.filter((i) => i.args.includes("--prompt-file") && i.args[0] === "-p");

  it("unknown version: runs one self-check probe, caches PASS, then runs the request", async () => {
    const cache = createCapabilityCache({});
    const svc = devinService("3000.99.1", { capabilityCache: cache });
    let n = 0;
    runnerScript = [
      { match: (h) => h.includes("whoami"), respond: respond({ stdout: '{"org_id":"o1"}' }) },
      {
        match: (h) => h.startsWith("-p"),
        respond: (inv) => {
          n += 1;
          // First -p call is the probe, second the real request.
          const out = n === 1 ? PROBE_OK : '{"name":"x"}';
          inv.onStdout?.(Buffer.from(out));
          return Promise.resolve({ exitCode: 0, stdout: out, stderr: "" });
        },
      },
    ];
    const first = await devinExec(svc);
    expect(first.ok).toBe(true);
    expect(first.text).toBe('{"name":"x"}');
    expect(n).toBe(2);
    expect(cache.verdict("DEVIN_RUNTIME", "3000.99.1", "structured")).toBe("PASS");
    // Second request: cache hit, no further probe.
    const second = await devinExec(svc);
    expect(second.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("unknown version: failed self-check refuses and is cached (no re-probe)", async () => {
    const cache = createCapabilityCache({});
    const svc = devinService("3000.99.2", { capabilityCache: cache });
    let n = 0;
    runnerScript = [
      { match: (h) => h.includes("whoami"), respond: respond({ stdout: '{"org_id":"o1"}' }) },
      {
        match: (h) => h.startsWith("-p"),
        respond: (inv) => {
          n += 1;
          inv.onStdout?.(Buffer.from("not json"));
          return Promise.resolve({ exitCode: 0, stdout: "not json", stderr: "" });
        },
      },
    ];
    const result = await devinExec(svc);
    expect(result).toEqual({ ok: false, code: "STRUCTURED_OUTPUT_NOT_VERIFIED" });
    expect(cache.verdict("DEVIN_RUNTIME", "3000.99.2", "structured")).toBe("FAIL");
    await devinExec(svc);
    expect(n).toBe(1);
  });

  it("seeded version: cache hit runs without any probe", async () => {
    const svc = devinService("3000.10.31");
    runnerScript = [
      { match: (h) => h.includes("whoami"), respond: respond({ stdout: '{"org_id":"o1"}' }) },
      { match: (h) => h.startsWith("-p"), respond: respond({ stdout: '{"name":"x"}' }) },
    ];
    const result = await devinExec(svc);
    expect(result.ok).toBe(true);
    expect(probeCalls()).toHaveLength(1);
  });

  it("verificationProbe bypasses the gate (in-process harness only)", async () => {
    const svc = devinService("3000.10.30");
    runnerScript = [
      {
        match: (h) => h.includes("whoami"),
        respond: respond({ exitCode: 1 }),
      },
      {
        match: (h) => h.startsWith("-p"),
        respond: respond({ stdout: '{"name":"x"}' }),
      },
    ];
    const result = await devinExec(svc, { verificationProbe: true });
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBe("PROMPT_AND_VALIDATE");
  });

  it("unverified runtimes still serve plain TEXT_ONLY requests", async () => {
    runnerScript = happyExec();
    const result = await exec();
    expect(result.ok).toBe(true);
    expect(result.structuredStrategy).toBeNull();
  });
});
