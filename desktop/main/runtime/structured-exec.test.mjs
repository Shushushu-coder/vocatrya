// Structured-output desktop seam tests — adapter invocation wiring for the
// native-schema runtimes, the execute endpoint's structuredOutput payload
// validation, and connection-service strategy selection. No runtime is
// spawned: everything exercises argv construction and payload handling.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import codex from "./codex.js";
import claude from "./claude.js";
import grok from "./grok.js";
import opencode from "./opencode.js";
import cursor from "./cursor.js";
import devin from "./devin.js";
import structuredSchema from "./structured-schema.js";
import executeServer from "./execute-server.js";

const { codexAdapter } = codex;
const { buildClaudeStructuredInvocation, claudeAdapter, parseClaudePrintResult } =
  claude;
const { buildGrokStructuredInvocation, grokAdapter } = grok;
const { serializeInlineSchema } = structuredSchema;

const BASE = {
  executablePath: "C:\\fake\\bin.exe",
  profileDir: "C:\\profiles\\rp_x",
  baseEnv: {},
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voc-struct-test-"));
}

describe("codex structured invocation", () => {
  it("writes the schema into the exec workDir and passes --output-schema", () => {
    const workDir = tmpDir();
    const inv = codexAdapter.buildStructuredInvocation({
      ...BASE,
      workingDirectory: workDir,
      model: "gpt-5",
      prompt: "task",
      schema: SCHEMA,
      schemaName: "Probe Schema",
    });
    const schemaIdx = inv.args.indexOf("--output-schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaPath = inv.args[schemaIdx + 1];
    expect(schemaPath.startsWith(workDir)).toBe(true);
    expect(schemaPath.endsWith("Probe_Schema.schema.json")).toBe(true);
    expect(JSON.parse(fs.readFileSync(schemaPath, "utf8"))).toEqual(SCHEMA);
    expect(inv.cwd).toBe(workDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("keeps the safety flags and the prompt last", () => {
    const workDir = tmpDir();
    const inv = codexAdapter.buildStructuredInvocation({
      ...BASE,
      workingDirectory: workDir,
      prompt: "the task",
      schema: SCHEMA,
      schemaName: "s",
    });
    expect(inv.args).toContain("-s");
    expect(inv.args).toContain("read-only");
    expect(inv.args).toContain("--ephemeral");
    expect(inv.args[inv.args.length - 1]).toBe("the task");
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("materializes canonical resume import schema into workDir and wires --output-schema", () => {
    const workDir = tmpDir();
    const resumeSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        profile: { type: "object" },
        profileSourceText: { type: ["string", "null"] },
        sections: { type: "array" },
      },
      required: ["profile", "profileSourceText", "sections"],
      additionalProperties: false,
    };
    const inv = codexAdapter.buildStructuredInvocation({
      ...BASE,
      workingDirectory: workDir,
      model: "gpt-5.6-sol",
      prompt: "Extract resume into schema",
      schema: resumeSchema,
      schemaName: "canonical_resume_import",
    });
    const schemaIdx = inv.args.indexOf("--output-schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaPath = inv.args[schemaIdx + 1];
    expect(schemaPath).toBe(
      path.join(workDir, "canonical_resume_import.schema.json"),
    );
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(schemaPath, "utf8"))).toEqual(resumeSchema);
    expect(inv.args).toContain("-m");
    expect(inv.args).toContain("gpt-5.6-sol");
    expect(inv.args[inv.args.length - 1]).toBe("Extract resume into schema");
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

describe("claude structured invocation", () => {
  it("adds --json-schema inline before the prompt", () => {
    const inv = buildClaudeStructuredInvocation({
      ...BASE,
      workingDirectory: tmpDir(),
      model: "sonnet",
      prompt: "the task",
      schema: SCHEMA,
      schemaName: "s",
    });
    const idx = inv.args.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(inv.args[idx + 1])).toEqual(SCHEMA);
    expect(inv.args[inv.args.length - 1]).toBe("the task");
    // The existing safety flags are untouched.
    expect(inv.args).toContain("--tools");
    expect(inv.args).toContain("--permission-mode");
  });

  it("rejects schemas over the inline argv budget", () => {
    try {
      buildClaudeStructuredInvocation({
        ...BASE,
        workingDirectory: tmpDir(),
        prompt: "t",
        schema: { type: "string", description: "x".repeat(20 * 1024) },
        schemaName: "big",
      });
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe("STRUCTURED_OUTPUT_UNSUPPORTED");
    }
  });

  it("extracts structured_output over the result envelope", () => {
    const out = parseClaudePrintResult({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { name: "Mira" },
      }),
      stderr: "",
    });
    expect(out.text).toBe('{"name":"Mira"}');
    expect(out.reportedError).toBe(false);
  });

  it("still returns result text when no structured_output exists", () => {
    const out = parseClaudePrintResult({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "hi" }),
      stderr: "",
    });
    expect(out.text).toBe("hi");
  });

  it("flags error subtypes as reported errors", () => {
    const out = parseClaudePrintResult({
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: false,
        result: "",
      }),
      stderr: "",
    });
    expect(out.reportedError).toBe(true);
  });
});

