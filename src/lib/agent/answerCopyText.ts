import { stripThinking } from "@/lib/ai/stripThinking";

type TextPartLike = { type: string; text?: unknown; [key: string]: unknown };

// Copy scope is exactly what the answer shows: its visible text parts, in
// display order. Reasoning parts and <think> leftovers are hidden from the
// reader, so they must not reach the clipboard either; tool parts carry raw
// params/output the user never saw, and other messages are out of scope.
// The join is Markdown source (what AgentMarkdown renders from), so line
// breaks and structure survive a paste into both markdown and plain fields.
export function assistantAnswerCopyText(
  parts: readonly TextPartLike[],
): string {
  const visible = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => stripThinking(part.text))
    .filter((text) => text.trim().length > 0);
  return visible.join("\n\n").trim();
}
