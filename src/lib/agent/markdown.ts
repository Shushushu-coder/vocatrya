import MarkdownIt from "markdown-it";
import { stripThinking } from "@/lib/ai/stripThinking";

// Isomorphic: no server-only, no fetch. The transcript imports it from a
// client component.

// html:false escapes raw HTML; TipTapContentViewer strips unrecognized tags
// after this. The disabled rules are the security property, not a style
// choice: a markdown link or image is a network request the user never
// chose, from output an injected posting can influence. Disabled here means
// the URL still renders, as inert text.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
md.disable(["image", "link", "autolink"]);

export function renderAgentMarkdown(text: string): string {
  const clean = stripThinking(text);
  return clean ? md.render(clean) : "";
}

export type AgentMarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string; code: string };

// Splits an answer's cleaned source at its top-level fenced code blocks so
// each block renders (and copies) on its own, outside the shared viewer.
// md.parse reports a fence's exact line range through token.map and its
// verbatim body as token.content — the language tag, the fences and the
// surrounding prose stay out of the copied text by construction. Line breaks
// are normalized the same way md.parse normalizes its input, so map indexes
// line up with the lines array even on \r\n. Unicode separators stay literal. An
// unclosed fence is a fence to end-of-input, which is what streaming renders
// anyway.
//
// Fences nested inside lists or blockquotes (level > 0) are deliberately not
// detached: their lines belong to the container's map, and pulling them out
// would break the container rendering. They keep rendering inline with no
// action of their own.
export function splitAgentMarkdown(text: string): AgentMarkdownSegment[] {
  // Persisted tool outputs are trusted shapes, but a malformed row must not
  // take the whole surface down — render nothing rather than crash.
  if (typeof text !== "string") return [];
  const src = stripThinking(text).replace(/\r\n?/g, "\n");
  if (!src) return [];
  const lines = src.split("\n");
  const segments: AgentMarkdownSegment[] = [];
  let cursor = 0;
  const pushMarkdown = (to: number) => {
    const text = lines.slice(cursor, to).join("\n");
    if (text.trim().length > 0) segments.push({ kind: "markdown", text });
  };
  for (const token of md.parse(src, {})) {
    if (token.type !== "fence" || token.level !== 0 || !token.map) continue;
    const [start, end] = token.map;
    if (start < cursor) continue;
    pushMarkdown(start);
    segments.push({
      kind: "code",
      // Same language-word rule as markdown-it's own fence renderer.
      language: md.utils.unescapeAll(token.info).trim().split(/\s+/g)[0],
      code: token.content,
    });
    cursor = end;
  }
  pushMarkdown(lines.length);
  return segments;
}
