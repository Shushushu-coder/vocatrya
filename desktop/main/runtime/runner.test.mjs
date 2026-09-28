import { describe, expect, it } from "vitest";
import runner from "./runner.js";

const { runRuntimeCommand, sanitizeRuntimeOutput } = runner;

// Real spawns use node itself (process.execPath) — no provider CLI needed.
const NODE = process.execPath;

describe("runtime command runner", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("never uses a shell: a command string is treated as one filename", async () => {
    // With shell:false the entire string is the executable name — it cannot
    // be interpreted as a command line, so the spawn fails with ENOENT.
    const rejected = await runRuntimeCommand({
      executable: "node -e \"console.log(1)\"",
      args: [],
    });
    expect(rejected.error).toBeTruthy();
    expect(rejected.exitCode).toBeNull();
    // If a shell were involved, `;` would execute a second command — here it
    // is just an argument node sees verbatim.
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", "process.exit(0)", ";", "echo", "pwned"],
    });
    expect(result.exitCode).toBe(0);
  });

  it("times out and terminates the child", async () => {
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  }, 15_000);

  it("aborts via AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runRuntimeCommand({
      executable: NODE,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
  }, 15_000);

  // Visible-console logins (`cmd start /wait`) detach a grandchild that
  // inherits the pipes — killing the parent never produces stdio EOF, so
  // 'close' never fires. After a requested termination the run resolves
  // on 'exit' alone.
  it("resolves on exit after abort when a detached child holds stdio", async () => {
    const controller = new AbortController();
    const promise = runRuntimeCommand({
      executable: NODE,
      args: [
        "-e",
        `const {spawn}=require("child_process");
         const c=spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{detached:true,stdio:"inherit"});
         c.unref();setTimeout(()=>{},60000)`,
      ],
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 750));
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
  }, 15_000);

  it("reports spawn failure without throwing", async () => {
    const result = await runRuntimeCommand({
      executable: "definitely-not-a-real-binary-9f3a2.exe",
      args: [],
    });
    expect(result.error).toBeTruthy();
    expect(result.exitCode).toBeNull();
  });

  it("redacts credential-shaped output by default", async () => {
    const token = `ghp_${"a".repeat(40)}`;
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", `process.stdout.write('token=${token}')`],
    });
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain("[REDACTED]");
  });

  it("sanitizes Bearer headers and token fields", () => {
    expect(sanitizeRuntimeOutput("Authorization: Bearer abcdefghijklmnop1234")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(
      sanitizeRuntimeOutput('{"access_token":"abcdef123456789"}'),
    ).toContain("[REDACTED]");
    expect(sanitizeRuntimeOutput("plain output")).toBe("plain output");
  });
});
