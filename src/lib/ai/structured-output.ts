/**
 * Structured-output validation contract — the shared
 * `prompt → assistant text → parse → schema-validate → ≤1 retry → typed
 * value` pipeline used by the cross-runtime validation harness.
 *
 * Critical boundary: validation always targets the final assistant TEXT
 * returned by the runtime adapter, never a CLI transport envelope. A
 * `{ "type": "result", "result": "..." }` wrapper proves nothing about the
 * payload inside `result`; this module sees only the unwrapped text.
 *
 * Allowed normalization (exactly these, nothing else):
 *   - UTF-8 BOM removal
 *   - leading/trailing whitespace
 *   - a single outer ```json ... ``` (or ``` ... ```) markdown fence that
 *     wraps the ENTIRE output
 * Forbidden repair: missing properties are never added, strings are never
 * coerced to numbers, enums are never rewritten, unknown properties are
 * never stripped, and natural language is never heuristically converted
 * into JSON. Any deviation is a validation failure, not an input to fix.
 *
 * This module is dependency-free on purpose: it must load under Node's
 * type stripping (scripts/*.mts) as well as inside Next/vitest.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * How a runtime is expected to produce schema-shaped output.
 * NATIVE_JSON_SCHEMA: the CLI invocation carries the schema to the runtime
 * (e.g. `codex exec --output-schema`, `claude -p --json-schema`,
 * `grok -p --json-schema`) and the runtime claims enforcement.
 * PROMPT_AND_VALIDATE: no schema transport exists; the prompt embeds the
 * schema and local validation decides.
 * UNSUPPORTED: no usable assistant-text structured path.
 */
export const STRUCTURED_OUTPUT_STRATEGIES = [
  "NATIVE_JSON_SCHEMA",
  "PROMPT_AND_VALIDATE",
  "UNSUPPORTED",
] as const;
export type StructuredOutputStrategy =
  (typeof STRUCTURED_OUTPUT_STRATEGIES)[number];

/**
 * Engineering verification state for the strategy — bound to a specific
 * runtime version, never persisted to AIConnection, never a user-facing
 * claim. Mirrors the existing realLoginE2E/adversarialPermissions flags.
 */
export const STRUCTURED_OUTPUT_VERIFICATIONS = [
  "PASS",
  "PENDING",
  "FAIL",
  "NOT_APPLICABLE",
] as const;
export type StructuredOutputVerification =
  (typeof STRUCTURED_OUTPUT_VERIFICATIONS)[number];

/** Future-consumer eligibility gate outcomes. */
export const STRUCTURED_OUTPUT_ELIGIBILITIES = [
  "ELIGIBLE_NATIVE",
  "ELIGIBLE_PROMPT_RETRY",
  "PENDING",
  "NOT_ELIGIBLE",
] as const;
export type StructuredOutputEligibility =
  (typeof STRUCTURED_OUTPUT_ELIGIBILITIES)[number];

/** Stable failure categories for the validation harness. */
export const STRUCTURED_OUTPUT_ERROR_CODES = [
  "STRUCTURED_OUTPUT_UNSUPPORTED",
  "STRUCTURED_OUTPUT_NOT_VERIFIED",
  "STRUCTURED_OUTPUT_PARSE_FAILED",
  "STRUCTURED_OUTPUT_SCHEMA_FAILED",
  "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION",
  "STRUCTURED_OUTPUT_TRUNCATED",
  "STRUCTURED_OUTPUT_RETRY_EXHAUSTED",
] as const;
export type StructuredOutputErrorCode =
  (typeof STRUCTURED_OUTPUT_ERROR_CODES)[number];

export type StructuredOutputSchema = Record<string, unknown>;

