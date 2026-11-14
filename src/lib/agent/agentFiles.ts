import { APP_CONSTANTS } from "@/lib/constants";
import { isAgentFilePart, type AgentFilePartData } from "@/models/agent.model";
import type { UIMessage } from "ai";

// Shared (client-safe) file-attachment helpers for AWU-FILES. Extraction
// lives in agentFiles.server.ts; this module holds the contract both sides
// of the wire enforce.

export type AgentFileChipStatus = "extracting" | "ready" | "error";

// The composer's unsent file card. `text` is present only once the extract
// endpoint returned it — it is what the data-file part carries on send.
export type AgentFileChip = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  status: AgentFileChipStatus;
  chars?: number;
  truncated?: boolean;
  text?: string;
  errorCode?: string;
};

// The hidden input's accept list and the client pre-check share this one
// string. Server re-validates regardless — a forged accept or extension
// cannot reach the extractor.
export const AGENT_FILE_ACCEPT =
  ".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TEXT_EXTENSIONS = [".txt", ".md"];
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

// Format the server will pick for a file of this name/type. Mirrors
// agentFiles.server.ts's detection so the client can reject before upload;
// the server does not trust this answer. A DOM File carries `type`; the
// endpoint's JSON body carries `mediaType` — both answer here.
export function sniffAgentFileKind(file: {
  name: string;
  type?: string;
  mediaType?: string;
}): "text" | "pdf" | "docx" | null {
  const name = file.name.toLowerCase();
  const mime = file.type ?? file.mediaType ?? "";
  if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) return "text";
  if (TEXT_MIME_TYPES.has(mime)) return "text";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  )
    return "docx";
  return null;
}

// Filename carried into the part and rendered on the card: basename only,
// whitespace-collapsed, length-bounded. Browsers already strip paths, but
// the part is also writable from any client, so the shape is enforced on
// admission too.
export function sanitizeAgentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\s+/g, " ").trim().slice(0, 255) || "file";
}

// File texts for THIS turn — resolved from the newest user message only.
// Unlike the paste (which lingers for a bounded window waiting on add_job),
// a file is injected exactly once, on the turn it arrived; later turns see
// the part's placeholder line, not its text again.
export function resolveFileTexts(
  messages: UIMessage[],
): { name: string; text: string }[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return [];
  const files: { name: string; text: string }[] = [];
  for (const part of last.parts ?? []) {
    if (!isAgentFilePart(part)) continue;
    if (files.length >= APP_CONSTANTS.AGENT_FILE_MAX_PER_MESSAGE) break;
    files.push({ name: part.data.name, text: part.data.text });
  }
  return files;
}

// The transcript placeholder a data-file part renders as in later turns
// (and what keeps a file-only user message a complete turn).
export function agentFilePlaceholder(name: string): string {
  return `(attached file: ${name})`;
}

export function fileChipToPartData(chip: AgentFileChip): AgentFilePartData | null {
  if (chip.status !== "ready" || typeof chip.text !== "string") return null;
  return {
    id: chip.id,
    name: chip.name,
    mediaType: chip.mediaType,
    size: chip.size,
    chars: chip.chars ?? chip.text.length,
    truncated: chip.truncated ?? false,
    text: chip.text,
  };
}
