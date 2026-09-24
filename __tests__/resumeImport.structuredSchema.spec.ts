// @vitest-environment node
/**
 * ResumeImportSchema → RESUME_IMPORT_JSON_SCHEMA equivalence.
 *
 * The production Zod schema uses .catch/.default/.transform/.union which
 * the strict validator subset cannot express — the serialized JSON schema
 * preserves the schema's ACCEPTANCE semantics only: it rejects what
 * safeParse rejects, and stays unconstrained where Zod salvages.
 * Zod-level normalization still runs downstream on the validated object.
 */
import { ResumeImportSchema } from "@/models/resumeImport.schema";
import {
  RESUME_IMPORT_JSON_SCHEMA,
  RESUME_IMPORT_SCHEMA_NAME,
} from "@/lib/ai/resume-import/structured-schema";
import {
  findUnsupportedSchemaKeys,
  validateStructuredValue,
} from "@/lib/ai/structured-output";

const CASES: { name: string; value: unknown; accepted: boolean }[] = [
  {
    name: "complete valid import",
    value: {
      contactInfo: { firstName: "Ada", lastName: "Lovelace" },
      summary: "engineer",
      skills: { categories: [{ label: "Langs", skills: ["TS"] }] },
      experience: [
        { company: "Acme", jobTitle: "Eng", startDate: "2020" },
      ],
      education: [{ institution: "MIT" }],
      certifications: [{ title: "AWS" }],
      unrecognizedSections: ["Awards"],
    },
    accepted: true,
  },
  { name: "empty object", value: {}, accepted: true },
  {
    name: "catch fields accept non-strings",
    value: {
      summary: 42,
      experience: [
        { company: "A", jobTitle: "B", startDate: 2020, description: null },
      ],
      unrecognizedSections: [123, { weird: true }],
      skills: { categories: "not-an-array" },
    },
    accepted: true,
  },
  { name: "non-object root", value: "resume text", accepted: false },
  { name: "array root", value: [], accepted: false },
  {
    name: "experience item missing required field",
    value: { experience: [{ jobTitle: "Eng" }] },
    accepted: false,
  },
  {
    name: "experience item non-string required field",
    value: { experience: [{ company: 5, jobTitle: "Eng" }] },
    accepted: false,
  },
  {
    name: "bad confidence enum",
    value: { contactInfo: { confidence: "sure" } },
    accepted: false,
  },
  {
    name: "certification missing title",
    value: { certifications: [{ organization: "X" }] },
    accepted: false,
  },
  {
    name: "extra keys are tolerated (Zod strips them)",
    value: { contactInfo: { nickname: "x" }, extra: [1, 2] },
    accepted: true,
  },
  {
    name: "contactInfo wrong container type",
    value: { contactInfo: "Ada Lovelace" },
    accepted: false,
  },
];

describe("RESUME_IMPORT_JSON_SCHEMA", () => {
  it("stays inside the strict validator's supported subset", () => {
    expect(findUnsupportedSchemaKeys(RESUME_IMPORT_JSON_SCHEMA)).toEqual([]);
    expect(RESUME_IMPORT_SCHEMA_NAME.length).toBeGreaterThan(0);
    expect(RESUME_IMPORT_SCHEMA_NAME.length).toBeLessThanOrEqual(128);
    expect(
      Buffer.byteLength(JSON.stringify(RESUME_IMPORT_JSON_SCHEMA), "utf8"),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it.each(CASES)(
    "acceptance matches ResumeImportSchema.safeParse — $name",
    ({ value, accepted }) => {
      const zodOk = ResumeImportSchema.safeParse(value).success;
      const strictOk =
        validateStructuredValue(value, RESUME_IMPORT_JSON_SCHEMA).length === 0;
      expect(zodOk).toBe(accepted);
      expect(strictOk).toBe(accepted);
    },
  );
});
