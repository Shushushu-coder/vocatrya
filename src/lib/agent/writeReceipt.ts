import { isToolUIPart, type UIMessage } from "ai";

// One predicate, two consumers: admitConversationRequest enforces it inside
// the admission transaction, and the answer action row mirrors it so a
// regenerate button is only offered where the route would actually admit the
// turn. Keep it client-safe — no "server-only" import in this module.
// EXT-NOTION writes return { saved: true } receipts — the same "a write
// already landed" semantics that block regenerate-as-if-it-never-happened.
const writeTools = new Set([
  "add_job",
  "match_job",
  "generate_cover_letter",
  "today_plan",
  "notion_create_page",
  "notion_append_content",
  "notion_update_record",
  "notion_update_content",
  "notion_delete_pages",
  "feishu_create_doc",
  "feishu_append_content",
  "feishu_update_content",
]);

export function hasWriteReceipt(message: UIMessage) {
  return message.parts.some(part => isToolUIPart(part) && writeTools.has(part.type.replace(/^tool-/, "")) &&
    part.state === "output-available" && !!part.output && typeof part.output === "object" &&
    ((part.output as { created?: boolean; saved?: boolean }).created === true || (part.output as { saved?: boolean }).saved === true));
}

// The regenerate admission rule's tail check: a saved business fact anywhere
// after the last user message can never be discarded by re-answering it, so
// both sides refuse the turn instead of pretending the write did not happen.
export function regenerateTailHasWriteReceipt(messages: UIMessage[]): boolean {
  return messages.slice(messages.findLastIndex(m => m.role === "user") + 1).some(hasWriteReceipt);
}
