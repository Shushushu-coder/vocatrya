/**
 * Synthetic structured-output validation fixtures — the trial corpus for
 * VOCATRYA_CROSS_RUNTIME_STRUCTURED_OUTPUT_VALIDATION.
 *
 * Three schema classes:
 *   S1_FLAT                 — flat object: required fields, integer, enum,
 *                             additionalProperties=false.
 *   S2_JOB_DESCRIPTION_LIKE — nested objects, arrays, nullable, enums,
 *                             required fields; resembles the future
 *                             JobDescriptionParse consumer shape.
 *   S3_RESUME_LIKE          — nested arrays of objects, moderate output
 *                             length; resembles the Resume consumer shape.
 *
 * Every fixture uses invented candidates/jobs only — never real user
 * resumes, job postings, database rows, or files. The schemas stay inside
 * the conservative subset enforced by
 * structured-output.ts#findUnsupportedSchemaKeys.
 */
import type {
  StructuredOutputSchema,
  StructuredValidationTrial,
} from "./structured-output";

export const S1_FLAT_SCHEMA: StructuredOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    score: { type: "integer" },
    status: { type: "string", enum: ["PASS", "BORDERLINE", "FAIL"] },
  },
  required: ["name", "score", "status"],
};

export const S2_JOB_DESCRIPTION_LIKE_SCHEMA: StructuredOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    jobTitle: { type: "string" },
    company: { type: "string" },
    locations: { type: "array", items: { type: "string" } },
    employmentType: {
      type: "string",
      enum: ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP"],
    },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["MUST_HAVE", "NICE_TO_HAVE"] },
          text: { type: "string" },
        },
        required: ["type", "text"],
      },
    },
    skills: { type: "array", items: { type: "string" } },
    experienceYears: { type: ["number", "null"] },
  },
  required: [
    "jobTitle",
    "company",
    "locations",
    "employmentType",
    "requirements",
    "skills",
    "experienceYears",
  ],
};

export const S3_RESUME_LIKE_SCHEMA: StructuredOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidateName: { type: "string" },
    summary: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    experiences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title", "bullets"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          year: { type: ["integer", "null"] },
        },
        required: ["institution", "degree", "year"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "candidateName",
    "summary",
    "skills",
    "experiences",
    "education",
    "warnings",
  ],
};

export const STRUCTURED_VALIDATION_SCHEMAS = {
  S1_FLAT: { schemaName: "VocatryaScreeningResult", schema: S1_FLAT_SCHEMA },
  S2_JOB_DESCRIPTION_LIKE: {
    schemaName: "VocatryaJobDescriptionProbe",
    schema: S2_JOB_DESCRIPTION_LIKE_SCHEMA,
  },
  S3_RESUME_LIKE: {
    schemaName: "VocatryaResumeProbe",
    schema: S3_RESUME_LIKE_SCHEMA,
  },
} as const;

// ---------------------------------------------------------------------------
// Fixtures — 3 distinct synthetic inputs per schema (never the same prompt
// repeated).
// ---------------------------------------------------------------------------

const S1_TASKS: { id: string; prompt: string }[] = [
  {
    id: "s1-flat-a",
    prompt:
      "A synthetic screening run evaluated the fictional candidate " +
      "\"Mira Solen\" for a warehouse QC role and produced a rubric score " +
      "of 82 with outcome PASS. Return a JSON object with the candidate " +
      "name, the integer score, and the outcome status.",
  },
  {
    id: "s1-flat-b",
    prompt:
      "A synthetic screening run evaluated the fictional candidate " +
      "\"Dario Fenn\" for a customer-support role and produced a rubric " +
      "score of 61 with outcome BORDERLINE. Return a JSON object with the " +
      "candidate name, the integer score, and the outcome status.",
  },
  {
    id: "s1-flat-c",
    prompt:
      "A synthetic screening run evaluated the fictional candidate " +
      "\"Petra Vollan\" for a data-entry role and produced a rubric score " +
      "of 34 with outcome FAIL. Return a JSON object with the candidate " +
      "name, the integer score, and the outcome status.",
  },
];

const S2_TASKS: { id: string; prompt: string }[] = [
  {
    id: "s2-jd-a",
    prompt:
      "Extract a structured summary of this fictional job posting: " +
      "\"Fulfillment Coordinator at Nortech Logistics, based in Oslo and " +
      "Bergen, full-time. Must have 2+ years of warehouse coordination and " +
      "forklift safety certification. Nice to have: familiarity with lean " +
      "inventory practices. Skills: scheduling, inventory systems, " +
      "forklift safety.\"", 
  },
  {
    id: "s2-jd-b",
    prompt:
      "Extract a structured summary of this fictional job posting: " +
      "\"Frontend Engineer at Brightloop Studio, remote, contract. Must " +
      "have TypeScript and React experience; nice to have: design-system " +
      "work and accessibility auditing. No minimum years stated. Skills: " +
      "TypeScript, React, CSS, accessibility.\"",
  },
  {
    id: "s2-jd-c",
    prompt:
      "Extract a structured summary of this fictional job posting: " +
      "\"Clinical Data Associate at Veridia Health, part-time, located in " +
      "Leeds. Must have 3 years of clinical data management and GCP " +
      "certification. Skills: EDC systems, SQL, regulatory documentation.\"",
  },
];

const S3_TASKS: { id: string; prompt: string }[] = [
  {
    id: "s3-resume-a",
    prompt:
      "Produce a structured resume object for the fictional candidate " +
      "\"Dana Whitfield\", a project manager with 4 roles (Northwind " +
      "Retail, Cascadia Freight, Helio Systems, Bluepine Analytics), " +
      "3-4 accomplishment bullets per role, 16 skills, and 2 education " +
      "entries. Include a warnings array listing any gaps you invent.",
  },
  {
    id: "s3-resume-b",
    prompt:
      "Produce a structured resume object for the fictional candidate " +
      "\"Tomás Rivera\", a junior software developer with 4 roles " +
      "(including internships), 3-4 bullets per role, 15 skills, and 1 " +
      "education entry. Include a warnings array.",
  },
  {
    id: "s3-resume-c",
    prompt:
      "Produce a structured resume object for the fictional candidate " +
      "\"Priya Nair\", a senior data analyst with 4 roles, 4 bullets per " +
      "role, 18 skills, and 2 education entries. Include a warnings array.",
  },
];

function toTrials(
  schemaId: keyof typeof STRUCTURED_VALIDATION_SCHEMAS,
  tasks: { id: string; prompt: string }[],
): StructuredValidationTrial[] {
  const { schema, schemaName } = STRUCTURED_VALIDATION_SCHEMAS[schemaId];
  return tasks.map((task) => ({
    fixtureId: task.id,
    schemaId,
    schemaName,
    prompt: task.prompt,
    schema,
  }));
}

/** 3 schemas × 3 fixtures = 9 primary trials per runtime, ≤1 retry each. */
export const STRUCTURED_VALIDATION_TRIALS: StructuredValidationTrial[] = [
  ...toTrials("S1_FLAT", S1_TASKS),
  ...toTrials("S2_JOB_DESCRIPTION_LIKE", S2_TASKS),
  ...toTrials("S3_RESUME_LIKE", S3_TASKS),
];
