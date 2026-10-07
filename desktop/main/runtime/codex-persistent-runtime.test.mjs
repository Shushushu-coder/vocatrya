// Persistent Codex app-server pool. Fake children only — no live model.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAdapter } from "./codex.js";
import serviceModule from "./connection-service.js";
import {
  MAX_PERSISTENT_CODEX_PROCESSES_PER_USER,
  PERSISTENT_CODEX_IDLE_TTL_MS,
  createCodexPersistentRuntimeManager,
} from "./codex-persistent-runtime.js";

const { createConnectionService } = serviceModule;
const FAKE_EXE = "C:\\fake\\codex.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";

function createFakeSpawn() {
  const spawned = [];
  let nextPid = 400;
  let mode = "complete";
  function spawnImpl(executable, args, opts) {
    const child = new EventEmitter();
    const pid = ++nextPid;
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const record = {
      pid,
      executable,
      args,
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell,
      threads: [],
      prompts: [],
      child,
    };
    let buffer = "";
    let threadSeq = 0;
    const emit = (message) => {
      child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
    };
    child.stdin = {
      destroyed: false,
      write(chunk) {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const message = JSON.parse(line);
          if (message.method === "initialized" || message.id === undefined) {
            continue;
          }
          if (message.method === "initialize") {
            emit({ id: message.id, result: {} });
            continue;
          }
          if (message.method === "thread/start") {
            threadSeq += 1;
            if (mode === "bad-thread") {
              emit({ id: message.id, result: { thread: {} } });
              continue;
            }
            const threadId = `thr_${pid}_${threadSeq}`;
            record.threads.push(threadId);
            record.prompts.push(message.params?.cwd ?? null);
            emit({ id: message.id, result: { thread: { id: threadId } } });
            continue;
          }
          if (message.method === "turn/start") {
            const text = message.params?.input?.[0]?.text ?? "";
            record.prompts.push(text);
            if (mode === "hold") {
              emit({
                id: message.id,
                result: { turn: { id: `turn_${threadSeq}`, status: "inProgress" } },
              });
              continue;
            }
            emit({
              id: message.id,
              result: { turn: { id: `turn_${threadSeq}`, status: "inProgress" } },
            });
            const answer =
              mode === "vendor-fail" ? "" : `echo:${text}`;
            if (mode === "vendor-fail") {
              emit({
                method: "turn/completed",
                params: { turn: { id: `turn_${threadSeq}`, status: "failed" } },
              });
              continue;
            }
            emit({
              method: "item/agentMessage/delta",
              params: { itemId: "i1", delta: answer },
            });
            emit({
              method: "item/completed",
              params: { item: { id: "i1", type: "agentMessage", text: answer } },
            });
            emit({
              method: "turn/completed",
              params: { turn: { id: `turn_${threadSeq}`, status: "completed" } },
            });
          }
        }
        return true;
      },
      end() {
        this.destroyed = true;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    child.kill = () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.killed = true;
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
    };
    spawned.push(record);
    return child;
  }
  return {
    spawnImpl,
    spawned,
    setMode(next) {
      mode = next;
    },
  };
}