export interface StructuredValidationIssue {
  /** JSON-path-ish location, e.g. `$.requirements[2].type`. Root is `$`. */
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Normalization + parse
// ---------------------------------------------------------------------------

const BOM = String.fromCharCode(0xfeff);
// A single outer fence must cover the whole output: opening fence, optional
// `json` language tag, body, closing fence, then only whitespace. Partial
// fences, commentary around a fence, or two fenced blocks do NOT match and
// are left untouched so JSON.parse rejects them.
const FENCED_BLOCK = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i;

/**
 * Applies only the documented normalization steps. Returns the text to feed
 * JSON.parse; callers must not normalize further.
 */
export function normalizeStructuredText(raw: string): string {
  if (typeof raw !== "string") return "";
  let text = raw.startsWith(BOM) ? raw.slice(1) : raw;
  text = text.trim();
  const fence = FENCED_BLOCK.exec(text);
  if (fence) text = fence[1].trim();
  return text;
}

export type ParseStructuredTextResult =
  | { ok: true; value: unknown; normalizedText: string }
  | { ok: false; code: "STRUCTURED_OUTPUT_PARSE_FAILED"; message: string };

export function parseStructuredText(raw: string): ParseStructuredTextResult {
  const normalizedText = normalizeStructuredText(raw);
  if (normalizedText.length === 0) {
    return {
      ok: false,
      code: "STRUCTURED_OUTPUT_PARSE_FAILED",
      message: "empty output",
    };
  }
  try {
    return { ok: true, value: JSON.parse(normalizedText), normalizedText };
  } catch (error) {
    return {
      ok: false,
      code: "STRUCTURED_OUTPUT_PARSE_FAILED",
      message: error instanceof Error ? error.message : "invalid JSON",
    };
  }
}

// ---------------------------------------------------------------------------
// Conservative JSON-Schema subset validator
// ---------------------------------------------------------------------------
// Supported: object/array/string/integer/number/boolean/null types (incl.
// type arrays for explicit nullability), properties, required,
// additionalProperties, items, enum, const, minItems/maxItems,
// minLength/maxLength, minimum/maximum, and the annotation keywords
// $schema/$id/title/description/default/format (ignored for validation).
// Everything else (oneOf/anyOf/allOf/$ref/pattern/if-then-else/...) is
// unsupported and must be rejected by assertSupportedStructuredSchema
// BEFORE a trial runs — the validator never silently ignores an
// unsupported constraint.

const ANNOTATION_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "format",
]);

const CONSTRAINT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
]);

const KNOWN_TYPE_NAMES = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fails when the schema uses a keyword outside the conservative subset —
 * the harness refuses exotic schemas instead of running an unenforced
 * constraint and reporting a false PASS. Returns the list of offending
 * `path:keyword` entries; an empty list means supported.
 */
export function findUnsupportedSchemaKeys(
  schema: StructuredOutputSchema,
  basePath = "$",
): string[] {
  const unsupported: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (ANNOTATION_KEYS.has(key)) continue;
      if (!CONSTRAINT_KEYS.has(key)) {
        unsupported.push(`${path}:${key}`);
        continue;
      }
      if (key === "properties") {
        if (!isPlainObject(value)) {
          unsupported.push(`${path}:properties(shape)`);
          continue;
        }
        for (const [prop, child] of Object.entries(value)) {
          walk(child, `${path}.properties.${prop}`);
        }
      } else if (key === "items") {
        // Tuple-form `items` arrays are outside the supported subset.
        if (!isPlainObject(value)) {
          unsupported.push(`${path}:items(shape)`);
          continue;
        }
        walk(value, `${path}.items`);
      } else if (key === "additionalProperties") {
        if (typeof value === "boolean") continue;
        if (!isPlainObject(value)) {
          unsupported.push(`${path}:additionalProperties(shape)`);
          continue;
        }
        walk(value, `${path}.additionalProperties`);
      } else if (key === "required") {
        if (!Array.isArray(value)) {
          unsupported.push(`${path}:required(shape)`);
        }
      } else if (key === "enum") {
        if (!Array.isArray(value)) {
          unsupported.push(`${path}:enum(shape)`);
        }
      } else if (key === "type") {
        const names = Array.isArray(value) ? value : [value];
        for (const name of names) {
          if (typeof name !== "string" || !KNOWN_TYPE_NAMES.has(name)) {
            unsupported.push(`${path}:type(${String(name)})`);
          }
        }
      }
    }
  };
  walk(schema, basePath);
  return unsupported;
}

