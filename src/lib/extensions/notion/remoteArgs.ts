import { NOTION_REMOTE } from "./constants";

/**
 * Remote argument shapes for the Notion-hosted tools are discovered from
 * the connection's cached tools/list inputSchemas rather than hardcoded —
 * Notion revises these tools server-side. Each wrapper enumerates
 * candidates in documented-shape order and a shallow schema check picks
 * the first the discovered schema accepts. With no schema cached the most
 * documented candidate runs and remote validation errors surface honestly.
 */

type JsonSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
};

function schemaOf(raw: unknown): JsonSchema | null {
  return raw && typeof raw === "object" ? (raw as JsonSchema) : null;
}

function topLevelKeysFit(schema: JsonSchema, args: Record<string, unknown>): boolean {
  const props = schema.properties;
  if (!props) return false;
  const keys = Object.keys(args);
  if (keys.some((key) => !(key in props))) return false;
  const required = schema.required ?? [];
  return required.every((key) => key in args);
}

export function pickRemoteArgs(
  inputSchema: unknown,
  candidates: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const schema = schemaOf(inputSchema);
  if (!schema?.properties) {
    // No cached schema — run the first (most documented) candidate.
    return candidates[0] ?? null;
  }
  for (const candidate of candidates) {
    if (topLevelKeysFit(schema, candidate)) return candidate;
  }
  return null;
}

/** Extract a bare Notion object id from a URL or pass an id through. */
export function normalizeNotionTarget(target: string): string {
  const trimmed = target.trim();
  // notion.so URLs carry a 32-hex id (dashed or undashed) at the path tail.
  const urlMatch = trimmed.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\?|$|\/|#)/,
  );
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

export function parentFor(
  target: string | undefined,
  targetType: "page" | "database" | "data_source" | undefined,
): Record<string, unknown> | undefined {
  if (!target) return undefined;
  const id = normalizeNotionTarget(target);
  const key =
    targetType === "data_source"
      ? "data_source_id"
      : targetType === "database"
        ? "database_id"
        : "page_id";
  return { [key]: id };
}

export function createPageCandidates(input: {
  title: string;
  content: string;
  parent?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}): Array<Record<string, unknown>> {
  const page: Record<string, unknown> = {
    properties: { title: input.title, ...(input.properties ?? {}) },
    content: input.content,
  };
  const base = { allow_async: false, pages: [page] };
  return input.parent
    ? [
        { ...base, parent: input.parent },
        { ...base, pages: [{ ...page, parent: input.parent }] },
      ]
    : [base, { ...base, creation_mode: "draft" }];
}

export function appendContentCandidates(input: {
  pageId: string;
  content: string;
}): Array<Record<string, unknown>> {
  const { pageId, content } = input;
  return [
    {
      page_id: pageId,
      command: "insert_content",
      insert_content: { content },
      allow_async: false,
    },
    {
      page_id: pageId,
      command: "insert_content",
      content,
      allow_async: false,
    },
    { page_id: pageId, insert_content: { content }, allow_async: false },
    { page_id: pageId, append_content: { content }, allow_async: false },
  ];
}

export function updateRecordCandidates(input: {
  pageId: string;
  properties: Record<string, unknown>;
}): Array<Record<string, unknown>> {
  const { pageId, properties } = input;
  return [
    {
      page_id: pageId,
      command: "update_properties",
      properties,
      allow_async: false,
    },
    { page_id: pageId, update_properties: { properties }, allow_async: false },
    { page_id: pageId, properties, allow_async: false },
  ];
}

/** Search accepts the documented query (+ optional filters pass-through). */
export function searchArgs(input: { query: string }): Record<string, unknown> {
  return { query: input.query, query_type: "internal" };
}

export function fetchArgs(target: string): Array<Record<string, unknown>> {
  const id = normalizeNotionTarget(target);
  return [{ id }, { url: target }];
}

export const REMOTE_NAMES = NOTION_REMOTE;
