import { describe, expect, it } from "vitest";
import {
  buildStructuredOutputPrompt,
  buildStructuredOutputRetryPrompt,
  findUnsupportedSchemaKeys,
  normalizeStructuredText,
  parseStructuredText,
  runStructuredValidation,
  runStructuredValidationSuite,
  summarizeValidationIssues,
  validateStructuredValue,
  type StructuredExecuteFn,
  type StructuredOutputSchema,
} from "@/lib/ai/structured-output";
import {
  STRUCTURED_VALIDATION_SCHEMAS,
  STRUCTURED_VALIDATION_TRIALS,
} from "@/lib/ai/structured-validation-fixtures";
import { checkStructuredOutputReadiness } from "@/lib/ai/runtime/capabilities";

const S1 = STRUCTURED_VALIDATION_SCHEMAS.S1_FLAT.schema;
const S2 = STRUCTURED_VALIDATION_SCHEMAS.S2_JOB_DESCRIPTION_LIKE.schema;
const S3 = STRUCTURED_VALIDATION_SCHEMAS.S3_RESUME_LIKE.schema;

describe("normalizeStructuredText", () => {
  it("passes through clean JSON", () => {
    expect(normalizeStructuredText('{"a":1}')).toBe('{"a":1}');
  });

  it("strips a UTF-8 BOM and surrounding whitespace", () => {
    expect(normalizeStructuredText("﻿  {\"a\":1}\n")).toBe('{"a":1}');
  });

  it("unwraps a single outer ```json fence", () => {
    expect(normalizeStructuredText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(normalizeStructuredText('```\n{"a":1}\n```\n\n')).toBe('{"a":1}');
  });

  it("does NOT unwrap a fence with commentary around it", () => {
    const raw = 'Here is the JSON:\n```json\n{"a":1}\n```';
    expect(normalizeStructuredText(raw)).toBe(raw);
  });

  it("does NOT repair an unclosed fence", () => {
    const raw = '```json\n{"a":1}';
    expect(normalizeStructuredText(raw)).toBe(raw);
  });
});

describe("parseStructuredText", () => {
  it("parses plain JSON", () => {
    const res = parseStructuredText('{"name":"x","score":1,"status":"PASS"}');
    expect(res.ok).toBe(true);
  });

  it("rejects commentary before JSON", () => {
    const res = parseStructuredText('Here is the requested JSON: {"a":1}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("STRUCTURED_OUTPUT_PARSE_FAILED");
  });

  it("rejects trailing explanation", () => {
    const res = parseStructuredText('{"a":1}\nDone.');
    expect(res.ok).toBe(false);
  });

  it("rejects two JSON objects", () => {
    const res = parseStructuredText('{"a":1}{"b":2}');
    expect(res.ok).toBe(false);
  });
});

describe("findUnsupportedSchemaKeys", () => {
  it("accepts all three fixture schemas", () => {
    for (const entry of Object.values(STRUCTURED_VALIDATION_SCHEMAS)) {
      expect(findUnsupportedSchemaKeys(entry.schema)).toEqual([]);
    }
  });

  it("rejects oneOf/$ref/pattern", () => {
    const schema: StructuredOutputSchema = {
      type: "object",
      properties: {
        a: { oneOf: [{ type: "string" }, { type: "null" }] },
        b: { type: "string", pattern: "^x" },
      },
    };
    const bad = findUnsupportedSchemaKeys(schema);
    expect(bad.join(" ")).toContain("oneOf");
    expect(bad.join(" ")).toContain("pattern");
  });

  it("rejects tuple-form items and malformed constraint shapes", () => {
    const schema: StructuredOutputSchema = {
      type: "object",
      properties: {
        a: { type: "array", items: [{ type: "string" }] },
        b: { type: "string" },
      },
      required: "a",
    };
    const bad = findUnsupportedSchemaKeys(schema).join(" ");
    expect(bad).toContain("items(shape)");
    expect(bad).toContain("required(shape)");
  });
});

describe("validateStructuredValue", () => {
  it("accepts a conforming S1 object", () => {
    expect(
      validateStructuredValue(
        { name: "Mira Solen", score: 82, status: "PASS" },
        S1,
      ),
    ).toEqual([]);
  });

  it("flags missing required, wrong enum, wrong primitive, additional property", () => {
    const issues = validateStructuredValue(
      { name: "x", score: "82", status: "OK", extra: 1 },
      S1,
    );
    const flat = issues.map((i) => `${i.path} ${i.message}`).join(";");
    expect(flat).toContain("expected integer");
    expect(flat).toContain("not in enum");
    expect(flat).toContain("$.extra additional property");
    const missing = validateStructuredValue({ name: "x", score: 1 }, S1);
    expect(
      missing.some((i) => i.message === 'missing required "status"'),
    ).toBe(true);
  });

  it("flags nested + array item violations in S2", () => {
    const value = {
      jobTitle: "FE",
      company: "Brightloop",
      locations: ["Remote"],
      employmentType: "CONTRACT",
      requirements: [{ type: "OPTIONAL", text: "x" }],
      skills: ["ts"],
      experienceYears: "five",
    };
    const issues = validateStructuredValue(value, S2);
    const flat = issues.map((i) => i.path).join(";");
    expect(flat).toContain("$.requirements[0].type");
    expect(flat).toContain("$.experienceYears");
  });

  it("accepts null for nullable fields", () => {
    const value = {
      jobTitle: "FE",
      company: "B",
      locations: [],
      employmentType: "FULL_TIME",
      requirements: [],
      skills: [],
      experienceYears: null,
    };
    expect(validateStructuredValue(value, S2)).toEqual([]);
  });

  it("enforces nested additionalProperties=false in S3", () => {
    const value = {
      candidateName: "Dana",
      summary: "s",
      skills: [],
      experiences: [
        { company: "C", title: "T", bullets: ["b"], surprise: true },
      ],
      education: [],
      warnings: [],
    };
    const issues = validateStructuredValue(value, S3);
    expect(issues.some((i) => i.path === "$.experiences[0].surprise")).toBe(
      true,
    );
  });
});

describe("summarizeValidationIssues", () => {
  it("emits field paths, not raw output", () => {
    const s = summarizeValidationIssues(
      [
        { path: "$.a", message: "missing" },
        { path: "$.b", message: "bad enum" },
      ],
      6,
    );
    expect(s).toBe("$.a: missing; $.b: bad enum");
  });
});

describe("prompt builders", () => {
  it("embeds the schema and output contract", () => {
    const p = buildStructuredOutputPrompt({
      prompt: "Task.",
      schema: S1,
      schemaName: "VocatryaScreeningResult",
    });
    expect(p).toContain("Task.");
    expect(p).toContain('"name"');
    expect(p).toContain("VocatryaScreeningResult");
  });

  it("retry prompt carries validator issue paths only", () => {
    const p = buildStructuredOutputRetryPrompt({
      prompt: "Task.",
      schema: S1,
      schemaName: "S1",
      issues: [{ path: "$.score", message: "expected integer" }],
    });
    expect(p).toContain("$.score: expected integer");
    expect(p).toContain("Return only the corrected JSON object");
  });
});

// ---------------------------------------------------------------------------
// State machine — injected execute so no real runtime is needed. Mocked
// models never set verification=PASS anywhere; these tests pin the
// mechanics only.
// ---------------------------------------------------------------------------

function fakeExecute(
  outcomes: Awaited<ReturnType<StructuredExecuteFn>>[],
): { fn: StructuredExecuteFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: StructuredExecuteFn = async ({ prompt, attempt }) => {
    calls.push(`attempt${attempt}:${prompt}`);
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    return outcome;
  };
  return { fn, calls };
}

const VALID_S1 = '{"name":"Mira Solen","score":82,"status":"PASS"}';

describe("runStructuredValidation", () => {
  it("primary valid → 1 call, VALID", async () => {
    const { fn, calls } = fakeExecute([
      { ok: true, text: VALID_S1, structuredStrategy: "PROMPT_AND_VALIDATE" },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("VALID");
    expect(res.firstPassValid).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("prompt-only: primary invalid + retry valid → VALID_AFTER_RETRY, 2 calls", async () => {
    const { fn, calls } = fakeExecute([
      { ok: true, text: '{"name":"x"}', structuredStrategy: "PROMPT_AND_VALIDATE" },
      { ok: true, text: VALID_S1, structuredStrategy: "PROMPT_AND_VALIDATE" },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("VALID_AFTER_RETRY");
    expect(res.validAfterRetry).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("failed local schema validation");
  });

  it("prompt-only: invalid + invalid → RETRY_EXHAUSTED, 2 calls max", async () => {
    const { fn, calls } = fakeExecute([
      { ok: true, text: "not json", structuredStrategy: "PROMPT_AND_VALIDATE" },
      { ok: true, text: '{"name":1}', structuredStrategy: "PROMPT_AND_VALIDATE" },
      { ok: true, text: VALID_S1, structuredStrategy: "PROMPT_AND_VALIDATE" },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("STRUCTURED_OUTPUT_RETRY_EXHAUSTED");
    expect(calls).toHaveLength(2);
  });

  it("native strategy: schema violation is terminal — no retry", async () => {
    const { fn, calls } = fakeExecute([
      { ok: true, text: '{"name":"x"}', structuredStrategy: "NATIVE_JSON_SCHEMA" },
      { ok: true, text: VALID_S1, structuredStrategy: "NATIVE_JSON_SCHEMA" },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION");
    expect(res.nativeViolation).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("execution failure → EXECUTION_FAILED, no retry", async () => {
    const { fn, calls } = fakeExecute([
      { ok: false, code: "INFERENCE_FAILED" },
      { ok: true, text: VALID_S1 },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("EXECUTION_FAILED");
    expect(calls).toHaveLength(1);
  });

  it("length-limited stop reason → TRUNCATED not generic parse failure", async () => {
    const { fn } = fakeExecute([
      {
        ok: true,
        text: '{"name":"x","score":8',
        structuredStrategy: "PROMPT_AND_VALIDATE",
        stopReason: "max_tokens",
      },
      {
        ok: true,
        text: '{"name":"x","score":',
        structuredStrategy: "PROMPT_AND_VALIDATE",
        stopReason: "max_tokens",
      },
    ]);
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: fn,
    });
    expect(res.status).toBe("STRUCTURED_OUTPUT_TRUNCATED");
    expect(res.attempts[0].outcome).toBe("TRUNCATED");
  });

  it("execute throwing is contained as EXECUTION_FAILED", async () => {
    const res = await runStructuredValidation({
      prompt: "t",
      schema: S1,
      schemaName: "S1",
      execute: async () => {
        throw new Error("boom");
      },
    });
    expect(res.status).toBe("EXECUTION_FAILED");
  });
});

describe("runStructuredValidationSuite", () => {
  it("rejects an out-of-subset schema without calling the model", async () => {
    const { fn, calls } = fakeExecute([{ ok: true, text: "{}" }]);
    const res = await runStructuredValidationSuite({
      trials: [
        {
          fixtureId: "bad",
          schemaId: "BAD",
          schemaName: "Bad",
          prompt: "t",
          schema: { type: "object", properties: { a: { anyOf: [] } } },
        },
      ],
      execute: fn,
    });
    expect(res.trials[0].status).toBe("STRUCTURED_OUTPUT_UNSUPPORTED");
    expect(calls).toHaveLength(0);
  });

  it("runs 9 fixtures with a fixed ≤1 retry budget", async () => {
    const { fn } = fakeExecute([
      { ok: true, text: VALID_S1, structuredStrategy: "PROMPT_AND_VALIDATE" },
    ]);
    const res = await runStructuredValidationSuite({
      trials: STRUCTURED_VALIDATION_TRIALS,
      execute: fn,
    });
    expect(res.totals.trials).toBe(9);
    expect(res.totals.calls).toBeLessThanOrEqual(18);
  });
});

describe("checkStructuredOutputReadiness", () => {
  const caps = (over: object) => ({
    backendKind: "X",
    implemented: true,
    structuredOutput: {
      strategy: "PROMPT_AND_VALIDATE",
      mechanism: null,
      verification: "PENDING",
      verifiedRuntimeVersion: null,
      ...over,
    },
  });

  it("unimplemented/unknown runtimes are NOT_ELIGIBLE", () => {
    expect(checkStructuredOutputReadiness({ capabilities: null })).toBe(
      "NOT_ELIGIBLE",
    );
    expect(
      checkStructuredOutputReadiness({
        capabilities: { ...caps({}), implemented: false } as never,
      }),
    ).toBe("NOT_ELIGIBLE");
  });

  it("UNSUPPORTED strategy is NOT_ELIGIBLE", () => {
    expect(
      checkStructuredOutputReadiness({
        capabilities: caps({ strategy: "UNSUPPORTED" }) as never,
      }),
    ).toBe("NOT_ELIGIBLE");
  });

  it("PENDING verification is PENDING, FAIL is NOT_ELIGIBLE", () => {
    expect(
      checkStructuredOutputReadiness({ capabilities: caps({}) as never }),
    ).toBe("PENDING");
    expect(
      checkStructuredOutputReadiness({
        capabilities: caps({ verification: "FAIL" }) as never,
      }),
    ).toBe("NOT_ELIGIBLE");
  });

  it("verified strategies map to the matching eligibility", () => {
    expect(
      checkStructuredOutputReadiness({
        capabilities: caps({
          strategy: "NATIVE_JSON_SCHEMA",
          verification: "PASS",
          verifiedRuntimeVersion: "0.154.0",
        }) as never,
      }),
    ).toBe("ELIGIBLE_NATIVE");
    expect(
      checkStructuredOutputReadiness({
        capabilities: caps({ verification: "PASS" }) as never,
      }),
    ).toBe("ELIGIBLE_PROMPT_RETRY");
  });
});
