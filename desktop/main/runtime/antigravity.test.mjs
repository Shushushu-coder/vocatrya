import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import adapter from "./antigravity.js";

const {
  antigravityAdapter,
  buildAntigravityLoginInvocation,
  buildAntigravityLogoutInvocation,
  buildAntigravityPrintInvocation,
  classifyAntigravityAuthError,
  resolveAntigravityExecutable,
  runAntigravityAcpAuthProbe,
} = adapter;

// A fake `agy acp` child: emits a JSON response for each inbound request
// the responder returns, and stays alive until killed like the real
// long-lived ACP server.
function fakeAgyAcpSpawn({ spawnImpl, child }) {
  const sink = new Writable({
    write(chunk, _enc, done) {
      const line = String(chunk).trim();
      if (line) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          done();
          return;
        }
        const response = child.responder(msg);
        if (response) {
          setImmediate(() => {
            child.stdout.emit(
              "data",
              Buffer.from(`${JSON.stringify(response)}\n`),
            );
          });
        }
      }
      done();
    },
  });
  child.stdin = sink;
  sink.end = () => {};
  const terminateCalls = [];
  const terminateImpl = () => {
    terminateCalls.push(child);
    return Promise.resolve();
  };
  const spawn = (...args) => {
    spawnImpl.calls.push(args);
    return child;
  };
  return { spawn, terminateImpl, terminateCalls };
}

function makeAgyChild(responder) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.responder = responder;
  child.stdin = null;
  return child;
}

function probeWith(child, extra = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
  const spawnState = { calls: [] };
  const { spawn, terminateImpl, terminateCalls } = fakeAgyAcpSpawn({
    spawnImpl: spawnState,
    child,
  });
  const result = runAntigravityAcpAuthProbe({
    executablePath: "C:\\agy\\agy.exe",
    profileDir,
    baseEnv: { PATH: "C:\\Windows" },
    spawnImpl: spawn,
    terminateImpl,
    ...extra,
  });
  return { profileDir, result, spawnState, terminateCalls };
}

describe("antigravity adapter", () => {
  it("resolves only an existing agy.exe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
    const exe = path.join(dir, "agy.exe");
    fs.writeFileSync(exe, "");
    expect(resolveAntigravityExecutable(exe)).toBe(exe);
    expect(resolveAntigravityExecutable(path.join(dir, "agy.cmd"))).toBe(exe);
    expect(resolveAntigravityExecutable(path.join(dir, "missing.exe"))).toBe(
      null,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("launches interactive login and does not log out via a fake subcommand", () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
    const login = buildAntigravityLoginInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows", GEMINI_API_KEY: "secret" },
    });
    expect(login.executable).toBe("cmd.exe");
    expect(login.args).toContain("acp");
    expect(login.args).toContain("--login");
    // --app-data-dir must stay a relative directory name (an absolute
    // value crashes agy's lazily-started language server on 1.5.14).
    const appDataIdx = login.args.indexOf("--app-data-dir");
    expect(appDataIdx).toBeGreaterThan(-1);
    expect(login.args[appDataIdx + 1]).toBe("antigravity-cli");
    expect(path.isAbsolute(login.args[appDataIdx + 1])).toBe(false);
    // --gemini-dir stays absolute, under the managed home.
    const geminiIdx = login.args.indexOf("--gemini-dir");
    expect(path.isAbsolute(login.args[geminiIdx + 1])).toBe(true);
    expect(login.env.GEMINI_API_KEY).toBeUndefined();
    expect(login.env.USERPROFILE).toBe(path.join(profileDir, "home"));

    const logout = buildAntigravityLogoutInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows" },
    });
    expect(logout.args).toEqual(["--version"]);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("keeps the print prompt off argv", () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "agy-work-"));
    const prompt = "VOCATRYA_ANTIGRAVITY_OK";
    const invocation = buildAntigravityPrintInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows", GOOGLE_API_KEY: "secret" },
      workingDirectory: work,
      model: "gemini-3.8-flash-low",
      prompt,
    });
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(invocation.env.GOOGLE_API_KEY).toBeUndefined();
    expect(invocation.cwd).toBe(work);
    const chunks = [];
    invocation.onStdinReady({
      on() {},
      end(value) {
        chunks.push(String(value));
      },
    });
    expect(chunks.join("")).toBe(prompt);
    expect(
      antigravityAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "API_KEY",
      }),
    ).toBe("UNSUPPORTED_AUTH_METHOD");
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
});

