/**
 * Knowledge provider — local DI (NOT Host Port v0).
 * Source: InterviewDx vocatrya-port src/services/knowledge.ts (IMPORT_REWRITE).
 */
import {
  KNOWLEDGE_BASE_VERSION,
  knowledgePromptExcerpt,
  loadInterviewKnowledgeBase,
} from "../knowledge/loader";

export interface KnowledgeProvider {
  readonly version: string;
  readonly contentHash: string;
  promptExcerpt(): string;
  /** Canonical taxonomy labels for feedback prompts. Optional for tests. */
  taxonomyLabels?(): string[];
}

export class StaticKnowledgeProvider implements KnowledgeProvider {
  readonly version: string;
  readonly contentHash: string;
  private readonly excerpt: string;

  constructor(
    version = "v1.0",
    excerpt = "KB v1.0 problem types: STAR; specificity",
    contentHash = "test",
  ) {
    this.version = version;
    this.excerpt = excerpt;
    this.contentHash = contentHash;
  }

  promptExcerpt(): string {
    return this.excerpt;
  }
}

export class BundledKnowledgeProvider implements KnowledgeProvider {
  readonly version: string;
  readonly contentHash: string;

  constructor() {
    const kb = loadInterviewKnowledgeBase();
    this.version = kb.version || KNOWLEDGE_BASE_VERSION;
    this.contentHash = kb.contentHash;
  }

  promptExcerpt(): string {
    return knowledgePromptExcerpt();
  }

  taxonomyLabels(): string[] {
    const kb = loadInterviewKnowledgeBase();
    return kb.taxonomy.entries
      .map((entry) => String((entry as { problem_type?: unknown }).problem_type ?? ""))
      .filter(Boolean);
  }
}
