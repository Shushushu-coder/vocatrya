// Business TEXT_ONLY execution — desktop side. Verifies the executeText
// operation against fake adapters/runner: ticket redemption, connection
// status re-gate, managed env, fresh Vocatrya cwd, prompt-as-arg, and the
// unified error taxonomy. No real runtime is spawned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

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
  });
  const head = inv.args.join(" ");
  for (const { match, respond } of runnerScript) {
    if (match(head, inv)) return respond(inv);
  }
  throw new Error(`No fake runner response for: ${head}`);
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
      return { status: 0, stdout: "codex-cli 0.154.0\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
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
    // Prompt rides as a plain args element — never inside a shell string.
    expect(inv.args).toContain("Summarize this job");
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