describe("runAntigravityAcpAuthProbe", () => {
  const initializeOk = {
    protocolVersion: 1,
    authMethods: [
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "oauth-business" },
      { id: "gemini-api-key" },
    ],
  };

  it("classifies a successful authenticate(oauth-personal) as GOOGLE_ACCOUNT", async () => {
    const child = makeAgyChild((msg) =>
      msg.method === "initialize"
        ? { jsonrpc: "2.0", id: msg.id, result: initializeOk }
        : msg.method === "authenticate"
          ? {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                _meta: {
                  antigravity: {
                    tier: { id: "free-tier", name: "Antigravity Free" },
                  },
                },
              },
            }
          : null,
    );
    const { profileDir, result, spawnState, terminateCalls } =
      probeWith(child);
    const status = await result;
    expect(status).toEqual({
      authState: "AUTHENTICATED",
      authKind: "GOOGLE_ACCOUNT",
      authMethod: "oauth",
      accountIdentity: null,
      providerMetadata: {
        authMethodId: "oauth-personal",
        tierId: "free-tier",
        tierName: "Antigravity Free",
      },
    });
    const [exe, args] = spawnState.calls[0];
    expect(exe).toBe("C:\\agy\\agy.exe");
    expect(args[0]).toBe("acp");
    expect(args).toContain("--gemini-dir");
    const idx = args.indexOf("--app-data-dir");
    expect(args[idx + 1]).toBe("antigravity-cli");
    expect(terminateCalls).toHaveLength(1);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("fails closed as NOT_AUTHENTICATED when authenticate() errors auth", async () => {
    const child = makeAgyChild((msg) =>
      msg.method === "initialize"
        ? { jsonrpc: "2.0", id: msg.id, result: initializeOk }
        : {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "not authenticated" },
          },
    );
    const { profileDir, result } = probeWith(child);
    expect((await result).authState).toBe("NOT_AUTHENTICATED");
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("bounds a held authenticate() (interactive loopback) as NOT_AUTHENTICATED", async () => {
    const child = makeAgyChild((msg) =>
      msg.method === "initialize"
        ? { jsonrpc: "2.0", id: msg.id, result: initializeOk }
        : null, // authenticate never answers — the loopback took over
    );
    const { profileDir, result, terminateCalls } = probeWith(child, {
      timeoutMs: 60,
    });
    const status = await result;
    expect(status.authState).toBe("NOT_AUTHENTICATED");
    // The process tree (including a launched browser) is torn down.
    expect(terminateCalls).toHaveLength(1);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("fails closed as UNKNOWN when initialize fails", async () => {
    const child = makeAgyChild(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "invalid request" },
    }));
    const { profileDir, result } = probeWith(child);
    expect((await result).authState).toBe("UNKNOWN");
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("fails closed as UNKNOWN when the stream is not ACP JSON", async () => {
    const child = makeAgyChild(() => null);
    const { profileDir, result } = probeWith(child, { timeoutMs: 5_000 });
    const promise = result;
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("Loading Antigravity...\n"));
    });
    expect((await promise).authState).toBe("UNKNOWN");
    fs.rmSync(profileDir, { recursive: true, force: true });
  });
});

describe("classifyAntigravityAuthError", () => {
  it("distinguishes reauth, no-credential, and unknown failures", () => {
    expect(
      classifyAntigravityAuthError({
        code: -32000,
        message: "token expired",
      }),
    ).toBe("REAUTH_REQUIRED");
    expect(
      classifyAntigravityAuthError({
        code: -32000,
        message: "no cached credential",
      }),
    ).toBe("NOT_AUTHENTICATED");
    expect(classifyAntigravityAuthError({ code: -32601 })).toBe("UNKNOWN");
  });
});
