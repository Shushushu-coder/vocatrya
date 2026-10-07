// @vitest-environment node
/**
 * resolve → usePool boundary regression — the Phase-4B miss.
 *
 * This spec wires the REAL internal resolve route handler
 * (src/app/api/internal/ai-connections/resolve/route.ts) in front of the
 * REAL desktop connection-service + Codex persistent pool. Earlier
 * coverage stubbed resolveTicket with a full DB row (which always carried
 * userId), so the missing-projection regression shipped green. Here the
 * desktop consumes exactly the JSON the route produces: if the projection
 * ever drops `userId` again, `usePool` fails closed and the second
 * streaming call would spawn a fresh one-shot app-server instead of
 * reusing the pooled child — and this test fails.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { POST as resolvePOST } from "@/app/api/internal/ai-connections/resolve/route";
import {
  mintConnectionTicket,
  resetConnectionTickets,
} from "@/lib/ai/connection-tickets";

const require = createRequire(import.meta.url);
const DESKTOP_RUNTIME = path.resolve(process.cwd(), "desktop/main/runtime");
const { createConnectionService } = require(
  path.join(DESKTOP_RUNTIME, "connection-service.js"),
);
const { createCodexPersistentRuntimeManager } = require(
  path.join(DESKTOP_RUNTIME, "codex-persistent-runtime.js"),
);
const { codexAdapter } = require(path.join(DESKTOP_RUNTIME, "codex.js"));

const TOKEN = "test-internal-token";
const FAKE_EXE = "C:\\fake\\codex.exe";
const RP = "rp_11111111-1111-4111-8111-111111111111";

const store = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    aIConnection: {
      findUnique: store.findUnique,
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const req = (body: unknown) =>
  ({
    json: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : null,
    },
  }) as any;

function connRow() {
  return {
    id: "c1",
    userId: "user-1",
    provider: "OPENAI",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CODEX_RUNTIME",
    displayName: "ChatGPT via Codex",
    accountIdentity: "first@example.com",
    status: "CONNECTED",
    credentialRef: null,
    runtimeProfileRef: RP,
    lastVerifiedAt: null,
    archivedAt: null,
    createdAt: new Date(),
  };
}

// Minimal fake app-server child: answers the initialize → thread/start →
// turn/start JSON-RPC handshake, then completes each turn with a delta +
// item/completed + turn/completed carrying `echo:<prompt>`.
function createFakeAppServerSpawn() {
  const spawned: Array<{ pid: number; child: any; args: string[]; cwd: string }> = [];
  let nextPid = 9400;
  function spawnImpl(_exe: string, args: string[], opts: any) {
    const child: any = new EventEmitter();
    child.pid = ++nextPid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const emit = (msg: unknown) =>
      child.stdout.emit("data", Buffer.from(`${JSON.stringify(msg)}\n`));
    let buf = "";
    let threadSeq = 0;
    child.stdin = {
      destroyed: false,
      write(chunk: string) {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.id === undefined) continue; // `initialized` notification
          if (msg.method === "initialize") {
            emit({ id: msg.id, result: {} });
          } else if (msg.method === "thread/start") {
            emit({
              id: msg.id,
              result: { thread: { id: `thr_${child.pid}_${++threadSeq}` } },
            });
          } else if (msg.method === "turn/start") {
            const text = msg.params?.input?.[0]?.text ?? "";
            emit({
              id: msg.id,
              result: { turn: { id: `turn_${threadSeq}`, status: "inProgress" } },
            });
            emit({
              method: "item/agentMessage/delta",
              params: { itemId: "i1", delta: `echo:${text}` },
            });
            emit({
              method: "item/completed",
              params: {
                item: { id: "i1", type: "agentMessage", text: `echo:${text}` },
              },
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
    spawned.push({ pid: child.pid, child, args, cwd: opts?.cwd });
    return child;
  }
  return { spawnImpl, spawned };
}

describe("internal resolve → desktop streaming bridge (production shape)", () => {
  let profilesRoot: string;
  let workRoot: string;
  let fake: ReturnType<typeof createFakeAppServerSpawn>;
  let manager: any;
  let service: any;
  let backend: any;
  let runnerCalls: any[];

  beforeEach(() => {
    resetConnectionTickets();
    process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN = TOKEN;
    store.findUnique.mockReset();
    store.findUnique.mockResolvedValue(connRow());
    profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-exec-"));
    fake = createFakeAppServerSpawn();
    manager = createCodexPersistentRuntimeManager({
      spawnImpl: fake.spawnImpl,
      terminateImpl: (child: any) => child?.kill?.(),
      stableCwd: path.join(workRoot, "codex-persistent"),
      buildInvocation: (input: unknown) =>
        codexAdapter.buildStreamingInvocation(input),
    });
    runnerCalls = [];
    // The desktop's backend.resolveTicket is the loopback client; here it
    // hits the real route handler — the response the runtime consumes is
    // the production projection, field for field.
    backend = {
      resolveTicket: vi.fn(async (ticket: string) =>
        (await resolvePOST(req({ ticket }))).json(),
      ),
      completeOperation: vi.fn(async () => ({ ok: true })),
    };
    service = createConnectionService({
      profilesRoot,
      smokeWorkRoot: workRoot,
      execWorkRoot: workRoot,
      backend,
      deps: {
        platform: "win32",
        env: { PATH: "C:\\Windows", USERPROFILE: profilesRoot },
        existsSyncImpl: (candidate: string) => candidate === FAKE_EXE,
        spawnSyncImpl: (cmd: string) =>
          cmd === "where.exe"
            ? { status: 0, stdout: `${FAKE_EXE}\r\n` }
            : { status: 0, stdout: "codex-cli 0.160.0\n", stderr: "" },
        runner: vi.fn(async (invocation: unknown) => {
          runnerCalls.push(invocation);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
        persistentCodexRuntime: manager,
      },
    });
  });

  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(profilesRoot, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
    delete process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
  });

  const mintStreamTicket = () =>
    mintConnectionTicket({
      userId: "user-1",
      operation: "executeText",
      backendKind: "CODEX_RUNTIME",
      connectionId: "c1",
    }).ticket;

  const stream = (prompt: string) =>
    service.executeTextStream({
      ticket: mintStreamTicket(),
      connectionId: "c1",
      model: "gpt-5.6-sol",
      prompt,
    });

  it("a resolved connection with its owner id enters the pool and the second stream reuses the same child", async () => {
    // Route sanity: the runtime-facing projection carries the owner id.
    const ticket = mintStreamTicket();
    const probe = await (
      await resolvePOST(req({ ticket }))
    ).json();
    expect(probe.connection.userId).toBe("user-1");

    const first = await stream("marker-A");
    const second = await stream("marker-B");
    expect(first.ok).toBe(true);
    expect(first.text).toBe("echo:marker-A");
    expect(first.runtime.runtimeReuseHit).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.text).toBe("echo:marker-B");
    expect(second.runtime.runtimeReuseHit).toBe(true);
    expect(second.runtime.runtimeSpawnMs).toBe(0);
    expect(second.runtime.runtimeInitMs).toBe(0);
    // Same pooled PID — and no fresh one-shot app-server child on the
    // idle hit (the one-shot runner lane is never entered).
    expect(second.runtime.runtimeProcessId).toBe(
      first.runtime.runtimeProcessId,
    );
    expect(fake.spawned).toHaveLength(1);
    expect(runnerCalls).toHaveLength(0);
    // Each Vocatrya turn still opens a fresh Codex thread — process reuse
    // is never conversation-context reuse.
    expect(second.runtime.threadReuseHit).toBe(false);
  });
});