describe("grok structured invocation", () => {
  it("appends --json-schema inline", () => {
    const inv = buildGrokStructuredInvocation({
      ...BASE,
      workingDirectory: tmpDir(),
      model: "grok-4.7",
      prompt: "task",
      schema: SCHEMA,
      schemaName: "s",
    });
    const idx = inv.args.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(inv.args[idx + 1])).toEqual(SCHEMA);
    expect(inv.args).toContain("--output-format");
    expect(inv.args).toContain("--tools");
  });
});

describe("serializeInlineSchema", () => {
  it("serializes small schemas", () => {
    expect(JSON.parse(serializeInlineSchema(SCHEMA))).toEqual(SCHEMA);
  });
  it("throws a coded error when over budget", () => {
    try {
      serializeInlineSchema({ type: "string", description: "x".repeat(20 * 1024) });
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe("STRUCTURED_OUTPUT_UNSUPPORTED");
    }
  });
});

describe("execute-server structuredOutput payload", () => {
  const { startExecutionServer } = executeServer;

  function post(port, body) {
    return fetch(`http://127.0.0.1:${port}/internal/ai-connections/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
      },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  const basePayload = {
    ticket: "t",
    connectionId: "c",
    model: "m",
    prompt: "p",
    permissionScope: "TEXT_ONLY",
  };

  async function withServer(service, fn) {
    const { server, port } = await startExecutionServer({
      token: "tok",
      service,
    });
    try {
      await fn(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("forwards a valid structuredOutput payload to executeText", async () => {
    let seen = null;
    await withServer(
      {
        executeText: async (input) => {
          seen = input;
          return { ok: true, text: "{}", structuredStrategy: "NATIVE_JSON_SCHEMA" };
        },
      },
      async (port) => {
        const res = await post(port, {
          ...basePayload,
          structuredOutput: { schema: SCHEMA, schemaName: "Probe" },
        });
        expect(res.ok).toBe(true);
        expect(seen.structuredOutput).toEqual({ schema: SCHEMA, schemaName: "Probe" });
      },
    );
  });

  it("rejects malformed structuredOutput shapes", async () => {
    await withServer(
      { executeText: async () => ({ ok: true, text: "{}" }) },
      async (port) => {
        for (const bad of [
          { schemaName: "x" }, // no schema
          { schema: "not-an-object", schemaName: "x" },
          { schema: SCHEMA }, // no schemaName
          { schema: SCHEMA, schemaName: "x", extra: 1 },
          { schema: SCHEMA, schemaName: "x".repeat(200) },
          "string",
        ]) {
          const res = await post(port, { ...basePayload, structuredOutput: bad });
          expect(res.code).toBe("INVALID_PAYLOAD");
        }
      },
    );
  });

  it("rejects an oversized schema", async () => {
    await withServer(
      { executeText: async () => ({ ok: true, text: "{}" }) },
      async (port) => {
        const res = await post(port, {
          ...basePayload,
          structuredOutput: {
            schema: { type: "string", description: "x".repeat(70 * 1024) },
            schemaName: "big",
          },
        });
        expect(res.code).toBe("INVALID_PAYLOAD");
      },
    );
  });

  it("omits structuredOutput cleanly when absent", async () => {
    let seen = null;
    await withServer(
      {
        executeText: async (input) => {
          seen = input;
          return { ok: true, text: "{}" };
        },
      },
      async (port) => {
        await post(port, basePayload);
        expect(seen.structuredOutput).toBeUndefined();
      },
    );
  });
});

describe("adapter structured support", () => {
  it("codex/claude/grok expose buildStructuredInvocation; prompt-only runtimes do not", () => {
    expect(typeof codexAdapter.buildStructuredInvocation).toBe("function");
    expect(typeof claudeAdapter.buildStructuredInvocation).toBe("function");
    expect(typeof grokAdapter.buildStructuredInvocation).toBe("function");
    expect(opencode.opencodeAdapter.buildStructuredInvocation).toBeUndefined();
    expect(cursor.cursorAdapter.buildStructuredInvocation).toBeUndefined();
    expect(devin.devinAdapter.buildStructuredInvocation).toBeUndefined();
  });
});
