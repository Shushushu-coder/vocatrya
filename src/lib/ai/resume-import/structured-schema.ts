/**
 * JSON Schema serialization of the production resume-import contract
 * (@/models/resumeImport.schema — ResumeImportSchema) for the structured
 * ACCOUNT_LOGIN execution seam.
 *
 * Classification: REQUIRES_EQUIVALENT_SCHEMA_SERIALIZATION — the Zod schema
 * uses .catch/.default/.transform/.union, none of which exist in the strict
 * validator's supported subset. This module serializes the schema's
 * *acceptance* semantics faithfully:
 *
 *   - `.optional()` / required `z.string()` fields keep `type: "string"`.
 *   - `.catch(...)` / `.default(...)` fields accept anything, so they
 *     serialize to an unconstrained annotation-only node (`{}` +
 *     description) — tightening them to `type: "string"` would reject
 *     inputs the production schema currently salvages.
 *   - `confidence` enums keep `enum`.
 *   - `unrecognizedSections` (union + transform + catch) is likewise
 *     unconstrained — any value is acceptable and the Zod layer still
 *     normalizes it.
 *   - No `additionalProperties: false` anywhere: Zod object schemas are
 *     non-strict (extra keys are stripped, never rejected).
 *   - No `required` at the root: every top-level field is optional or
 *     has a default/catch.
 *
 * The strict gate therefore rejects exactly what `safeParse` would reject
 * (a non-object root, malformed required item fields, bad enum values) —
 * nothing more. Zod-level salvage (.catch/.transform) still runs on the
 * validated object downstream, unchanged.
 */
import type { StructuredOutputSchema } from "@/lib/ai/structured-output";

export const RESUME_IMPORT_SCHEMA_NAME = "resume_import_v1";

const CONFIDENCE = { enum: ["high", "medium", "low"] };
// `.catch("")`/`.default(...)` fields accept any JSON value — an
// annotation-only node is the only faithful constraint. The description
// still guides the model inside the prompt-embedded schema.
const ANY_STRING = { description: "string (empty string when unknown)" };

export const RESUME_IMPORT_JSON_SCHEMA: StructuredOutputSchema = {
  type: "object",
  description: "Parsed resume sections",
  properties: {
    contactInfo: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        headline: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        confidence: CONFIDENCE,
      },
    },
    summary: { description: "professional summary string" },
    skills: {
      type: "object",
      properties: {
        categories: {
          description:
            'array of {"label": string, "skills": string[]} groupings',
        },
        confidence: CONFIDENCE,
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          jobTitle: { type: "string" },
          location: { type: "string" },
          startDate: ANY_STRING,
          endDate: { description: 'string; "" / "Present" = current job' },
          description: ANY_STRING,
          confidence: CONFIDENCE,
        },
        required: ["company", "jobTitle"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          fieldOfStudy: { type: "string" },
          location: { type: "string" },
          startDate: ANY_STRING,
          endDate: ANY_STRING,
          description: ANY_STRING,
          confidence: CONFIDENCE,
        },
        required: ["institution"],
      },
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          organization: { type: "string" },
          issueDate: { type: "string" },
          expirationDate: { type: "string" },
          credentialUrl: { type: "string" },
          confidence: CONFIDENCE,
        },
        required: ["title"],
      },
    },
    unrecognizedSections: {
      description:
        'array of unrecognized section names — strings or {"name": ...} objects',
    },
  },
};
