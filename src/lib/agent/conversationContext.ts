import type { UIMessage } from "ai";
import type { PageContext } from "@/models/agent.model";

export const AGENT_CONVERSATION_CONTEXT_VERSION = 1 as const;
export const AGENT_CONTEXT_KINDS = ["job", "resume"] as const;
export type AgentContextKind = (typeof AGENT_CONTEXT_KINDS)[number];
export type AgentContextSource = "AUTO" | "MANUAL";

export type AgentConversationContextItem = {
  kind: AgentContextKind;
  entityId: string;
  labelSnapshot: string;
  source: AgentContextSource;
};

export type AgentConversationContextV1 = {
  version: 1;
  items: AgentConversationContextItem[];
};

export const EMPTY_CONVERSATION_CONTEXT: AgentConversationContextV1 = {
  version: 1,
  items: [],
};

export const CONVERSATION_TITLE_MAX = 80;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeTitleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateTitle(
  value: string,
  max = CONVERSATION_TITLE_MAX,
): string {
  const normalized = normalizeTitleText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function isClearlyUsefulLabel(
  label: string,
  entityId?: string,
): boolean {
  const normalized = normalizeTitleText(label);
  if (!normalized) return false;
  if (entityId && normalized === entityId) return false;
  if (UUID_RE.test(normalized)) return false;
  return true;
}

export function contextItemKey(item: {
  kind: string;
  entityId: string;
}): string {
  return `${item.kind}:${item.entityId}`;
}

export function deriveConversationTitle(input: {
  context?: AgentConversationContextV1 | null;
  firstUserText?: string | null;
}): string | null {
  const primary = input.context?.items.find((item) =>
    isClearlyUsefulLabel(item.labelSnapshot, item.entityId),
  );
  if (primary) return truncateTitle(primary.labelSnapshot);
  if (!input.firstUserText) return null;
  const text = truncateTitle(input.firstUserText);
  return text || null;
}

export function firstUserMessageText(
  messages: Array<{
    role?: string;
    parts?: Array<{ type?: string; text?: string }>;
  }>,
): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" ");
    const normalized = normalizeTitleText(text);
    if (normalized) return normalized;
  }
  return null;
}

export function titleFallbackFromMessages(messagesJson: string): string | null {
  try {
    const messages = JSON.parse(messagesJson) as unknown;
    if (!Array.isArray(messages)) return null;
    const text = firstUserMessageText(messages);
    return text ? truncateTitle(text) : null;
  } catch {
    return null;
  }
}

export function titleFallbackFromUiMessages(
  messages: UIMessage[],
): string | null {
  const text = firstUserMessageText(messages);
  return text ? truncateTitle(text) : null;
}

function isContextItem(value: unknown): value is AgentConversationContextItem {
  if (!value || typeof value !== "object") return false;
  const item = value as AgentConversationContextItem;
  return (
    (item.kind === "job" || item.kind === "resume") &&
    typeof item.entityId === "string" &&
    item.entityId.length > 0 &&
    typeof item.labelSnapshot === "string" &&
    (item.source === "AUTO" || item.source === "MANUAL")
  );
}

export function parseConversationContext(
  raw: string | null | undefined,
): AgentConversationContextV1 {
  if (!raw) return { version: 1, items: [] };
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      items?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
      return { version: 1, items: [] };
    }
    return {
      version: 1,
      items: parsed.items.filter(isContextItem).map((item) => ({
        kind: item.kind,
        entityId: item.entityId,
        labelSnapshot: item.labelSnapshot,
        source: item.source,
      })),
    };
  } catch {
    return { version: 1, items: [] };
  }
}

export function serializeConversationContext(
  context: AgentConversationContextV1,
): string {
  return JSON.stringify({
    version: AGENT_CONVERSATION_CONTEXT_VERSION,
    items: context.items,
  });
}

/** Tool/page closures read the persisted conversation, never the live route. */
export function pageContextFromConversation(
  context: AgentConversationContextV1 | null | undefined,
): PageContext {
  const job = context?.items.find((item) => item.kind === "job");
  const resume = context?.items.find((item) => item.kind === "resume");
  return {
    ...(job ? { jobId: job.entityId } : {}),
    ...(resume ? { resumeId: resume.entityId } : {}),
  };
}

export type ContextItemRequest = {
  kind: string;
  entityId: string;
  source: string;
};

export function dedupeContextItems(
  items: AgentConversationContextItem[],
): AgentConversationContextItem[] {
  const seen = new Set<string>();
  const next: AgentConversationContextItem[] = [];
  for (const item of items) {
    const key = contextItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}
