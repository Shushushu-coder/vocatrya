import { decodeEntities } from "@/lib/scraper/html";

// Plain-text/markdown-ish extraction of a fetched page. Deliberately regex
// based: no new dependency, and the output is bounded text, not a DOM.

export const WEBPAGE_TEXT_LIMIT = 20_000;

const DROP_WITH_CONTENT = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
  "select",
  "button",
  "canvas",
  "object",
  "embed",
];
const DROP_BLOCKS = ["nav", "footer", "aside", "form", "dialog"];

// Remove every <tag ...>...</tag>, counting nesting of the same tag.
function removeElements(html: string, tag: string): string {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  let out = "";
  let cursor = 0;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const closing = m[1] === "/";
    const selfClosed = m[0].endsWith("/>");
    if (depth === 0) {
      if (closing) continue;
      out += html.slice(cursor, m.index);
      if (selfClosed) cursor = m.index + m[0].length;
      else depth = 1;
    } else if (closing) {
      depth--;
      if (depth === 0) cursor = m.index + m[0].length;
    } else if (!selfClosed) {
      depth++;
    }
  }
  // Unclosed element: drop the rest, it is boilerplate we cannot delimit.
  return depth === 0 ? out + html.slice(cursor) : out;
}

// Inner HTML of the first element matching openPattern, nesting-aware.
function innerOf(html: string, openPattern: string, tag: string): string | null {
  const open = new RegExp(openPattern, "i").exec(html);
  if (!open) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return html.slice(open.index + open[0].length);
}

function toText(html: string): string {
  let t = html
    .replace(
      /<h([1-6])\b[^>]*>/gi,
      (_, n: string) => `\n\n${"#".repeat(Number(n))} `,
    )
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|ul|ol|table|tr|blockquote|pre|dl|dt|dd|header|figure|figcaption|main)\s*>/gi,
      "\n\n",
    )
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  const lines = t
    .split("\n")
    .map((l) =>
      l
        .replace(/[ \t 　]+/g, " ")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractTitle(html: string): string | undefined {
  const pick = (m: RegExpMatchArray | null) => {
    const v = m ? toText(m[1]).replace(/\s+/g, " ") : "";
    return v || undefined;
  };
  return (
    pick(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)) ??
    pick(
      html.match(
        /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
      ),
    ) ??
    pick(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i))
  );
}

export function extractReadable(
  html: string,
  limit = WEBPAGE_TEXT_LIMIT,
): { title?: string; text: string; truncated: boolean } {
  const title = extractTitle(html);
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP_WITH_CONTENT) body = removeElements(body, tag);
  // Prefer the page's declared main content when it carries real text.
  const main =
    innerOf(body, "<main\\b[^>]*>", "main") ??
    innerOf(body, "<article\\b[^>]*>", "article") ??
    innerOf(body, "<div\\b[^>]*role=[\"']main[\"'][^>]*>", "div");
  if (main && toText(main).length >= 200) body = main;
  for (const tag of DROP_BLOCKS) body = removeElements(body, tag);
  const text = toText(body);
  const truncated = text.length > limit;
  return { title, text: truncated ? text.slice(0, limit) : text, truncated };
}

export function normalizePlainText(text: string, limit = WEBPAGE_TEXT_LIMIT) {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = clean.length > limit;
  return { text: truncated ? clean.slice(0, limit) : clean, truncated };
}
