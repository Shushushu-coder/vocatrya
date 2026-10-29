// Prompt transport regression — the Windows argv-length fix. Business
// prompts (resume imports run tens of KB, past the ~32k CreateProcess
// limit) must never be argv elements. These tests prove the shared
// helpers deliver the exact payload through piped stdin or a workDir
// prompt file, end-to-end through real runRuntimeCommand spawns of node
// itself — no provider CLI is ever invoked.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptInput from "./prompt-input.js";
import runner from "./runner.js";

const { promptStdinWriter, writePromptFile } = promptInput;
const { runRuntimeCommand } = runner;

// Real spawns use node itself (process.execPath) — no provider CLI needed.
const NODE = process.execPath;

// ~80 KB — well past the Windows command-line ceiling that produced the
// resume-import spawn ENAMETOOLONG failure.
const LONG_PROMPT = `resume payload ${"界".repeat(40 * 1024)} tail-end`;

// The child echoes stdin back and lets Node exit on its own — an explicit
// process.exit() right after stdout.write() can drop the buffered tail.
// Buffers are concatenated before decode so multibyte characters split
// across OS chunk boundaries survive intact.
const ECHO_STDIN_SCRIPT = `const bufs=[];process.stdin.on("data",(c)=>bufs.push(c));process.stdin.on("end",()=>{process.stdout.write(Buffer.concat(bufs))});`;

describe("promptStdinWriter", () => {
  it("writes the exact payload and ends stdin", () => {
    const stdin = {
      on() {},
      chunks: [],
      ended: false,
      write(c) {
        this.chunks.push(String(c));
      },
      end(c) {
        if (c !== undefined) this.chunks.push(String(c));
        this.ended = true;
      },
    };
    promptStdinWriter(LONG_PROMPT)(stdin);
    expect(stdin.chunks.join("")).toBe(LONG_PROMPT);
    expect(stdin.ended).toBe(true);
  });

  it("never throws on a dead or missing stream (early-exit child)", () => {
    const destroyed = {
      on(event, cb) {
        if (event === "error") cb(new Error("EPIPE"));
      },
      end() {
        throw new Error("EPIPE");
      },
    };
    expect(() => promptStdinWriter("p")(destroyed)).not.toThrow();
    expect(() => promptStdinWriter("p")(null)).not.toThrow();
    expect(() => promptStdinWriter("p")({})).not.toThrow();
  });
});

describe("writePromptFile", () => {
  it("writes the exact prompt inside the workDir and returns its path", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "voc-prompt-"));
    try {
      const promptPath = writePromptFile(workDir, LONG_PROMPT);
      expect(promptPath).toBe(path.join(workDir, "prompt.txt"));
      expect(fs.readFileSync(promptPath, "utf8")).toBe(LONG_PROMPT);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("stdin transport through runRuntimeCommand", () => {
  it("delivers an argv-limit-sized prompt byte-exact, off the command line", async () => {
    // binaryStdout + manual Buffer concat: the runner's default utf8
    // per-chunk decode mangles multibyte characters split across OS
    // chunk boundaries (documented binaryStdout semantics) — irrelevant
    // here, since what is proven is the child receiving the full bytes.
    const buffers = [];
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", ECHO_STDIN_SCRIPT],
      stdinPipe: true,
      onStdinReady: promptStdinWriter(LONG_PROMPT),
      binaryStdout: true,
      sanitize: false,
      onStdout: (chunk) => buffers.push(chunk),
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    // Byte-exact echo — nothing truncated, nothing shell-mangled.
    expect(Buffer.concat(buffers).toString("utf8")).toBe(LONG_PROMPT);
  });

  it("resolves promptly when the child exits before draining stdin", async () => {
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", "process.exit(5)"],
      stdinPipe: true,
      onStdinReady: promptStdinWriter(LONG_PROMPT),
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(5);
  }, 15_000);

  it("timeout terminates a child waiting on stdin — the run does not hang", async () => {
    const result = await runRuntimeCommand({
      executable: NODE,
      args: ["-e", "process.stdin.on('data',()=>{});setTimeout(()=>{},60_000)"],
      stdinPipe: true,
      onStdinReady: () => {}, // prompt never written — child blocks on stdin
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  }, 15_000);

  it("abort terminates a child waiting on stdin — the run does not hang", async () => {
    const controller = new AbortController();
    const promise = runRuntimeCommand({
      executable: NODE,
      args: ["-e", "process.stdin.on('data',()=>{});setTimeout(()=>{},60_000)"],
      stdinPipe: true,
      onStdinReady: promptStdinWriter("partial prompt never drained"),
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
  }, 15_000);
});
