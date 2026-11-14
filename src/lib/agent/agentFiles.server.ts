import "server-only";

import { APP_CONSTANTS } from "@/lib/constants";
import {
  extractText,
  sniffFileType,
  type ExtractionResult,
} from "@/lib/ai/import/extract-text";
import { sniffAgentFileKind } from "@/lib/agent/agentFiles";

// Server-side extraction for agent file attachments (AWU-FILES). PDF/DOCX
// reuse the resume-import pipeline unchanged (page cap, char cap, timeout,
// DOCX bomb pre-flight); .txt/.md decode straight from the buffer — the
// magic-byte sniffer cannot name them, so the extension/MIME hint picks the
// branch and the decode itself is the validation.
export async function extractAgentFile(
  buf: Buffer,
  hint: { name: string; mediaType: string },
): Promise<ExtractionResult> {
  // Magic bytes decide for binaries — a renamed payload cannot talk its way
  // into the PDF/DOCX path. Text has no magic, so the .txt/.md hint decides
  // there and the UTF-8 decode below is the real validation.
  const kind =
    sniffFileType(buf) ??
    (sniffAgentFileKind(hint) === "text" ? "text" : null);
  if (!kind) {
    return {
      success: false,
      error: {
        code: "UNSUPPORTED_FORMAT",
        message:
          "Only .txt, .md, .pdf and .docx files can be attached to a conversation.",
      },
    };
  }
  if (kind !== "text") {
    return extractText(buf);
  }

  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) {
    return {
      success: false,
      error: {
        code: "NO_TEXT",
        message: "Couldn't read any text from this file.",
      },
    };
  }
  const truncated = text.length > APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS;
  return {
    success: true,
    data: {
      text: truncated
        ? text.slice(0, APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS)
        : text,
      truncated,
    },
  };
}