function typeMatches(value: unknown, typeName: string): boolean {
  switch (typeName) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isInteger(value)) return "number";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function typeListLabel(typeValue: unknown): string {
  const names = Array.isArray(typeValue) ? typeValue : [typeValue];
  return names.map(String).join("|");
}

function validateNode(
  value: unknown,
  schema: StructuredOutputSchema,
  path: string,
  issues: StructuredValidationIssue[],
): void {
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push({ path, message: "const mismatch" });
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((entry) => deepEqual(value, entry))) {
      issues.push({ path, message: `not in enum ${typeListLabel(schema.enum)}` });
      return;
    }
  }
  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = names.some(
      (name) => typeof name === "string" && typeMatches(value, name),
    );
    if (!matches) {
      issues.push({
        path,
        message: `expected ${typeListLabel(schema.type)}, got ${typeLabel(value)}`,
      });
      return; // type mismatch — do not descend into shape checks.
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties)
      ? schema.properties
      : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) {
          issues.push({ path, message: `missing required "${key}"` });
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: "additional property" });
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && isPlainObject(child)) {
        validateNode(value[key], child, `${path}.${key}`, issues);
      }
    }
    if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          validateNode(value[key], schema.additionalProperties, `${path}.${key}`, issues);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `maxItems ${schema.maxItems}` });
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => {
        validateNode(item, schema.items as StructuredOutputSchema, `${path}[${index}]`, issues);
      });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `maxLength ${schema.maxLength}` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `maximum ${schema.maximum}` });
    }
  }
}

/**
 * Validates a parsed value against the supported schema subset. Returns
 * an issue list (empty = valid). Callers must run
 * findUnsupportedSchemaKeys on the schema first when it came from an
 * untrusted path — this function never enforces unsupported keywords.
 */
export function validateStructuredValue(
  value: unknown,
  schema: StructuredOutputSchema,
): StructuredValidationIssue[] {
  const issues: StructuredValidationIssue[] = [];
  if (!isPlainObject(schema)) {
    issues.push({ path: "$", message: "schema is not an object" });
    return issues;
  }
  validateNode(value, schema, "$", issues);
  return issues;
}

/**
 * Concise validator-error summary for retry prompts and diagnostics.
 * Contains field paths + reasons only — never raw output, stderr, or
 * stack traces.
 */
