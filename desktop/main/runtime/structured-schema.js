// Structured-output helpers shared by adapters whose ACCOUNT_LOGIN CLI
// takes the JSON Schema as an inline argv element (claude --json-schema,
// grok --json-schema).
//
// The Windows CreateProcess command-line budget is ~32k characters for the
// whole argv — a serialized schema that crowds it makes spawn fail or,
// worse, silently truncate. Structured probes use schemas well under this
// bound; anything larger is rejected before spawn with a stable code.

const INLINE_SCHEMA_MAX_CHARS = 16 * 1024;

// Error carrying a stable code the connection service maps onto
// STRUCTURED_OUTPUT_UNSUPPORTED.
class InlineSchemaTooLargeError extends Error {
  constructor() {
    super(
      `Structured-output schema exceeds the inline argv budget (${INLINE_SCHEMA_MAX_CHARS} chars)`,
    );
    this.name = "InlineSchemaTooLargeError";
    this.code = "STRUCTURED_OUTPUT_UNSUPPORTED";
  }
}

function serializeInlineSchema(schema) {
  const serialized = JSON.stringify(schema);
  if (serialized.length > INLINE_SCHEMA_MAX_CHARS) {
    throw new InlineSchemaTooLargeError();
  }
  return serialized;
}

module.exports = {
  INLINE_SCHEMA_MAX_CHARS,
  InlineSchemaTooLargeError,
  serializeInlineSchema,
};
