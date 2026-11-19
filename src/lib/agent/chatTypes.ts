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
  executionPath?: string;
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

export type NativeUnavailableReason =
  | "CONNECTION_INELIGIBLE"
  | "RUNTIME_NOT_READY"
  | "RUNTIME_VERSION_MISMATCH"
  | "MODEL_UNSUPPORTED";

export type NativeUnavailableDetails = {
  reason: NativeUnavailableReason;
  /** The probed runtime version (e.g. "0.165.0"), or null when unprobed. */
  runtimeVersion: string | null;
  /** The version the capability certifies (e.g. "0.169.0"), when known. */
  requiredVersion: string | null;
  model: string | null;
  /** The certified model allowlist, when the runtime advertises one. */
  models: string[] | null;
};

/**
 * The Codex pair a NEW native conversation would lock to, resolved against
 * connected Codex account connections and the runtime's native gate — the
 * model picker probes this before offering the entry, so an unavailable
 * entry renders grey with a reason instead of failing on click.
 */
export type NativeChatEntry =
  | { ok: true; connectionId: string; model: string; displayName: string }
  | { ok: false; details: NativeUnavailableDetails };

export type AgentToolPermissionSnapshot = {
  permissionMode?: import("./preferences").PermissionMode;
  role: AgentRole | null;
  tools: { name: string; approval: "always" | "conditional" | "none" }[];
};
