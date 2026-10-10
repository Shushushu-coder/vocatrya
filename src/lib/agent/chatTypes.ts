import type { UIMessage } from "ai";
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
};

export type ChatLockKind = "account" | "legacy" | "managed";

export type ChatConversationSnapshot = ChatConversationSummary & {
  revision: number;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  lockKind: ChatLockKind;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
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
  | { kind: "blocked"; code: string; connectionId?: string }
  | { kind: "legacy"; model: string | null; persisted: boolean };

export type EligibleChatModel = {
  connectionId: string;
  model: string;
  displayName: string;
  provider: string;
};
