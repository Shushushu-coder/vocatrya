/**
 * Deterministic local Interview knowledge loader.
 *
 * PRODUCT_KNOWLEDGE only. Bundled JSON (no network, no InterviewDx path).
 * Version + content hash are frozen provenance for generations.
 */
import { createHash } from "node:crypto";
import { pyCanonicalJson } from "../persistence/hash";
import rubrics from "./assets/rubrics.json";
import strategies from "./assets/strategies.json";
import taxonomy from "./assets/taxonomy.json";

export const KNOWLEDGE_BASE_VERSION = "v1.0" as const;

const bundleSchemaOk = (bundle: {
  metadata?: { version?: string; type?: string };
  entries?: unknown[];
}): boolean =>
  Boolean(
    bundle &&
      bundle.metadata &&
      typeof bundle.metadata.version === "string" &&
      typeof bundle.metadata.type === "string" &&
      Array.isArray(bundle.entries),
  );

export interface InterviewKnowledgeBase {
  version: string;
  contentHash: string;
  rubrics: typeof rubrics;
  strategies: typeof strategies;
  taxonomy: typeof taxonomy;
}

let cached: InterviewKnowledgeBase | null = null;

export function knowledgeContentHash(input: {
  version: string;
  rubrics: unknown;
  strategies: unknown;
  taxonomy: unknown;
}): string {
  return createHash("sha256")
    .update(
      pyCanonicalJson({
        version: input.version,
        rubrics: input.rubrics,
        strategies: input.strategies,
        taxonomy: input.taxonomy,
      }),
      "utf8",
    )
    .digest("hex");
}

export function loadInterviewKnowledgeBase(): InterviewKnowledgeBase {
  if (cached) return cached;
  if (!bundleSchemaOk(rubrics) || !bundleSchemaOk(strategies) || !bundleSchemaOk(taxonomy)) {
    throw new Error("Interview knowledge assets are malformed");
  }
  if (rubrics.metadata.version !== KNOWLEDGE_BASE_VERSION) {
    throw new Error(
      `rubrics version ${rubrics.metadata.version} != ${KNOWLEDGE_BASE_VERSION}`,
    );
  }
  if (strategies.metadata.version !== KNOWLEDGE_BASE_VERSION) {
    throw new Error(
      `strategies version ${strategies.metadata.version} != ${KNOWLEDGE_BASE_VERSION}`,
    );
  }
  if (taxonomy.metadata.version !== KNOWLEDGE_BASE_VERSION) {
    throw new Error(
      `taxonomy version ${taxonomy.metadata.version} != ${KNOWLEDGE_BASE_VERSION}`,
    );
  }
  cached = {
    version: KNOWLEDGE_BASE_VERSION,
    contentHash: knowledgeContentHash({
      version: KNOWLEDGE_BASE_VERSION,
      rubrics,
      strategies,
      taxonomy,
    }),
    rubrics,
    strategies,
    taxonomy,
  };
  return cached;
}

export function knowledgePromptExcerpt(): string {
  const kb = loadInterviewKnowledgeBase();
  const types = kb.taxonomy.entries
    .slice(0, 8)
    .map((entry) => String((entry as { problem_type?: unknown }).problem_type ?? ""))
    .filter(Boolean);
  return `KB ${kb.version} problem types: ${types.join("; ")}`;
}

export function resetKnowledgeCacheForTests(): void {
  cached = null;
}