export function summarizeValidationIssues(
  issues: StructuredValidationIssue[],
  max = 6,
): string {
  const shown = issues.slice(0, max).map((issue) => `${issue.path}: ${issue.message}`);
  if (issues.length > max) {
    shown.push(`…and ${issues.length - max} more`);
  }
  return shown.join("; ");
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const OUTPUT_CONTRACT_INSTRUCTIONS =
  "Respond with ONLY a single JSON object conforming to the JSON Schema " +
  "below. Emit it as one line of compact JSON. Do not include markdown " +
  "fences, commentary, or any text before or after the JSON object.";

/**
 * The PROMPT_AND_VALIDATE mechanism: the schema travels inside the prompt.
 * Also used for NATIVE_JSON_SCHEMA runs — the prompt stays identical so
 * the only difference between strategies is the runtime-side schema
 * transport, never the task text.
 */
export function buildStructuredOutputPrompt({
  prompt,
  schema,
  schemaName,
}: {
  prompt: string;
  schema: StructuredOutputSchema;
  schemaName: string;
}): string {
  return (
    `${prompt}\n\n${OUTPUT_CONTRACT_INSTRUCTIONS}` +
    `${schemaName ? ` Schema name: ${schemaName}.` : ""}\n` +
    `${JSON.stringify(schema)}\n`
  );
}

/**
 * The single allowed retry prompt: same task, same schema, plus the
 * validator's field-path error summary. Internal stack traces, stderr,
 * and raw model output never enter this prompt.
 */
export function buildStructuredOutputRetryPrompt({
  prompt,
  schema,
  schemaName,
  issues,
}: {
  prompt: string;
  schema: StructuredOutputSchema;
  schemaName: string;
  issues: StructuredValidationIssue[];
}): string {
  const summary = summarizeValidationIssues(issues);
  return (
    `${prompt}\n\n${OUTPUT_CONTRACT_INSTRUCTIONS}` +
    `${schemaName ? ` Schema name: ${schemaName}.` : ""}\n` +
    `${JSON.stringify(schema)}\n\n` +
    `Your previous response failed local schema validation: ` +
    `${summary || "output was not valid JSON"}. ` +
    `Return only the corrected JSON object.`
  );
}

// ---------------------------------------------------------------------------
// Validation state machine
// ---------------------------------------------------------------------------

/** What one model invocation returns to the state machine. */
export type StructuredExecuteOutcome =
  | {
      ok: true;
      /** Final assistant text — never a CLI transport envelope. */
      text: string;
      /** The mechanism the runtime actually applied for this call. */
      structuredStrategy?: StructuredOutputStrategy | null;
      /** Runtime stop reason, when the envelope exposes one. */
      stopReason?: string | null;
      durationMs?: number;
    }
  | {
      ok: false;
      code: string;
      stopReason?: string | null;
      durationMs?: number;
    };

export type StructuredExecuteFn = (input: {
  /** The composed prompt (schema embedded for PROMPT_AND_VALIDATE). */
  prompt: string;
  /** The trial's schema — transports native-capable runtimes use it. */
  schema: StructuredOutputSchema;
  schemaName: string;
  /** 0 = primary call, 1 = the single allowed retry. */
  attempt: 0 | 1;
  signal?: AbortSignal;
}) => Promise<StructuredExecuteOutcome>;

export type StructuredAttemptOutcome =
  | "VALID"
  | "PARSE_FAILED"
  | "SCHEMA_FAILED"
  | "TRUNCATED"
  | "NATIVE_SCHEMA_VIOLATION"
  | "EXECUTION_FAILED";

export interface StructuredValidationAttempt {
  kind: "primary" | "retry";
  outcome: StructuredAttemptOutcome;
  /** Mechanism the runtime reported for this call. */
  structuredStrategy: StructuredOutputStrategy | null;
  issues: StructuredValidationIssue[];
  /** Execution-layer error code when the call itself failed. */
  code: string | null;
  durationMs?: number;
}

export type StructuredValidationStatus =
  | "VALID"
  | "VALID_AFTER_RETRY"
  | StructuredOutputErrorCode
  | "EXECUTION_FAILED";

export interface StructuredValidationResult {
  status: StructuredValidationStatus;
  /** The typed business object when status is VALID / VALID_AFTER_RETRY. */
  value: unknown | null;
  attempts: StructuredValidationAttempt[];
  firstPassValid: boolean;
  retried: boolean;
  validAfterRetry: boolean;
  /** A native-schema run that still produced invalid output — serious. */
  nativeViolation: boolean;
  issueSummary: string | null;
}

const LENGTH_STOP_REASON = /length|max.?tokens|token.?limit|truncat|context/i;

function isTruncated(stopReason: string | null | undefined): boolean {
  return typeof stopReason === "string" && LENGTH_STOP_REASON.test(stopReason);
}

function invalidOutcome(
  issues: StructuredValidationIssue[],
  parseFailed: boolean,
  stopReason: string | null | undefined,
): StructuredAttemptOutcome {
  if (isTruncated(stopReason)) return "TRUNCATED";
  return parseFailed ? "PARSE_FAILED" : "SCHEMA_FAILED";
}

/**
 * Runs the `prompt → parse → validate → at most one retry` contract.
 *
 * The injected `execute` callback owns the transport (managed AIConnection
 * execution seam); this function owns prompt construction, normalization,
 * schema validation, and retry policy:
 *   - NATIVE_JSON_SCHEMA attempts that still fail local validation are
 *     recorded as NATIVE_SCHEMA_VIOLATION and are terminal — a prompt retry
 *     must never mask a native enforcement failure into an apparent pass.
 *   - PROMPT_AND_VALIDATE gets at most one retry carrying the validator's
 *     error-path summary.
 */
export async function runStructuredValidation({
  prompt,
  schema,
  schemaName,
  execute,
  signal,
}: {
  prompt: string;
  schema: StructuredOutputSchema;
  schemaName: string;
  execute: StructuredExecuteFn;
  signal?: AbortSignal;
}): Promise<StructuredValidationResult> {
  const attempts: StructuredValidationAttempt[] = [];

  const runAttempt = async (
    attemptIndex: 0 | 1,
    attemptPrompt: string,
  ): Promise<{ attempt: StructuredValidationAttempt; value: unknown | null }> => {
    let outcome: StructuredExecuteOutcome;
    try {
      outcome = await execute({
        prompt: attemptPrompt,
        schema,
        schemaName,
        attempt: attemptIndex,
        signal,
      });
    } catch {
      outcome = { ok: false, code: "AI_EXECUTION_FAILED" };
    }
    const strategy = outcome.ok ? (outcome.structuredStrategy ?? null) : null;
    if (!outcome.ok) {
      return {
        attempt: {
          kind: attemptIndex === 0 ? "primary" : "retry",
          outcome: "EXECUTION_FAILED",
          structuredStrategy: strategy,
          issues: [],
          code: outcome.code,
          durationMs: outcome.durationMs,
        },
        value: null,
      };
    }

    const parsed = parseStructuredText(outcome.text);
    let issues: StructuredValidationIssue[];
    let value: unknown | null = null;
    if (!parsed.ok) {
      issues = [{ path: "$", message: parsed.message }];
    } else {
      value = parsed.value;
      issues = validateStructuredValue(parsed.value, schema);
    }

    if (issues.length === 0) {
      return {
        attempt: {
          kind: attemptIndex === 0 ? "primary" : "retry",
          outcome: "VALID",
          structuredStrategy: strategy,
          issues: [],
          code: null,
          durationMs: outcome.durationMs,
        },
        value,
      };
    }

    const violation = invalidOutcome(issues, !parsed.ok, outcome.stopReason);
    const isNative = strategy === "NATIVE_JSON_SCHEMA";
    return {
      attempt: {
        kind: attemptIndex === 0 ? "primary" : "retry",
        outcome: isNative ? "NATIVE_SCHEMA_VIOLATION" : violation,
        structuredStrategy: strategy,
        issues,
        code: null,
        durationMs: outcome.durationMs,
      },
      value: null,
    };
  };

  // Primary call.
  const primary = await runAttempt(0, buildStructuredOutputPrompt({ prompt, schema, schemaName }));
  attempts.push(primary.attempt);
  if (primary.attempt.outcome === "VALID") {
    return {
      status: "VALID",
      value: primary.value,
      attempts,
      firstPassValid: true,
      retried: false,
      validAfterRetry: false,
      nativeViolation: false,
      issueSummary: null,
    };
  }
  if (primary.attempt.outcome === "EXECUTION_FAILED") {
    return {
      status: "EXECUTION_FAILED",
      value: null,
      attempts,
      firstPassValid: false,
      retried: false,
      validAfterRetry: false,
      nativeViolation: false,
      issueSummary: primary.attempt.code,
    };
  }
  if (primary.attempt.outcome === "NATIVE_SCHEMA_VIOLATION") {
    return {
      status: "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION",
      value: null,
      attempts,
      firstPassValid: false,
      retried: false,
      validAfterRetry: false,
      nativeViolation: true,
      issueSummary: summarizeValidationIssues(primary.attempt.issues),
    };
  }

  // PROMPT_AND_VALIDATE (or unreported strategy): one bounded retry.
  const retry = await runAttempt(
    1,
    buildStructuredOutputRetryPrompt({
      prompt,
      schema,
      schemaName,
      issues: primary.attempt.issues,
    }),
  );
  attempts.push(retry.attempt);
  if (retry.attempt.outcome === "VALID") {
    return {
      status: "VALID_AFTER_RETRY",
      value: retry.value,
      attempts,
      firstPassValid: false,
      retried: true,
      validAfterRetry: true,
      nativeViolation: false,
      issueSummary: null,
    };
  }
  if (retry.attempt.outcome === "EXECUTION_FAILED") {
    return {
      status: "EXECUTION_FAILED",
      value: null,
      attempts,
      firstPassValid: false,
      retried: true,
      validAfterRetry: false,
      nativeViolation: false,
      issueSummary: retry.attempt.code,
    };
  }
  if (retry.attempt.outcome === "NATIVE_SCHEMA_VIOLATION") {
    return {
      status: "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION",
      value: null,
      attempts,
      firstPassValid: false,
      retried: true,
      validAfterRetry: false,
      nativeViolation: true,
      issueSummary: summarizeValidationIssues(retry.attempt.issues),
    };
  }
  return {
    status:
      retry.attempt.outcome === "TRUNCATED" ||
      primary.attempt.outcome === "TRUNCATED"
        ? "STRUCTURED_OUTPUT_TRUNCATED"
        : "STRUCTURED_OUTPUT_RETRY_EXHAUSTED",
    value: null,
    attempts,
    firstPassValid: false,
    retried: true,
    validAfterRetry: false,
    nativeViolation: false,
    issueSummary: summarizeValidationIssues(retry.attempt.issues),
  };
}

// ---------------------------------------------------------------------------
// Trial suite
// ---------------------------------------------------------------------------

export interface StructuredValidationTrial {
  fixtureId: string;
  schemaId: string;
  schemaName: string;
  /** The synthetic task text — no real user data, ever. */
  prompt: string;
  schema: StructuredOutputSchema;
}

export interface StructuredValidationTrialResult
  extends StructuredValidationResult {
  fixtureId: string;
  schemaId: string;
  schemaName: string;
}

export interface StructuredValidationSuiteResult {
  trials: StructuredValidationTrialResult[];
  totals: {
    trials: number;
    /** Total model invocations issued (primary + retry). */
    calls: number;
    firstPassValid: number;
    retried: number;
    validAfterRetry: number;
    finalValid: number;
    nativeViolations: number;
    executionFailed: number;
  };
}

/**
 * Runs the fixture matrix. The budget is fixed by construction: one
 * primary call per trial plus at most one retry — never a loop-until-green.
 */
export async function runStructuredValidationSuite({
  trials,
  execute,
  signal,
}: {
  trials: StructuredValidationTrial[];
  execute: StructuredExecuteFn;
  signal?: AbortSignal;
}): Promise<StructuredValidationSuiteResult> {
  const results: StructuredValidationTrialResult[] = [];
  for (const trial of trials) {
    const unsupported = findUnsupportedSchemaKeys(trial.schema);
    if (unsupported.length > 0) {
      results.push({
        fixtureId: trial.fixtureId,
        schemaId: trial.schemaId,
        schemaName: trial.schemaName,
        status: "STRUCTURED_OUTPUT_UNSUPPORTED",
        value: null,
        attempts: [],
        firstPassValid: false,
        retried: false,
        validAfterRetry: false,
        nativeViolation: false,
        issueSummary: `unsupported schema keys: ${unsupported.join(", ")}`,
      });
      continue;
    }
    const result = await runStructuredValidation({
      prompt: trial.prompt,
      schema: trial.schema,
      schemaName: trial.schemaName,
      execute,
      signal,
    });
    results.push({
      fixtureId: trial.fixtureId,
      schemaId: trial.schemaId,
      schemaName: trial.schemaName,
      ...result,
    });
    if (signal?.aborted) break;
  }
  const totals = {
    trials: results.length,
    calls: results.reduce((sum, r) => sum + r.attempts.length, 0),
    firstPassValid: results.filter((r) => r.firstPassValid).length,
    retried: results.filter((r) => r.retried).length,
    validAfterRetry: results.filter((r) => r.validAfterRetry).length,
    finalValid: results.filter(
      (r) => r.status === "VALID" || r.status === "VALID_AFTER_RETRY",
    ).length,
    nativeViolations: results.filter((r) => r.nativeViolation).length,
    executionFailed: results.filter((r) => r.status === "EXECUTION_FAILED").length,
  };
  return { trials: results, totals };
}