function identity(overrides = {}) {
  return {
    userId: "user-1",
    connectionId: "conn-1",
    resolvedModel: "gpt-5.6-sol",
    runtimeVersion: "0.160.0",
    runtimeProfileRef: RP_A,
    executablePath: FAKE_EXE,
    profileDir: overrides.profileDir,
    baseEnv: overrides.baseEnv,
    status: "CONNECTED",
    archived: false,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("CodexPersistentRuntimeManager", () => {
  let root;
  let profileDir;
  let clock;
  let fake;
  let manager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pool-"));
    profileDir = path.join(root, "profile");
    fs.mkdirSync(profileDir);
    clock = { t: 1_000 };
    fake = createFakeSpawn();
    manager = createCodexPersistentRuntimeManager({
      spawnImpl: fake.spawnImpl,
      terminateImpl: (child) => child?.kill?.(),
      now: () => clock.t,
      stableCwd: path.join(root, "stable"),
      buildInvocation: (input) => codexAdapter.buildStreamingInvocation(input),
    });
  });

  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function id(overrides = {}) {
    return identity({
      profileDir,
      baseEnv: {
        PATH: "C:\\Windows",
        USERPROFILE: root,
        OPENAI_API_KEY: "sk-ambient",
        ...(overrides.baseEnv || {}),
      },
      ...overrides,
      baseEnv: undefined,
      ...(overrides.baseEnv
        ? {
            baseEnv: {
              PATH: "C:\\Windows",
              USERPROFILE: root,
              OPENAI_API_KEY: "sk-ambient",
              ...overrides.baseEnv,
            },
          }
        : {
            baseEnv: {
              PATH: "C:\\Windows",
              USERPROFILE: root,
              OPENAI_API_KEY: "sk-ambient",
            },
          }),
    });
  }

  async function turn(overrides = {}, turnOverrides = {}) {
    const lease = await manager.acquire(id(overrides));
    expect(lease.kind === "fresh" || lease.kind === "reuse").toBe(true);
    const result = await manager.runTurn(lease.entry, {
      prompt: turnOverrides.prompt ?? "marker",
      model: overrides.resolvedModel ?? "gpt-5.6-sol",
      workingDirectory: turnOverrides.workingDirectory ?? path.join(root, "turn"),
      timeoutMs: 5_000,
      signal: turnOverrides.signal,
      onEvent: turnOverrides.onEvent,
    });
    return { lease, result };
  }

  it("spawns and initializes on the first turn, then keeps the process", async () => {
    const { lease, result } = await turn({}, { prompt: "marker-A" });
    expect(lease.kind).toBe("fresh");
    expect(lease.meta.runtimeReuseHit).toBe(false);
    expect(lease.meta.threadReuseHit).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.threadId).toMatch(/^thr_/);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0].args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(fake.spawned[0].shell).toBe(false);
    expect(fake.spawned[0].cwd).toBe(path.join(root, "stable"));
    expect(fake.spawned[0].env.CODEX_HOME).toBe(profileDir);
    expect(fake.spawned[0].env.OPENAI_API_KEY).toBeUndefined();
    expect(manager.inspect().size).toBe(1);
    expect(manager.inspect().entries[0].busy).toBe(false);
  });

  it("reuses the process and opens a new thread on the second turn", async () => {
    const first = await turn({}, { prompt: "marker-A" });
    clock.t += 50;
    const second = await turn({}, { prompt: "marker-B" });
    expect(second.lease.kind).toBe("reuse");
    expect(second.lease.meta.runtimeReuseHit).toBe(true);
    expect(second.lease.meta.runtimeSpawnMs).toBe(0);
    expect(second.lease.meta.runtimeInitMs).toBe(0);
    expect(second.lease.meta.threadReuseHit).toBe(false);
    expect(second.result.threadId).not.toBe(first.result.threadId);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0].threads).toEqual([
      first.result.threadId,
      second.result.threadId,
    ]);
    expect(fake.spawned[0].prompts.filter((value) => value.startsWith("marker"))).toEqual([
      "marker-A",
      "marker-B",
    ]);
  });

  it("does not reuse across connection, user, or model", async () => {
    await turn();
    await turn({ connectionId: "conn-2" });
    await turn({ userId: "user-2", connectionId: "conn-1" });
    await turn({ resolvedModel: "gpt-5.5" });
    expect(fake.spawned).toHaveLength(4);
    const models = manager.inspect().entries.map((entry) => entry.resolvedModel);
    expect(models.filter((model) => model === "gpt-5.6-sol").length).toBe(3);
    expect(models).toContain("gpt-5.5");
  });

  it("retires a process when the proxy fingerprint changes", async () => {
    await turn({ baseEnv: { HTTPS_PROXY: "http://127.0.0.1:7897" } });
    const firstPid = fake.spawned[0].pid;
    expect(fake.spawned[0].env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    const next = await turn({ baseEnv: { HTTPS_PROXY: "http://127.0.0.1:8899" } });
    expect(next.lease.kind).toBe("fresh");
    expect(next.lease.meta.runtimeReuseHit).toBe(false);
    expect(next.lease.meta.runtimeRestartReason).toBe("config");
    expect(fake.spawned).toHaveLength(2);
    expect(fake.spawned[1].env.HTTPS_PROXY).toBe("http://127.0.0.1:8899");
    expect(fake.spawned[0].child.killed).toBe(true);
    expect(manager.inspect().entries.map((entry) => entry.pid)).toEqual([
      fake.spawned[1].pid,
    ]);
    expect(manager.inspect().entries[0].pid).not.toBe(firstPid);
  });

  it("retires an older runtime version before the caller applies the capability gate", async () => {
    await turn({ runtimeVersion: "0.160.0" });
    const next = await manager.acquire(id({ runtimeVersion: "0.161.0" }));
    expect(next.kind).toBe("fresh");
    expect(next.meta.runtimeRestartReason).toBe("version");
    expect(manager.inspect().entries.map((entry) => entry.runtimeVersion)).toEqual([
      "0.161.0",
    ]);
    expect(fake.spawned[0].child.killed).toBe(true);
  });

  it("retires an idle process after the TTL using the injected clock", async () => {
    await turn();
    clock.t += PERSISTENT_CODEX_IDLE_TTL_MS + 1;
    const next = await turn();
    expect(next.lease.kind).toBe("fresh");
    expect(next.lease.meta.runtimeRestartReason).toBe("ttl");
    expect(fake.spawned).toHaveLength(2);
    expect(fake.spawned[0].child.killed).toBe(true);
  });

  it("evicts the oldest idle process at the per-user cap and never evicts a busy one", async () => {
    expect(MAX_PERSISTENT_CODEX_PROCESSES_PER_USER).toBe(3);
    await turn({ connectionId: "c1" });
    clock.t += 10;
    await turn({ connectionId: "c2" });
    clock.t += 10;
    await turn({ connectionId: "c3" });
    clock.t += 10;
    const fourth = await turn({ connectionId: "c4" });
    expect(fourth.lease.kind).toBe("fresh");
    expect(manager.inspect().size).toBe(3);
    expect(manager.inspect().entries.map((entry) => entry.connectionId).sort()).toEqual([
      "c2",
      "c3",
      "c4",
    ]);
    expect(fake.spawned[0].child.killed).toBe(true);

    manager.disposeAll();
    fake.setMode("hold");
    const busyLease = await manager.acquire(id({ connectionId: "busy" }));
    const busyTurn = manager.runTurn(busyLease.entry, {
      prompt: "hold",
      model: "gpt-5.6-sol",
      workingDirectory: root,
      timeoutMs: 5_000,
    });
    fake.setMode("complete");
    clock.t += 10;
    await turn({ connectionId: "idle-a" });
    clock.t += 10;
    await turn({ connectionId: "idle-b" });
    clock.t += 10;
    await turn({ connectionId: "idle-c" });
    expect(manager.inspect().entries.some((entry) => entry.connectionId === "busy" && entry.busy)).toBe(true);
    expect(manager.inspect().entries.some((entry) => entry.connectionId === "idle-a")).toBe(false);
    busyLease.entry.child.kill();
    await busyTurn;
  });

  it("retires the process on abort, timeout, crash, and fatal protocol", async () => {
    fake.setMode("hold");
    const abortLease = await manager.acquire(id());
    const controller = new AbortController();
    const aborting = manager.runTurn(abortLease.entry, {
      prompt: "stop",
      model: "gpt-5.6-sol",
      workingDirectory: root,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const aborted = await aborting;
    expect(aborted.aborted).toBe(true);
    expect(manager.inspect().size).toBe(0);
    expect(fake.spawned[0].child.killed).toBe(true);

    const afterAbort = await manager.acquire(id());
    expect(afterAbort.kind).toBe("fresh");
    expect(afterAbort.meta.runtimeRestartReason).toBe("abort");
    afterAbort.entry.child.kill();

    const timers = [];
    const timed = createCodexPersistentRuntimeManager({
      spawnImpl: fake.spawnImpl,
      terminateImpl: (child) => child?.kill?.(),
      now: () => clock.t,
      setTimer: (fn) => {
        const handle = timers.length + 1;
        timers.push(fn);
        return handle;
      },
      clearTimer: () => {},
      stableCwd: path.join(root, "stable-timeout"),
      buildInvocation: (input) => codexAdapter.buildStreamingInvocation(input),
    });
    const timeoutLease = await timed.acquire(id());
    expect(timeoutLease.kind).toBe("fresh");
    const timing = timed.runTurn(timeoutLease.entry, {
      prompt: "slow",
      model: "gpt-5.6-sol",
      workingDirectory: root,
      timeoutMs: 5_000,
    });
    timers.at(-1)();
    const timedOut = await timing;
    expect(timedOut.timedOut).toBe(true);
    expect(timed.inspect().size).toBe(0);

    fake.setMode("hold");
    const crashLease = await manager.acquire(id({ connectionId: "crash" }));
    const crashing = manager.runTurn(crashLease.entry, {
      prompt: "crash",
      model: "gpt-5.6-sol",
      workingDirectory: root,
      timeoutMs: 5_000,
    });
    crashLease.entry.child.emit("exit", 1, null);
    const crashed = await crashing;
    expect(crashed.error).toBe("crashed");
    expect(manager.inspect().entries.some((entry) => entry.connectionId === "crash")).toBe(false);

    fake.setMode("bad-thread");
    const broken = await turn({ connectionId: "broken" });
    expect(broken.result.exitCode).toBe(0);
    expect(manager.inspect().entries.some((entry) => entry.connectionId === "broken")).toBe(false);
    fake.setMode("complete");
    const recovered = await turn({ connectionId: "broken" });
    expect(recovered.lease.kind).toBe("fresh");
    expect(recovered.result.threadId).toMatch(/^thr_/);
  });

  it("keeps the process after a clean vendor turn failure", async () => {
    fake.setMode("vendor-fail");
    const failed = await turn();
    expect(failed.result.exitCode).toBe(0);
    expect(failed.result.error).toBeNull();
    expect(manager.inspect().size).toBe(1);
    fake.setMode("complete");
    const again = await turn();
    expect(again.lease.kind).toBe("reuse");
    expect(fake.spawned).toHaveLength(1);
  });

  it("uses a one-shot lane when the pooled process is busy", async () => {
    fake.setMode("hold");
    const lease = await manager.acquire(id());
    const pending = manager.runTurn(lease.entry, {
      prompt: "first",
      model: "gpt-5.6-sol",
      workingDirectory: root,
      timeoutMs: 5_000,
    });
    const second = await manager.acquire(id());
    expect(second.kind).toBe("oneshot");
    expect(second.meta.runtimeReuseHit).toBe(false);
    expect(fake.spawned).toHaveLength(1);
    expect(manager.inspect().size).toBe(1);
    lease.entry.child.kill();
    await pending;
  });

  it("drops a pooled process when the connection is no longer usable", async () => {
    await turn();
    const blocked = await manager.acquire(id({ status: "REAUTH_REQUIRED" }));
    expect(blocked.kind).toBe("unavailable");
    expect(manager.inspect().size).toBe(0);
    expect(fake.spawned[0].child.killed).toBe(true);
  });

  it("does not retain prompt text on the pool entry after the turn", async () => {
    const { lease } = await turn({}, { prompt: "secret-marker" });
    expect(JSON.stringify(manager.inspect())).not.toContain("secret-marker");
    expect(lease.entry.session.threadId()).toBeNull();
  });
});

describe("executeTextStream persistent Codex integration", () => {
  let profilesRoot;
  let execWorkRoot;
  let fake;
  let manager;
  let runnerCalls;
  let backend;
  let service;
  let version;
  let connection;

  // Exactly the projection the internal resolve route
  // (src/app/api/internal/ai-connections/resolve/route.ts) returns to
  // Electron main — the runtime never sees the raw DB row. Stubbing a
  // full row here is what let the missing-userId regression slip
  // through: keep this fixture field-for-field pinned to that route.
  function resolvedConnection(overrides = {}) {
    return {
      id: "conn-1",
      backendKind: "CODEX_RUNTIME",
      provider: "OPENAI",
      runtimeProfileRef: RP_A,
      accountIdentity: "first@example.com",
      status: "CONNECTED",
      userId: "user-1",
      ...overrides,
    };
  }

  beforeEach(() => {
    profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
    execWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-exec-"));
    fake = createFakeSpawn();
    manager = createCodexPersistentRuntimeManager({
      spawnImpl: fake.spawnImpl,
      terminateImpl: (child) => child?.kill?.(),
      stableCwd: path.join(execWorkRoot, "codex-persistent"),
      buildInvocation: (input) => codexAdapter.buildStreamingInvocation(input),
    });
    runnerCalls = [];
    version = "0.160.0";
    connection = resolvedConnection();
    backend = {
      resolveTicket: vi.fn(async () => ({
        ok: true,
        operationId: "op_exec_1",
        operation: "executeText",
        backendKind: "CODEX_RUNTIME",
        connection,
      })),
      completeOperation: vi.fn(async () => ({ ok: true })),
    };
    service = createConnectionService({
      profilesRoot,
      smokeWorkRoot: execWorkRoot,
      execWorkRoot,
      backend,
      deps: {
        platform: "win32",
        env: { PATH: "C:\\Windows", USERPROFILE: profilesRoot },
        existsSyncImpl: (candidate) => candidate === FAKE_EXE,
        spawnSyncImpl: (cmd) => {
          if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
          return { status: 0, stdout: `codex-cli ${version}\n`, stderr: "" };
        },
        runner: vi.fn(async (invocation) => {
          runnerCalls.push(invocation);
          if (invocation.args.includes("exec")) {
            fs.writeFileSync(
              path.join(invocation.cwd, "last-message.txt"),
              "summary-text\n",
            );
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
        persistentCodexRuntime: manager,
      },
    });
  });

  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(profilesRoot, { recursive: true, force: true });
    fs.rmSync(execWorkRoot, { recursive: true, force: true });
  });

  function stream(overrides = {}) {
    return service.executeTextStream({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      prompt: "marker-A",
      verificationProbe: true,
      ...overrides,
    });
  }

  it("reports a cold turn then a warm reused turn with distinct threads", async () => {
    const first = await stream({ prompt: "marker-A" });
    const second = await stream({ prompt: "marker-B" });
    expect(first.ok).toBe(true);
    expect(first.text).toBe("echo:marker-A");
    expect(first.runtime.runtimeReuseHit).toBe(false);
    expect(first.runtime.threadReuseHit).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.text).toBe("echo:marker-B");
    expect(second.runtime.runtimeReuseHit).toBe(true);
    expect(second.runtime.runtimeSpawnMs).toBe(0);
    expect(second.runtime.threadReuseHit).toBe(false);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0].threads).toHaveLength(2);
    expect(fake.spawned[0].threads[0]).not.toBe(fake.spawned[0].threads[1]);
    expect(fake.spawned[0].prompts).toEqual(
      expect.arrayContaining(["marker-A", "marker-B"]),
    );
    const cwdNotes = fake.spawned[0].prompts.filter((value) =>
      String(value).includes("codex_runtime-stream"),
    );
    expect(new Set(cwdNotes).size).toBe(2);
  });

  it("isolates prompts across conversations that share a runtime key", async () => {
    const a = await stream({ prompt: "ONLY-A" });
    const b = await stream({ prompt: "ONLY-B" });
    expect(a.text).toBe("echo:ONLY-A");
    expect(b.text).toBe("echo:ONLY-B");
    expect(fake.spawned[0].prompts).toContain("ONLY-A");
    expect(fake.spawned[0].prompts).toContain("ONLY-B");
    expect(fake.spawned[0].prompts.filter((value) => value === "ONLY-A")).toHaveLength(1);
  });

  it("stays one-shot when the resolved projection carries no owner id", async () => {
    // usePool is a security gate, not a convenience: a resolved
    // connection without an authoritative userId must never be pooled —
    // this is the exact regression the internal projection caused.
    connection = resolvedConnection({ userId: undefined });
    const result = await stream();
    expect(result.ok).toBe(false);
    // The turn fell back to the one-shot runner path; no pooled
    // app-server child was spawned and no lease metadata was reported.
    expect(
      runnerCalls.some((call) => call.args.includes("app-server")),
    ).toBe(true);
    expect(fake.spawned).toHaveLength(0);
    expect(result.runtime).toBeUndefined();
  });

  it("does not let summary generation acquire the foreground pool", async () => {
    const foreground = await stream();
    expect(foreground.ok).toBe(true);
    const before = fake.spawned.length;
    const summary = await service.executeText({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      prompt: "summarize the dialogue",
    });
    expect(summary.ok).toBe(true);
    expect(summary.text).toBe("summary-text");
    expect(fake.spawned).toHaveLength(before);
    expect(runnerCalls.some((call) => call.args.includes("exec"))).toBe(true);
    expect(runnerCalls.some((call) => call.args.includes("app-server"))).toBe(false);
  });

  it("sends a second foreground turn to a one-shot process while the pool is busy", async () => {
    fake.setMode("hold");
    const first = stream({ prompt: "ONLY-FIRST" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.inspect().entries[0].busy).toBe(true);
    const second = await stream({
      ticket: "t_exec_2",
      prompt: "ONLY-SECOND",
    });
    expect(second.ok).toBe(false);
    expect(runnerCalls.some((call) => call.args.includes("app-server"))).toBe(true);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0].prompts).toContain("ONLY-FIRST");
    expect(fake.spawned[0].prompts).not.toContain("ONLY-SECOND");
    manager.disposeAll();
    const ended = await first;
    expect(ended.ok).toBe(false);
    expect(ended.code).not.toBe("ABORTED");
  });

  it("retires the pooled process when streaming readiness rejects a new runtime version", async () => {
    const first = await stream();
    expect(first.ok).toBe(true);
    expect(manager.inspect().size).toBe(1);
    version = "0.161.0";
    const blocked = await service.executeTextStream({
      ticket: "t_exec",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
      prompt: "again",
    });
    expect(blocked).toEqual({ ok: false, code: "STREAMING_NOT_VERIFIED" });
    expect(manager.inspect().size).toBe(0);
    expect(fake.spawned[0].child.killed).toBe(true);
  });

  it("retires the pooled process when the connection disconnects", async () => {
    expect((await stream()).ok).toBe(true);
    connection = { ...connection, status: "DISCONNECTED" };
    const blocked = await stream();
    expect(blocked).toEqual({ ok: false, code: "CONNECTION_DISCONNECTED" });
    expect(manager.inspect().size).toBe(0);
    expect(fake.spawned[0].child.killed).toBe(true);
  });

  it("reuses a healthy process for regenerate and refuses reuse after abort", async () => {
    const first = await stream({ prompt: "answer-1" });
    const regenerated = await stream({ prompt: "answer-2" });
    expect(first.runtime.runtimeReuseHit).toBe(false);
    expect(regenerated.runtime.runtimeReuseHit).toBe(true);
    expect(fake.spawned[0].threads).toHaveLength(2);

    fake.setMode("hold");
    const controller = new AbortController();
    const pending = stream({ prompt: "answer-3", signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const aborted = await pending;
    expect(aborted.code).toBe("ABORTED");
    expect(manager.inspect().size).toBe(0);
    fake.setMode("complete");
    const after = await stream({ prompt: "answer-4" });
    expect(after.ok).toBe(true);
    expect(after.runtime.runtimeReuseHit).toBe(false);
    expect(after.runtime.runtimeRestartReason).toBe("abort");
    expect(fake.spawned.filter((child) => !child.child.killed)).toHaveLength(1);
  });

  it("keeps profile refs isolated", async () => {
    await stream();
    connection = {
      ...connection,
      id: "conn-2",
      runtimeProfileRef: RP_B,
      userId: "user-1",
    };
    const other = await stream({ connectionId: "conn-2" });
    expect(other.ok).toBe(true);
    expect(fake.spawned).toHaveLength(2);
    expect(fake.spawned[0].env.CODEX_HOME).not.toBe(fake.spawned[1].env.CODEX_HOME);
  });
});
