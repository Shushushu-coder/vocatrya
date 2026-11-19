import type { UIMessage } from "ai";
import { isAgentFilePart, isAgentPastePart } from "@/models/agent.model";

// The read_webpage scope rule lives here, in code: a URL is fetchable only if
// the user wrote it in this conversation. Assistant text and tool results are
// never a source, so a model cannot launder a URL it invented or one found in
// a fetched page into a fetch.

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    if (/[.,;:!?'*]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // A closing bracket belongs to the URL only when it is balanced inside it.
    if (last === ")" && count(url, "(") < count(url, ")")) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === "]" && count(url, "[") < count(url, "]")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * Canonical comparison key: scheme and host are case-folded by the URL parser,
 * default ports and the fragment are dropped, a trailing slash on the path is
 * ignored. Returns null for anything that is not an http(s) URL without
 * embedded credentials.
 */
export function normalizeUrlKey(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const trimmed = trimTrailing(match[0]);
    if (trimmed) found.push(trimmed);
  }
  return found;
}

/** Normalized keys of every URL the user supplied in these messages. */
export function collectUserSuppliedUrlKeys(
  messages: readonly UIMessage[],
): Set<string> {
  const keys = new Set<string>();
  const add = (text: string) => {
    for (const raw of extractUrls(text)) {
      const key = normalizeUrlKey(raw);
      if (key) keys.add(key);
    }
  };
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts ?? []) {
      if (part.type === "text") add(part.text);
      else if (isAgentPastePart(part)) add(part.data.text);
      else if (isAgentFilePart(part)) add(part.data.text);
    }
  }
  return keys;
}

export function isUserSuppliedUrl(
  url: string,
  supplied: ReadonlySet<string>,
): boolean {
  const key = normalizeUrlKey(url);
  return key !== null && supplied.has(key);
}
