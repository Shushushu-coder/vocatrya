import type { UIMessage } from "ai";
import type { AgentRole } from "./agentRoles";
import type { AgentConversationContextV1 } from "./conversationContext";

export type ExplicitModelSelection = {
  connectionId: string;
  model: string;
};

export type ChatConversationSummary = {
  id: string;
  title: string | null;
  titleFallback: string | null;
  createdAt: string;
  updatedAt: string;
  /** Fixed at creation; NULL on pre-multi-agent rows renders as 通用. */
  agentRole: AgentRole | null;
};

export type ChatLockKind = "account" | "legacy" | "managed";

export type ChatConversationSnapshot = ChatConversationSummary & {
  revision: number;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  lockKind: ChatLockKind;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  /** Non-null on archived rows — Archive Center read-only views use it. */
  archivedAt: string | null;
};

export type AgentChatPreflight =
  | {
      kind: "account";
      connectionId: string;
      provider: string;
      backendKind: string;
      model: string;
      displayName: string;
      locked: boolean;
    }
  | {
      /**
       * Managed (Hosted) source — runs through the bound Managed
       * connection/model with the conversation's provenance; no desktop
       * runtime gate applies.
       */
      kind: "managed";
      connectionId: string;
      model: string;
      displayName: string;
      locked: boolean;
    }
  | { kind: "blocked"; code: string; connectionId?: string; model?: string | null; displayName?: string | null; locked?: boolean }
  | { kind: "legacy"; model: string | null; persisted: boolean };

export type EligibleChatModel = {
  connectionId: string;
  model: string;
  displayName: string;
  provider: string;
};

export type AgentToolPermissionSnapshot = {
  role: AgentRole | null;
  tools: { name: string; approval: "always" | "conditional" | "none" }[];
};
