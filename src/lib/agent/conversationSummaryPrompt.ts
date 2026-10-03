import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { isAgentPastePart } from "@/models/agent.model";

/** The only supported summary contract. Older text is stale, not reinterpreted. */
export const CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION = "career-dialogue-summary-v1";

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

const SAFE_STATUS = /^[a-z0-9_-]{1,40}$/i;

/**
 * Participant-readable projection. Database ids, tool payloads, approval
 * secrets, provider metadata, and reasoning never enter the summarizer.
 */
export function projectConversationSummaryInput(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = visibleUserText(message);
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        if (part.text.trim()) lines.push(`Assistant: ${part.text.trim()}`);
        continue;
      }
      if (!isToolUIPart(part) || !TERMINAL_TOOL_STATES.has(part.state)) continue;
      const name = getToolName(part);
      if (part.state === "output-denied") {
        lines.push(`The user declined to run ${name}.`);
        continue;
      }
      if (part.state === "output-error") {
        lines.push(`Tool ${name} failed.`);
        continue;
      }
      const status = safeStatus(part.output);
      lines.push(
        status ? `Tool ${name} finished (${status}).` : `Tool ${name} finished.`,
      );
    }
  }
  return lines.join("\n");
}

export function buildCareerDialogueSummaryPrompt(projection: string): string {
  return [
    `Summary contract: ${CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION}.`,
    [
      "Write a plain-text memory of this career dialogue for the assistant's later turns.",
      "Use the conversation's language. Be concise. Aim for about 500 tokens and stay under 1000.",
      "Preserve the current discussion goals, explicit user constraints and preferences, agreed conclusions, unresolved questions, and the references needed to understand later follow-ups.",
      "Do not infer stable personality traits. Do not invent career facts or turn speculation into truth. Do not claim résumé or job facts that are not explicit in the dialogue.",
      "Do not include database ids, tool ids, tokens, signatures, provider metadata, or runtime metadata. Do not dump raw tool JSON, rewrite the full transcript, duplicate a job posting or résumé, or narrate system and tool mechanics.",
    ].join("\n"),
    "Dialogue:",
    projection,
  ].join("\n\n");
}

function visibleUserText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) => {
      if (part.type === "text") return part.text.trim();
      if (isAgentPastePart(part)) return "(pasted job posting)";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function safeStatus(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const status = (output as { status?: unknown }).status;
  if (typeof status !== "string" || !SAFE_STATUS.test(status)) return null;
  return status;
}
