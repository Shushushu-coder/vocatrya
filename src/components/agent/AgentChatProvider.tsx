"use client";
import type { PermissionMode } from "@/lib/agent/preferences";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import {
  generateId,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { VocatryaChatTransport, readAgentChatError } from "@/lib/agent/chatTransport";
import { hasPendingApproval, stubConsumedPastes } from "@/lib/agent/paste";
import { pageContextFor } from "@/lib/agent/pageContext";
import { writeActiveConversationId } from "@/lib/agent/activeConversation";
import {
  bindAgentSlotOwner,
  notifyAgentSlotWrite,
  readActiveAgentRole,
  readAgentRoleSlots,
  writeActiveAgentRole,
  writeAgentRoleSlot,
  type StoredRoleSlot,
} from "@/lib/agent/activeAgentRole";
import {
  currentAgentSlotGeneration,
  installAgentSlotMirror,
  restoreDurableAgentSlots,
} from "@/lib/agent/roleSlotPersistence";
import {
  GENERAL_AGENT_SLOT,
  isAgentRole,
  normalizeAgentRole,
  slotRoleFor,
  type AgentRole,
} from "@/lib/agent/agentRoles";
import { useRightRail } from "@/context/RightRailContext";
import { useSidebar } from "@/context/SidebarContext";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { APP_CONSTANTS } from "@/lib/constants";
import { toastInfo } from "@/lib/toast";
import { useI18n } from "@/i18n";
import {
  archiveChatConversation,
  createChatConversation,
  restartNativeChat,
  deleteChatConversation,
  getAgentChatPreflight,
  getChatConversation,
  getNativeChatEntry,
  listChatConversations,
  resolveDraftPageContext,
  cancelChatConversationRequest,
  updateChatConversationContext,
} from "@/actions/agentChat.actions";
import { getUserSettings } from "@/actions/userSettings.actions";
import { checkOllamaConnection } from "@/utils/ai.utils";
import { AiProvider } from "@/models/ai.model";
import { AI_CONFIGURATION_CHANGED_EVENT } from "@/lib/ai/client-events";
import {
  AGENT_NESTED_STREAM_PART_TYPE,
  isAgentFilePart,
  isAgentPastePart,
  isNestedTool,
  type AgentAddJobResult,
  type AgentNestedStreamData,
  type AgentPastePartData,
} from "@/models/agent.model";
import {
  sanitizeAgentFileName,
  sniffAgentFileKind,
  type AgentFileChip,
} from "@/lib/agent/agentFiles";
import {
  AGENT_CONTEXT_USAGE_PART_TYPE,
  type AgentContextUsage,
} from "@/lib/agent/contextUsage";
import {
  AGENT_UNIFIED_STATUS_PART_TYPE,
  type AgentUnifiedStatusData,
} from "@/lib/agent/unifiedChatTypes";
import {
  dedupeContextItems,
  EMPTY_CONVERSATION_CONTEXT,
  type AgentConversationContextItem,
  type AgentConversationContextV1,
} from "@/lib/agent/conversationContext";
import type {
  ChatConversationSummary,
  ChatLockKind,
  ExplicitModelSelection,
} from "@/lib/agent/chatTypes";

export const AGENT_CHAT_PANEL_ID = "chat";

export type AgentChatIdentity = {
  checked: boolean;
  ok: boolean;
  kind: "account" | "managed" | "legacy" | "blocked" | "unknown";
  locked: boolean;
  model: string | null;
  displayName: string | null;
  persistedLegacy: boolean;
  code?: string;
};

export type AgentChatInitialConversation = {
  executionPath?: string;
  revision: number;
  id: string;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  lockKind: ChatLockKind;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  title: string | null;
  titleFallback: string | null;
  /** Persisted role — decides which slot this row mounts into. */
  agentRole?: AgentRole | null;
  /** Persisted task binding, so the task card restores its selection on reload. */
  agentTaskId?: string | null;
};

export type AgentCompactionFeedback = {
  kind: "success" | "skipped" | "busy" | "error";
  code?: string;
  beforeTokens?: number | null;
  afterTokens?: number | null;
};

type QueuedMessage = { parts: UIMessage["parts"] };

type AgentChatValue = ReturnType<typeof useAgentChatValue>;

const AgentChatContext = createContext<AgentChatValue | null>(null);

const UNKNOWN_IDENTITY: AgentChatIdentity = {
  checked: false,
  ok: true,
  kind: "unknown",
  locked: false,
  model: null,
  displayName: null,
  persistedLegacy: false,
};

function createdJobToolCallIds(messages: UIMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      if (getToolName(part) !== "add_job") continue;
      if ((part.output as AgentAddJobResult | undefined)?.created !== true) continue;
      ids.push(part.toolCallId);
    }
  }
  return ids;
}

function savedWriteCallIds(messages: UIMessage[]): Set<string> {
  return new Set(messages.flatMap(message => message.parts.flatMap(part => {
    if (!isToolUIPart(part) || part.state !== "output-available" || !part.output || typeof part.output !== "object") return [];
    const output = part.output as { created?: boolean; saved?: boolean };
    return output.created === true || output.saved === true ? [part.toolCallId] : [];
  })));
}

function firstText(parts: UIMessage["parts"]): string | null {
  for (const part of parts) {
    if (part.type === "text" && part.text.trim()) return part.text.trim();
  }
  return null;
}

function contextRequests(items: AgentConversationContextItem[]) {
  return items.map((item) => ({
    kind: item.kind,
    entityId: item.entityId,
    source: item.source,
  }));
}

// The handoff carries the whole request, not just its text: the paste card
// and extracted file parts already live inside the source user message.
// Locate the request by the suggest_role call that answered it, then
// materialize those parts back into unsent chips on the target slot.
function harvestTransferSource(
  messages: UIMessage[],
  toolCallId: string | undefined,
): { paste: AgentPastePartData | null; files: AgentFileChip[] } | null {
  if (!toolCallId) return null;
  const assistantIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.parts?.some(
        (part) => isToolUIPart(part) && part.toolCallId === toolCallId,
      ),
  );
  if (assistantIndex < 0) return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const parts = message.parts ?? [];
    const paste = parts.find(isAgentPastePart)?.data ?? null;
    const files = parts.filter(isAgentFilePart).map(
      (part): AgentFileChip => ({
        id: part.data.id,
        name: part.data.name,
        mediaType: part.data.mediaType,
        size: part.data.size,
        status: "ready",
        chars: part.data.chars,
        truncated: part.data.truncated,
        text: part.data.text,
      }),
    );
    return { paste, files };
  }
  return null;
}

function identityFromInitial(
  initial: AgentChatInitialConversation | null,
): AgentChatIdentity {
  if (!initial) return UNKNOWN_IDENTITY;
  if (initial.lockKind === "account" || initial.lockKind === "managed") {
    return {
      checked: false,
      ok: true,
      kind: initial.lockKind,
      locked: true,
      model: initial.resolvedModel,
      displayName: null,
      persistedLegacy: false,
    };
  }
  return {
    checked: false,
    ok: true,
    kind: "legacy",
    locked: false,
    model: null,
    displayName: null,
    persistedLegacy: true,
  };
}

// Which slot a mount opens into: the loaded conversation's own role (NULL
// rows slot under Pilot), else the role the user last had active, else the
// default Pilot slot.
function mountRole(initial: AgentChatInitialConversation | null): AgentRole {
  if (initial) return slotRoleFor(initial.agentRole ?? null);
  return readActiveAgentRole() ?? GENERAL_AGENT_SLOT;
}

// The draft state a slot restores when it has no persisted conversation.
// Stored slots carry context and an explicit model pick alongside the
// unsent composer text — all three are per-role (D1).
function mountDraft(
  slot: StoredRoleSlot | undefined,
): {
  context: AgentConversationContextV1;
  explicit: ExplicitModelSelection | null;
  draft: string | null;
  paste: AgentPastePartData | null;
} {
  return {
    context: slot?.context ?? EMPTY_CONVERSATION_CONTEXT,
    explicit: slot?.explicit ?? null,
    draft: slot?.draft ?? null,
    paste: slot?.paste ?? null,
  };
}

function useAgentChatValue(
  initial: AgentChatInitialConversation | null,
  seedMessages: UIMessage[],
  userId: string | null,
) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { holder, requestOpen, close: releaseRail } = useRightRail();
  const { expanded: sidebarExpanded, collapse: collapseSidebar } = useSidebar();

  const [isOpen, setIsOpen] = useState(false);
  const {
    width: panelWidth,
    handleMouseDown: startResize,
    isDragging: isResizing,
    isExpanded: isPanelExpanded,
    toggleExpand,
  } = useResizablePanel(
    APP_CONSTANTS.AGENT_CHAT_PANEL_WIDTH_KEY,
    APP_CONSTANTS.AGENT_CHAT_PANEL_MIN_WIDTH,
  );

  // Passive navigation/sidebar changes restore the docked width before paint.
  const lastPathnameRef = useRef(pathname);
  useLayoutEffect(() => {
    const navigated = lastPathnameRef.current !== pathname;
    lastPathnameRef.current = pathname;
    if (isPanelExpanded && (sidebarExpanded || navigated)) toggleExpand();
  }, [sidebarExpanded, isPanelExpanded, pathname, toggleExpand]);

  // Collapse the sidebar and expand against its final footprint in one commit;
  // measuring its animated DOM width here would produce a stale target.
  const togglePanelExpand = useCallback(() => {
    if (isPanelExpanded) {
      toggleExpand();
      return;
    }
    if (sidebarExpanded) collapseSidebar();
    toggleExpand(window.innerWidth - APP_CONSTANTS.SIDEBAR_COLLAPSED_OUTER_PX);
  }, [isPanelExpanded, sidebarExpanded, collapseSidebar, toggleExpand]);

  // Presentation-only completion signal; errors, aborts and approval waits stay idle.
  const [brandCompletion, setBrandCompletion] = useState(0);
  const [identity, setIdentity] = useState<AgentChatIdentity>(() =>
    identityFromInitial(initial),
  );
  const [nativeStatus, setNativeStatus] = useState<"waiting" | "resumed" | "created">("waiting");
  const [nativeSession, setNativeSession] = useState(initial?.executionPath === "NATIVE_CODEX_V1");
  // Agent long-task binding of the open conversation (card E task card).
  const [taskBinding, setTaskBinding] = useState<{ conversationId: string; taskId: string } | null>(
    initial?.id && initial.agentTaskId ? { conversationId: initial.id, taskId: initial.agentTaskId } : null,
  );
  // The task card's manual pick lives in the provider so a panel close —
  // which unmounts the card — does not lose it.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    initial?.id ?? null,
  );
  const [conversationTitle, setConversationTitle] = useState<string | null>(
    initial?.title ?? initial?.titleFallback ?? null,
  );
  const [unifiedStatus, setUnifiedStatus] =
    useState<AgentUnifiedStatusData | null>(null);
  const [failedStep, setFailedStep] = useState<{
    turnId: string;
    stepIndex: number;
    role: AgentRole;
    message?: string;
  } | null>(null);
  // Multi-agent slots (D1): the mount role comes from the loaded
  // conversation or the last-active preference; a draft slot restores its
  // stored context/model/draft. hasStoredContext tells the mount effect the
  // draft already owns its objects — only a truly fresh draft resolves the
  // page AUTO item. A mounted conversation still picks its unsent draft
  // back up when the stored slot names the same row.
  const [initialSlot] = useState(() => {
    // Restore the data-root snapshot before the first AUTO decision. A new
    // loopback port has an empty localStorage; the signed-in user's slots,
    // including an explicit empty context, have to be visible to mountRole.
    installAgentSlotMirror();
    bindAgentSlotOwner(userId);
    if (userId) restoreDurableAgentSlots(userId, currentAgentSlotGeneration());
    const role = mountRole(initial);
    const stored = readAgentRoleSlots()[role];
    if (initial) {
      return {
        role,
        hasStoredContext: true,
        preservedConversationId: null as string | null,
        draft:
          stored?.conversationId === initial.id && (stored.draft || stored.paste)
            ? {
                context: EMPTY_CONVERSATION_CONTEXT,
                explicit: null,
                draft: stored.draft,
                paste: stored.paste ?? null,
              }
            : null,
      };
    }
    return {
      role,
      // A stored conversation pointer is that role's session. An explicit
      // empty context is a clear. Either one is already resolved, so AUTO
      // must not replace it. Only a slot with no context and no pointer
      // is a fresh draft.
      hasStoredContext: stored?.context !== undefined || Boolean(stored?.conversationId),
      preservedConversationId: stored?.conversationId ?? null,
      draft: mountDraft(stored),
    };
  });
  const [activeRole, setActiveRole] = useState<AgentRole>(initialSlot.role);
  const [draftPermissionMode, setDraftPermissionMode] = useState<PermissionMode | undefined>();
  const [context, setContext] = useState<AgentConversationContextV1>(
    initial?.context ?? initialSlot.draft?.context ?? EMPTY_CONVERSATION_CONTEXT,
  );
  const [explicit, setExplicit] = useState<ExplicitModelSelection | null>(
    initialSlot.draft?.explicit ?? null,
  );
  const [actionError, setActionError] = useState<{
    code: string;
    details?: unknown;
  } | null>(null);
  // Display-only dismissal of the preflight banner — it never lifts the
  // send restriction, which stays bound to identity.ok.
  const [preflightDismissed, setPreflightDismissed] = useState(false);
  const [contextPickerNonce, setContextPickerNonce] = useState(0);
  const [modelPickerNonce, setModelPickerNonce] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const conversationIdRef = useRef<string | null>(initial?.id ?? null);
  // The mounted row is authoritative. When this origin has not loaded a row
  // yet, the restored slot pointer still has to survive a snapshot.
  const slotPointerRef = useRef<string | null>(initialSlot.preservedConversationId);
  const revisionRef = useRef(initial?.revision ?? 0);
  const activeExecutionRef = useRef<{
    conversationId: string;
    requestId: string;
    existingWrites: Set<string>;
    operation?: "send" | "regenerate" | "approval" | "reanswer" | "retry_step";
    /** The user message a rejected "send" would re-issue. */
    message?: UIMessage;
    /** The tail message a rejected "regenerate" re-targets. */
    targetMessageId?: string;
    /** One automatic re-issue per user action, never more. */
    retried?: boolean;
  } | null>(null);
  const pendingSpecialOpRef = useRef<
    | { operation: "reanswer"; targetMessageId: string; role: AgentRole }
    | { operation: "retry_step"; turnId: string; stepIndex: number }
    | null
  >(null);
  const needsDurableSyncRef = useRef(false);
  const completedExecutionRef = useRef<string | null>(null);
  const recoveryRef = useRef<{ conversationId: string; requestId: string } | null>(null);
  const recoveryBlockedRef = useRef(false);
  const selectionEpochRef = useRef(0);
  const roleSelectionPendingRef = useRef(false);
  const preflightEpochRef = useRef(0);
  const [recoveryFailure, setRecoveryFailure] = useState<{
    conversationId: string; requestId: string; operation: "reload" | "cancel";
  } | null>(null);
  const selectedApprovalRef = useRef<string | null>(null);
  const approvalSendingRef = useRef(false);
  const durableApprovalRef = useRef(Boolean(initial));
  const conflictRef = useRef(false);
  // Arms exactly one automatic re-issue after a CAS conflict reload: the
  // replayed request carries retried=true, so a second rejection surfaces
  // the banner instead of looping. A fresh user action re-arms the retry.
  const replayNextRequestRef = useRef(false);
  const regenerateTargetRef = useRef<string | null>(null);
  // Status lags one render behind the click, so an in-flight ref is the only
  // thing that stops a fast second click from opening a second request.
  const regenerateInFlightRef = useRef(false);
  const contextRef = useRef(context);
  const explicitRef = useRef<ExplicitModelSelection | null>(
    initialSlot.draft?.explicit ?? null,
  );
  const lockKindRef = useRef<ChatLockKind | null>(initial?.lockKind ?? null);
  const creatingRef = useRef(false);
  const draftResolvedRef = useRef(initial !== null);
  // A slot's context is "settled" only once the draft actually owns it —
  // restored from storage, resolved by the server, or explicitly edited by
  // the user. Until then contextRef holds the EMPTY placeholder, and
  // snapshots must not persist it: stored context is what marks a slot as
  // already resolved, so writing EMPTY would disarm AUTO attach forever.
  const contextSettledRef = useRef(initialSlot.hasStoredContext);
  const activeRoleRef = useRef<AgentRole>(initialSlot.role);
  // The composer is controlled by AgentChatInput's PromptInputProvider; it
  // registers this API so the provider can read the draft on a role switch
  // and write through fillComposer without owning the text.
  const composerApiRef = useRef<{
    read: () => string;
    set: (text: string) => void;
  } | null>(null);
  // Next mount's initial text — a role switch or a fill while the composer
  // is unmounted lands here, and a nonce bump remounts the provider on it.
  // The ref mirrors every seed write so a snapshot taken after the
  // composer's unmount still sees the text it last held (e.g. a model
  // switch remounts the composer before its slot write ever ran).
  const [composerSeed, setComposerSeed] = useState<string>(
    initialSlot.draft?.draft ?? "",
  );
  const composerSeedRef = useRef(composerSeed);
  const updateComposerSeed = useCallback((text: string) => {
    composerSeedRef.current = text;
    setComposerSeed(text);
  }, []);
  // The unsent paste chip lives here (not in the composer) so a model
  // switch's composer remount does not lose it, and so the slot record can
  // serialize it alongside the draft it was prepared for.
  const [pasteChip, setPasteChipState] = useState<AgentPastePartData | undefined>(
    () => initialSlot.draft?.paste ?? undefined,
  );
  const pasteChipRef = useRef<AgentPastePartData | undefined>(pasteChip);
  const setPasteChip = useCallback((data: AgentPastePartData | undefined) => {
    pasteChipRef.current = data;
    setPasteChipState(data);
  }, []);
  // Unsent file cards (AWU-FILES): same provider-side home as the paste
  // chip so a composer remount keeps them. Deliberately NOT serialized into
  // role slots — the extracted text can be ~50k chars per file, and the
  // slot record already caps what it stores.
  const [fileChips, setFileChipsState] = useState<AgentFileChip[]>([]);
  const fileChipsRef = useRef<AgentFileChip[]>(fileChips);
  const setFileChips = useCallback(
    (next: AgentFileChip[] | ((prev: AgentFileChip[]) => AgentFileChip[])) => {
      setFileChipsState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        fileChipsRef.current = value;
        return value;
      });
    },
    [],
  );

  // Every picked file becomes a chip — including rejected ones, which sit
  // as removable error cards rather than being silently dropped. Only
  // non-error chips count toward the per-message cap. Chip construction
  // happens outside the state updater so StrictMode's double-invocation
  // cannot fork two extraction fetches for one file.
  const addFiles = useCallback(
    (incoming: File[] | FileList) => {
      let active = fileChipsRef.current.filter(
        (c) => c.status !== "error",
      ).length;
      const chips: AgentFileChip[] = [];
      const pending: { chip: AgentFileChip; file: File }[] = [];
      for (const file of incoming) {
        const base: AgentFileChip = {
          id: `file-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 10)}`,
          name: sanitizeAgentFileName(file.name),
          mediaType: file.type,
          size: file.size,
          status: "extracting",
        };
        if (active >= APP_CONSTANTS.AGENT_FILE_MAX_PER_MESSAGE) {
          chips.push({ ...base, status: "error", errorCode: "TOO_MANY" });
        } else if (file.size > APP_CONSTANTS.AGENT_FILE_MAX_BYTES) {
          chips.push({ ...base, status: "error", errorCode: "FILE_TOO_LARGE" });
        } else if (!sniffAgentFileKind(file)) {
          chips.push({
            ...base,
            status: "error",
            errorCode: "UNSUPPORTED_FORMAT",
          });
        } else {
          active += 1;
          chips.push(base);
          pending.push({ chip: base, file });
        }
      }
      setFileChips((prev) => [...prev, ...chips]);
      // Extract each accepted file once through the server route. Updates
      // land by id, so a chip removed mid-flight just never flips.
      for (const { chip, file } of pending) {
        void (async () => {
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (let i = 0; i < buf.length; i += 0x8000) {
              binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            }
            const res = await fetch("/api/ai/agent-file-extract", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: chip.name,
                mediaType: chip.mediaType,
                contentBase64: btoa(binary),
              }),
            });
            const body = (await res.json().catch(() => null)) as
              | {
                  name?: string;
                  chars?: number;
                  truncated?: boolean;
                  text?: string;
                  code?: string;
                }
              | null;
            setFileChips((prev) =>
              prev.map((c) => {
                if (c.id !== chip.id) return c;
                if (!res.ok || typeof body?.text !== "string") {
                  return {
                    ...c,
                    status: "error",
                    errorCode: body?.code ?? "EXTRACTION_FAILED",
                  };
                }
                return {
                  ...c,
                  name: body.name ?? c.name,
                  status: "ready",
                  chars: body.chars ?? body.text.length,
                  truncated: body.truncated ?? false,
                  text: body.text,
                };
              }),
            );
          } catch {
            setFileChips((prev) =>
              prev.map((c) =>
                c.id === chip.id
                  ? { ...c, status: "error", errorCode: "EXTRACTION_FAILED" }
                  : c,
              ),
            );
          }
        })();
      }
    },
    [setFileChips],
  );
  const removeFileChip = useCallback(
    (id: string) => setFileChips((prev) => prev.filter((c) => c.id !== id)),
    [setFileChips],
  );
  const clearFileChips = useCallback(
    () => setFileChips([]),
    [setFileChips],
  );
  // The last turn's assembled context size, streamed by the route for the
  // toolbar estimate. Absent on Legacy, which cannot report a real size —
  // the UI shows nothing rather than a fabricated number.
  const [contextUsage, setContextUsage] = useState<AgentContextUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactionFeedback, setCompactionFeedback] =
    useState<AgentCompactionFeedback | null>(null);
  const compactingRef = useRef(false);
  const clearCompactionFeedback = useCallback(
    () => setCompactionFeedback(null),
    [],
  );
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  contextRef.current = context;

  const pageContextRef = useRef(pageContextFor(pathname));
  useEffect(() => {
    pageContextRef.current = pageContextFor(pathname);
  }, [pathname]);

  const [toolStreams, setToolStreams] = useState<Record<string, string>>({});
  const [jobWrites, setJobWrites] = useState(0);
  const announcedJobWritesRef = useRef<Set<string> | null>(null);
  if (announcedJobWritesRef.current === null) {
    announcedJobWritesRef.current = new Set(
      createdJobToolCallIds(initial?.messages ?? seedMessages),
    );
  }

  const chat = useChat({
    messages: initial?.messages ?? seedMessages,
    transport: new VocatryaChatTransport({
      api: "/api/ai/chat",
      isCurrentRequest: (id) => id === activeExecutionRef.current?.requestId,
      prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
        const requestId = generateId();
        const id = conversationIdRef.current!;
        const specialOp = pendingSpecialOpRef.current;
        pendingSpecialOpRef.current = null;
        if (specialOp) {
          activeExecutionRef.current = {
            conversationId: id,
            requestId,
            existingWrites: savedWriteCallIds(messages),
            operation: specialOp.operation,
          };
          recoveryRef.current = null;
          completedExecutionRef.current = null;
          durableApprovalRef.current = false;
          return {
            headers: { "x-vocatrya-unified-chat": "1" },
            body: {
              conversationId: id,
              requestId,
              expectedRevision: revisionRef.current,
              ...specialOp,
            },
          };
        }
        const last = messages.at(-1);
        const replayed = replayNextRequestRef.current;
        replayNextRequestRef.current = false;
        const approval = last?.parts.find(p => isToolUIPart(p) && p.state === "approval-responded" && p.approval?.id === selectedApprovalRef.current);
        const operation = trigger === "regenerate-message" ? "regenerate" : approval ? "approval" : "send";
        activeExecutionRef.current = {
          conversationId: id, requestId, existingWrites: savedWriteCallIds(messages), operation,
          ...(replayed ? { retried: true } : {}),
          ...(operation === "send" && last ? { message: last } : {}),
          ...(operation === "regenerate" ? { targetMessageId: regenerateTargetRef.current ?? messageId } : {}),
        };
        recoveryRef.current = null;
        completedExecutionRef.current = null;
        durableApprovalRef.current = false;
        return {
          headers: { "x-vocatrya-unified-chat": "1" },
          body: {
            conversationId: id, requestId, expectedRevision: revisionRef.current, operation,
            ...(operation === "send" ? { newMessage: last } : operation === "regenerate" ? { targetMessageId: regenerateTargetRef.current ?? messageId } : {
              approvalId: isToolUIPart(approval!) ? approval!.approval?.id : undefined,
              decision: isToolUIPart(approval!) ? approval!.approval?.approved : undefined,
              reason: isToolUIPart(approval!) ? approval!.approval?.reason : undefined,
            }),
          },
        };
      },
    }),
    sendAutomaticallyWhen: (options) => !conflictRef.current && durableApprovalRef.current && Boolean(selectedApprovalRef.current) && Boolean(options.messages.at(-1)?.parts.some(p => isToolUIPart(p) && p.state === "approval-responded" && p.approval?.id === selectedApprovalRef.current)),
    onError: (error) => {
      const active = activeExecutionRef.current;
      if (!active || active.conversationId !== conversationIdRef.current || ("conversationRequestId" in error && error.conversationRequestId !== active.requestId)) return;
      const { code } = readAgentChatError(error);
      conflictRef.current = true;
      durableApprovalRef.current = false;
      selectedApprovalRef.current = null;
      approvalSendingRef.current = false;
      setQueued(undefined);
      recoveryRef.current = active;
      recoveryBlockedRef.current = true;
      const isCurrent = () => recoveryRef.current === active && activeExecutionRef.current?.requestId === active.requestId && conversationIdRef.current === active.conversationId;
      void (async () => {
        try {
          const result = await getChatConversation(active.conversationId);
          if (!isCurrent()) return;
          if (!result.success || !result.data) throw new Error("reload failed");
          revisionRef.current = result.data.revision;
          durableApprovalRef.current = true;
          recoveryBlockedRef.current = false;
          recoveryRef.current = null;
          chat.setMessages(result.data.messages);
          setHistoryVersion(n => n + 1);
          // A CAS rejection means the user's own operation never ran — the
          // reload just synced revision and transcript, so re-issuing the
          // same intent lands without a second click. retried bounds it to
          // one automatic re-issue per action, and a pending approval in the
          // durable transcript wins the user's attention over any replay.
          if (
            !active.retried &&
            (code === "CONVERSATION_STALE_WRITE" ||
              code === "CONVERSATION_TURN_CONFLICT") &&
            (active.operation === "send" || active.operation === "regenerate") &&
            !hasPendingApproval(result.data.messages)
          ) {
            active.retried = true;
            conflictRef.current = false;
            setActionError(null);
            chat.clearError();
            if (active.operation === "regenerate" && active.targetMessageId) {
              regenerateTargetRef.current = active.targetMessageId;
              regenerateInFlightRef.current = true;
              const settle = () => {
                regenerateInFlightRef.current = false;
              };
              try {
                replayNextRequestRef.current = true;
                void Promise.resolve(
                  chat.regenerate({ messageId: active.targetMessageId }),
                ).then(settle, settle);
              } catch {
                replayNextRequestRef.current = false;
                settle();
              }
            } else if (
              active.operation === "send" &&
              active.message &&
              !result.data.messages.some((m) => m.id === active.message!.id)
            ) {
              replayNextRequestRef.current = true;
              void chat.sendMessage({ parts: active.message.parts });
            } else {
              setActionError({ code });
            }
            return;
          }
          const savedWrite = [...savedWriteCallIds(result.data.messages)].some(id => !active.existingWrites.has(id));
          setActionError({ code: savedWrite && !code.startsWith("CONVERSATION_") ? "CONVERSATION_OPERATION_SAVED" : code });
          chat.clearError();
        } catch {
          setRecoveryFailure({ conversationId: active.conversationId, requestId: active.requestId, operation: "reload" });
          if (!isCurrent()) return;
          setActionError({ code: "CONVERSATION_REFRESH_FAILED" });
        }
      })();
    },
    onData: (part) => {
      if (part.type === "data-native-session") {
        const data = part.data as { conversationId: string; requestId: string; resumed: boolean };
        if (data.conversationId === conversationIdRef.current && data.requestId === activeExecutionRef.current?.requestId) setNativeStatus(data.resumed ? "resumed" : "created");
        return;
      }
      if (part.type === "data-conversation") {
        const data = part.data as { conversationId: string; requestId: string; revision: number; durable?: boolean; released?: boolean };
        if (data.conversationId !== conversationIdRef.current || data.requestId !== activeExecutionRef.current?.requestId) return;
        revisionRef.current = data.revision;
        if (data.durable && data.released) {
          completedExecutionRef.current = data.requestId;
          durableApprovalRef.current = true;
        }
        return;
      }
      if (part.type === AGENT_CONTEXT_USAGE_PART_TYPE) {
        const data = part.data as AgentContextUsage;
        if (data.conversationId !== conversationIdRef.current || data.requestId !== activeExecutionRef.current?.requestId) return;
        setContextUsage(data);
        return;
      }
      if (part.type === AGENT_UNIFIED_STATUS_PART_TYPE) {
        if (!activeExecutionRef.current || activeExecutionRef.current.conversationId !== conversationIdRef.current) return;
        const data = part.data as AgentUnifiedStatusData;
        if (
          (data.stepCount && data.stepCount > 1) ||
          data.phase === "step_handoff" ||
          data.phase === "step_blocked" ||
          data.phase === "step_failed"
        ) {
          needsDurableSyncRef.current = true;
        }
        if (data.phase === "step_failed" && data.turnId && typeof data.stepIndex === "number" && data.role) {
          setFailedStep({
            turnId: data.turnId,
            stepIndex: data.stepIndex,
            role: data.role,
            message: data.message,
          });
          setUnifiedStatus(null);
          return;
        }
        if (data.phase === "done") {
          setUnifiedStatus(null);
          return;
        }
        setUnifiedStatus(data);
        if (data.role && isAgentRole(data.role)) {
          activeRoleRef.current = data.role;
          setActiveRole(data.role);
        }
        return;
      }
      if (!activeExecutionRef.current || activeExecutionRef.current.conversationId !== conversationIdRef.current) return;
      if (part.type !== AGENT_NESTED_STREAM_PART_TYPE || !part.id) return;
      const id = part.id;
      const { delta } = part.data as AgentNestedStreamData;
      setToolStreams((prev) => ({ ...prev, [id]: (prev[id] ?? "") + delta }));
    },
    onFinish: ({ message, isAbort, isError }) => {
      setUnifiedStatus(null);
      const active = activeExecutionRef.current;
      if (!active || active.conversationId !== conversationIdRef.current || completedExecutionRef.current !== active.requestId || isAbort || isError) return;
      if (!hasPendingApproval(message ? [message] : [])) {
        setBrandCompletion((n) => n + 1);
      }

      selectedApprovalRef.current = null;
      approvalSendingRef.current = false;
      const finishedParts = message?.parts ?? [];
      const wrote = createdJobToolCallIds(message ? [message] : []).length > 0;
      const finishedTools = finishedParts
        .filter((part) => isToolUIPart(part) && part.state === "output-available")
        .map((part) => getToolName(part as ToolUIPart));
      const generated = finishedTools.some(isNestedTool);
      const scored = finishedTools.includes("match_job");

      if (wrote) chat.setMessages((prev) => stubConsumedPastes(prev));
      if (generated) router.refresh();
      if (scored) setJobWrites((n) => n + 1);
      setHistoryVersion((n) => n + 1);

      if (needsDurableSyncRef.current) {
        needsDurableSyncRef.current = false;
        const targetId = active.conversationId;
        const targetReq = active.requestId;
        void getChatConversation(targetId).then((res) => {
          if (
            !res.success ||
            !res.data ||
            conversationIdRef.current !== targetId ||
            activeExecutionRef.current?.requestId !== targetReq
          ) {
            return;
          }
          revisionRef.current = res.data.revision;
          chat.setMessages(res.data.messages);
          setConversationTitle(res.data.title ?? res.data.titleFallback ?? null);
        });
      }
    },
  });

  useEffect(() => {
    const announced = announcedJobWritesRef.current!;
    const landed = createdJobToolCallIds(chat.messages).filter(
      (id) => !announced.has(id),
    );
    if (landed.length === 0) return;
    landed.forEach((id) => announced.add(id));
    setJobWrites((n) => n + 1);
    router.refresh();
  }, [chat.messages, router]);

  const streamingRef = useRef(false);
  streamingRef.current =
    chat.status === "streaming" || chat.status === "submitted";

  const stop = useCallback(() => {
    const active = activeExecutionRef.current;
    chat.stop();
    activeExecutionRef.current = null;
    completedExecutionRef.current = null;
    durableApprovalRef.current = false;
    selectedApprovalRef.current = null;
    approvalSendingRef.current = false;
    setQueued(undefined);
    recoveryRef.current = active;
    if (active) {
      recoveryBlockedRef.current = true;
      const isCurrent = () => recoveryRef.current === active && conversationIdRef.current === active.conversationId && !activeExecutionRef.current;
      void (async () => {
        try {
          const result = await cancelChatConversationRequest(active.conversationId, active.requestId);
          if (!result.success || !result.data) throw new Error("cancel failed");
          if (!isCurrent()) return;
          revisionRef.current = result.data.revision;
          chat.setMessages(result.data.messages);
          durableApprovalRef.current = true;
          recoveryBlockedRef.current = false;
          recoveryRef.current = null;
        } catch {
          setRecoveryFailure({ conversationId: active.conversationId, requestId: active.requestId, operation: "cancel" });
          if (!isCurrent()) return;
          setActionError({ code: "CONVERSATION_CANCEL_FAILED" });
        }
      })();
    }
  }, [chat]);

  const close = useCallback(() => {
    // Closing the panel must not kill an in-flight turn: the provider stays
    // mounted at the layout root, so the stream keeps running in the
    // background and reopening shows the live or finished result. Stop is
    // only ever an explicit user action.
    setIsOpen(false);
    releaseRail(AGENT_CHAT_PANEL_ID);
  }, [releaseRail]);

  const runPreflight = useCallback(async () => {
    const epoch = ++preflightEpochRef.current;
    const selectionEpoch = selectionEpochRef.current;
    // A fresh check supersedes the dismissal — a still-failing state
    // re-announces itself; the X only ever hid the previous report.
    setPreflightDismissed(false);
    const publishIdentity: typeof setIdentity = (next) => {
      if (epoch !== preflightEpochRef.current || selectionEpoch !== selectionEpochRef.current) return;
      setPreflightDismissed(false);
      setIdentity(next);
    };
    try {
      const account = await getAgentChatPreflight({
        conversationId: conversationIdRef.current,
        explicit: conversationIdRef.current ? null : explicitRef.current,
      });
      const state = account?.data;
      if (!account?.success || !state) {
        publishIdentity({ ...UNKNOWN_IDENTITY, checked: true, ok: false, kind: "blocked", code: account?.code ?? "BACKEND_UNAVAILABLE" });
        return;
      }
      if (state?.kind === "account" || state?.kind === "managed") {
        publishIdentity({
          checked: true,
          ok: true,
          kind: state.kind,
          locked: state.locked,
          model: state.model,
          displayName: state.displayName,
          persistedLegacy: false,
        });
        return;
      }
      if (state?.kind === "blocked") {
        publishIdentity((prev) => ({
          ...prev,
          checked: true,
          ok: false,
          kind: "blocked",
          locked: state.locked ?? (Boolean(conversationIdRef.current) && prev.locked),
          model: state.model ?? (conversationIdRef.current ? prev.model : null),
          displayName: state.displayName ?? null,
          code: state.code,
          persistedLegacy: false,
        }));
        return;
      }
      if (state?.kind === "legacy") {
        publishIdentity({
          checked: true,
          ok: Boolean(state.model),
          kind: "legacy",
          locked: false,
          model: state.model,
          displayName: null,
          persistedLegacy: state.persisted,
          code: state.model ? undefined : "AI_NOT_CONFIGURED",
        });
        if (!state.model) return;
      }
    } catch {
      publishIdentity({ ...UNKNOWN_IDENTITY, checked: true, ok: false, kind: "blocked", code: "BACKEND_UNAVAILABLE" });
      return;
    }

    try {
    const settings = await getUserSettings();
    const ai = settings?.data?.settings?.ai;
    const provider = ai?.provider;
    const persistedLegacy =
      lockKindRef.current === "legacy" && Boolean(conversationIdRef.current);

    if (!ai?.model || !provider) {
      publishIdentity({
        checked: true,
        ok: false,
        kind: "legacy",
        locked: false,
        model: null,
        displayName: null,
        persistedLegacy,
        code: "AI_NOT_CONFIGURED",
      });
      return;
    }

    if (provider !== AiProvider.OLLAMA) {
      publishIdentity({
        checked: true,
        ok: true,
        kind: "legacy",
        locked: false,
        model: ai.model,
        displayName: provider,
        persistedLegacy,
      });
      return;
    }
    const result = await checkOllamaConnection(provider);
    publishIdentity({
      checked: true,
      ok: result.isConnected,
      kind: "legacy",
      locked: false,
      model: ai.model,
      displayName: provider,
      persistedLegacy,
      code: result.isConnected ? undefined : "BACKEND_UNAVAILABLE",
    });
    } catch {
      publishIdentity({ ...UNKNOWN_IDENTITY, checked: true, ok: false, kind: "blocked", code: "BACKEND_UNAVAILABLE" });
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => { void runPreflight(); };
    window.addEventListener(AI_CONFIGURATION_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(AI_CONFIGURATION_CHANGED_EVENT, refresh);
  }, [isOpen, runPreflight]);

  // Forward declaration for open()'s role option — switchRole is defined
  // after selectConversation below and assigns itself into this ref.
  const switchRoleRef = useRef<(role: AgentRole) => Promise<void>>(
    async () => {},
  );

  const open = useCallback(
    (_options?: { role?: AgentRole }) => {
      collapseSidebar();
      requestOpen(AGENT_CHAT_PANEL_ID);
      setIsOpen(true);
      void runPreflight();
    },
    [collapseSidebar, requestOpen, runPreflight],
  );

  useEffect(() => {
    if (isOpen && holder !== AGENT_CHAT_PANEL_ID) close();
  }, [holder, isOpen, close]);

  useEffect(() => {
    writeActiveConversationId(initial?.id ?? null);
    writeActiveAgentRole(activeRoleRef.current);
    notifyAgentSlotWrite();
    // AUTO attach happens at draft creation only — a draft restored from a
    // slot already owns its objects and is not re-resolved against the page.
    if (initial?.id || draftResolvedRef.current || initialSlot.hasStoredContext) return;
    draftResolvedRef.current = true;
    const page = pageContextFor(pathnameRef.current);
    if (!page.jobId && !page.resumeId) return;
    const epoch = selectionEpochRef.current;
    void resolveDraftPageContext({
      jobId: page.jobId ?? null,
      resumeId: page.resumeId ?? null,
    }).then((result) => {
      if (selectionEpochRef.current !== epoch || conversationIdRef.current || !result?.success || !result.data) return;
      contextSettledRef.current = true;
      setContext(result.data);
      contextRef.current = result.data;
      writeAgentRoleSlot(activeRoleRef.current, {
        conversationId: conversationIdRef.current ?? slotPointerRef.current,
        draft: draftTextForSlot(),
        context: result.data,
        explicit: explicitRef.current,
        paste: pasteChipRef.current ?? null,
      });
    });
  }, [initial?.id, initialSlot.hasStoredContext]);

  const [composerNonce, setComposerNonce] = useState(0);
  const [queued, setQueued] = useState<QueuedMessage | undefined>();

  const resetTransient = useCallback(() => {
    setBrandCompletion(0);
    chat.clearError();
    setActionError(null);
    composerApiRef.current = null;
    updateComposerSeed("");
    setComposerNonce((n) => n + 1);
    setPasteChip(undefined);
    setFileChips([]);
    setContextUsage(null);
    setCompacting(false);
    compactingRef.current = false;
    setCompactionFeedback(null);
    setToolStreams({});
    setQueued(undefined);
    setUnifiedStatus(null);
    setFailedStep(null);
    needsDurableSyncRef.current = false;
  }, [chat, updateComposerSeed, setPasteChip, setFileChips]);

  // ------------------------------------------------------------------
  // Role slots (D1)
  // ------------------------------------------------------------------

  // Unsent draft text for a slot write: a mounted composer is authoritative
  // (an empty read means the user cleared it — never fall back to an older
  // seed); unmounted, the seed ref still holds the last text it owned.
  const draftTextForSlot = () =>
    (composerApiRef.current
      ? composerApiRef.current.read()
      : composerSeedRef.current) || null;

  // Snapshot the live state into the active role's slot record. The
  // composer's registered reader is the only live view of unsent text. An
  // unresolved draft's EMPTY placeholder is never stored — the slot stays
  // fresh so the next draft-creation point still resolves the page object.
  const snapshotActiveSlot = useCallback(() => {
    // During a role load the visible state still belongs to the outgoing
    // role. Never snapshot it into the role whose row is being loaded.
    if (roleSelectionPendingRef.current) return;
    writeAgentRoleSlot(activeRoleRef.current, {
      conversationId: conversationIdRef.current ?? slotPointerRef.current,
      draft: draftTextForSlot(),
      context: contextSettledRef.current ? contextRef.current : undefined,
      explicit: explicitRef.current,
      paste: pasteChipRef.current ?? null,
    });
  }, []);

  // The slot the user last touched is what a refresh reopens: the active
  // role key names it, and the shared cookie keeps pointing at its
  // conversation so the server loader finds the same row.
  const persistActiveSlot = useCallback(() => {
    writeActiveAgentRole(activeRoleRef.current);
    snapshotActiveSlot();
  }, [snapshotActiveSlot]);

  const applyCreated = useCallback(
    (data: {
      id: string;
      context: AgentConversationContextV1;
      lockKind: ChatLockKind;
      resolvedModel: string | null;
      revision: number;
      executionPath?: string;
      title?: string | null;
      titleFallback?: string | null;
    }) => {
      revisionRef.current = data.revision;
      durableApprovalRef.current = true;
      conflictRef.current = false;
      conversationIdRef.current = data.id;
      slotPointerRef.current = data.id;
      lockKindRef.current = data.lockKind;
      setConversationId(data.id);
      setConversationTitle(data.title ?? data.titleFallback ?? null);
      setNativeSession(data.executionPath === "NATIVE_CODEX_V1");
      setNativeStatus("waiting");
      setContext(data.context);
      contextRef.current = data.context;
      contextSettledRef.current = true;
      explicitRef.current = null;
      setExplicit(null);
      writeActiveConversationId(data.id);
      setHistoryVersion((n) => n + 1);
      persistActiveSlot();
      void runPreflight();
    },
    [runPreflight, persistActiveSlot],
  );

  const createPersisted = useCallback(
    async (firstUserText: string | null, messages: UIMessage[]) => {
      const epoch = selectionEpochRef.current;
      const role = activeRoleRef.current;
      const result = await createChatConversation({
        permissionMode: draftPermissionMode,
        messages,
        context: contextRequests(contextRef.current.items),
        explicit: explicitRef.current,
        firstUserText,
        chatMode: "UNIFIED",
        agentRole: role,
      });
      // A role or conversation selection supersedes this first send. The
      // created row remains available in history, but must not become the
      // newly selected role's active conversation or trigger a model call.
      if (selectionEpochRef.current !== epoch || activeRoleRef.current !== role) return null;
      if (!result.success || !result.data) {
        setActionError({ code: result.code ?? "GENERIC" });
        return null;
      }
      applyCreated(result.data);
      return result.data.id;
    },
    [applyCreated, draftPermissionMode],
  );

  // Enter a draft (unpersisted) state inside the active slot. Called by
  const ensureTodayPlanConversation = useCallback(async () => {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (creatingRef.current || roleSelectionPendingRef.current) return null;
    creatingRef.current = true;
    try {
      return await createPersisted(null, []);
    } finally {
      creatingRef.current = false;
    }
  }, [createPersisted]);

  // Enter a draft (unpersisted) state inside the active slot. Called by
  // startNewConversation with an empty slot, and by switchRole with the
  // target role's stored draft state. draft/paste seed the composer state
  // resetTransient just cleared, so a carried or restored draft survives
  // the remount.
  const enterDraft = useCallback(
    (slot: {
      context: AgentConversationContextV1;
      explicit: ExplicitModelSelection | null;
      contextSettled: boolean;
      draft?: string | null;
      paste?: AgentPastePartData | null;
      files?: AgentFileChip[];
    }) => {
      setDraftPermissionMode(undefined);
      stop();
      selectionEpochRef.current += 1;
      roleSelectionPendingRef.current = false;
      recoveryRef.current = null;
      recoveryBlockedRef.current = false;
      revisionRef.current = 0;
      conflictRef.current = false;
      conversationIdRef.current = null;
      slotPointerRef.current = null;
      lockKindRef.current = null;
      setConversationId(null);
      setConversationTitle(null);
      setNativeSession(false);
      explicitRef.current = slot.explicit;
      setExplicit(slot.explicit);
      chat.setMessages([]);
      resetTransient();
      updateComposerSeed(slot.draft ?? "");
      setPasteChip(slot.paste ?? undefined);
      setFileChips(slot.files ?? []);
      setContext(slot.context);
      contextRef.current = slot.context;
      contextSettledRef.current = slot.contextSettled;
      draftResolvedRef.current = true;
      writeActiveConversationId(null);
      setIdentity(UNKNOWN_IDENTITY);
      void runPreflight();
    },
    [chat, stop, resetTransient, runPreflight, updateComposerSeed, setPasteChip, setFileChips],
  );

  const startNewConversation = useCallback(
    async (options?: {
      explicit?: ExplicitModelSelection | null;
      /** D1 model switch: carry draft text, MANUAL context, the paste chip
       *  and unsent file cards into the new draft instead of starting empty.
       *  AUTO page context still re-resolves below. */
      carry?: boolean;
    }) => {
      const wasStreaming = streamingRef.current;
      const carried = options?.carry
        ? {
            draft: composerApiRef.current?.read() || composerSeedRef.current,
            paste: pasteChipRef.current ?? null,
            files: fileChipsRef.current,
            manual: contextSettledRef.current
              ? contextRef.current.items.filter((item) => item.source === "MANUAL")
              : [],
          }
        : { draft: "", paste: null, files: [] as AgentFileChip[], manual: [] as AgentConversationContextItem[] };
      enterDraft({
        context: { version: 1, items: carried.manual },
        explicit: options?.explicit ?? null,
        contextSettled: Boolean(options?.carry) && contextSettledRef.current,
        draft: carried.draft,
        paste: carried.paste,
        files: carried.files,
      });
      persistActiveSlot();
      if (wasStreaming) toastInfo(t("agent.conversationStartedStopped"));
      const page = pageContextFor(pathnameRef.current);
      if (!page.jobId && !page.resumeId) return;
      const epoch = selectionEpochRef.current;
      const result = await resolveDraftPageContext({
        jobId: page.jobId ?? null,
        resumeId: page.resumeId ?? null,
      });
      if (selectionEpochRef.current !== epoch || conversationIdRef.current) return;
      if (result?.success && result.data) {
        const merged = options?.carry
          ? {
              version: 1 as const,
              items: dedupeContextItems([
                ...result.data.items,
                ...carried.manual,
              ]),
            }
          : result.data;
        contextSettledRef.current = true;
        setContext(merged);
        contextRef.current = merged;
        writeAgentRoleSlot(activeRoleRef.current, {
          conversationId: conversationIdRef.current ?? slotPointerRef.current,
          draft: draftTextForSlot(),
          context: merged,
          explicit: explicitRef.current,
          paste: pasteChipRef.current ?? null,
        });
      }
    },
    [enterDraft, persistActiveSlot, t],
  );

  const selectConversation = useCallback(
    async (
      id: string,
      options?: { composerText?: string | null; paste?: AgentPastePartData | null },
    ) => {
      if (streamingRef.current) stop();
      recoveryRef.current = null;
      recoveryBlockedRef.current = true;
      activeExecutionRef.current = null;
      const epoch = ++selectionEpochRef.current;
      const capturedConversationId = conversationIdRef.current;
      let result: Awaited<ReturnType<typeof getChatConversation>>;
      try {
        result = await getChatConversation(id);
      } catch {
        if (selectionEpochRef.current === epoch && conversationIdRef.current === capturedConversationId) {
          setActionError({ code: "CONVERSATION_REFRESH_FAILED" });
        }
        return false;
      }
      if (selectionEpochRef.current !== epoch || conversationIdRef.current !== capturedConversationId) return false;
      if (!result.success || !result.data) {
        setActionError({ code: "CONVERSATION_REFRESH_FAILED" });
        return false;
      }
      // An archived id can never stay active — a stale slot pointer degrades
      // to the role's draft rather than opening an archived conversation.
      if (result.data.archivedAt) return false;
      const data = result.data;
      // D3: picking a history row activates the slot that row's role owns —
      // a NULL row lands in the general (Pilot) slot.
      const rowRole = slotRoleFor(normalizeAgentRole(data.agentRole));
      if (rowRole !== activeRoleRef.current) {
        snapshotActiveSlot();
        activeRoleRef.current = rowRole;
        setActiveRole(rowRole);
      }
      roleSelectionPendingRef.current = false;
      revisionRef.current = data.revision;
      durableApprovalRef.current = true;
      recoveryBlockedRef.current = false;
      activeExecutionRef.current = null;
      conflictRef.current = false;
      conversationIdRef.current = data.id;
      slotPointerRef.current = data.id;
      lockKindRef.current = data.lockKind;
      explicitRef.current = null;
      setExplicit(null);
      setConversationId(data.id);
      setConversationTitle(data.title ?? data.titleFallback ?? null);
      setTaskBinding(data.agentTaskId ? { conversationId: data.id, taskId: data.agentTaskId } : null);
      setNativeSession(data.executionPath === "NATIVE_CODEX_V1");
      setNativeStatus("waiting");
      setContext(data.context);
      contextRef.current = data.context;
      contextSettledRef.current = true;
      chat.setMessages(data.messages);
      resetTransient();
      // The seed lands on the same remount resetTransient triggered, so a
      // slot's unsent text reappears instead of clearing with the reset.
      updateComposerSeed(options?.composerText ?? "");
      setPasteChip(options?.paste ?? undefined);
      writeActiveConversationId(data.id);
      // Write the slot record explicitly: the composer still shows the
      // outgoing slot's text until the remount flushes, so reading it here
      // would snapshot the wrong draft into this slot.
      writeActiveAgentRole(rowRole);
      writeAgentRoleSlot(rowRole, {
        conversationId: data.id,
        draft: options?.composerText ?? null,
        context: data.context,
        explicit: null,
        paste: options?.paste ?? null,
      });
      setIdentity(
        data.lockKind === "account" || data.lockKind === "managed"
          ? {
              checked: false,
              ok: true,
              kind: data.lockKind,
              locked: true,
              model: data.resolvedModel,
              displayName: null,
              persistedLegacy: false,
            }
          : {
              checked: false,
              ok: true,
              kind: "legacy",
              locked: false,
              model: null,
              displayName: null,
              persistedLegacy: true,
            },
      );
      void runPreflight();
      return true;
    },
    [chat, stop, resetTransient, runPreflight, snapshotActiveSlot, updateComposerSeed, setPasteChip],
  );

  const startNativeConversation = useCallback(
    async (selection?: ExplicitModelSelection | null) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      const epoch = selectionEpochRef.current;
      // The runtime-state probe behind creation has no bound — a hung
      // endpoint must not leave sends queued behind creatingRef forever.
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        creatingRef.current = false;
        if (selectionEpochRef.current === epoch) {
          setActionError({ code: "NATIVE_SESSION_UNAVAILABLE" });
        }
      }, 30_000);
      try {
        let resolved = selection ?? null;
        // Callers without a pair (error-banner retry) resolve the entry
        // themselves; the menu passes the pair it already probed.
        if (!resolved) {
          const entry = await getNativeChatEntry({ preferred: explicitRef.current });
          if (selectionEpochRef.current !== epoch || expired) return;
          if (!entry.success || !entry.data) {
            setActionError({ code: entry.code ?? "NATIVE_SESSION_UNAVAILABLE" });
            return;
          }
          if (!entry.data.ok) {
            setActionError({ code: "NATIVE_SESSION_UNAVAILABLE", details: entry.data.details });
            return;
          }
          resolved = { connectionId: entry.data.connectionId, model: entry.data.model };
        }
        const result = await createChatConversation({
          executionPath: "NATIVE_CODEX_V1",
          messages: [],
          context: [],
          explicit: resolved,
          permissionMode: draftPermissionMode,
          agentRole: activeRoleRef.current,
        });
        if (selectionEpochRef.current !== epoch || expired) return;
        if (!result.success || !result.data) {
          setActionError({ code: result.code ?? "NATIVE_SESSION_UNAVAILABLE", details: result.details });
          return;
        }
        await selectConversation(result.data.id);
      } finally {
        clearTimeout(timer);
        creatingRef.current = false;
      }
    },
    [draftPermissionMode, selectConversation],
  );

  const restartNativeSession = useCallback(async () => {
    const id = conversationIdRef.current;
    if (!id || streamingRef.current) return;
    const epoch = selectionEpochRef.current;
    const result = await restartNativeChat(id);
    if (epoch !== selectionEpochRef.current || id !== conversationIdRef.current) return;
    if (!result.success) { setActionError({ code: result.code ?? "NATIVE_CONTEXT_LOST" }); return; }
    await selectConversation(id);
  }, [selectConversation]);

  // Top-level role switch (D1). The outgoing slot is snapshotted — draft,
  // context, model pick — and the incoming slot restores its last-active
  // conversation or its stored draft state. A conversation id resolves
  // through the same load path as history selection, so a deleted or
  // archived row degrades to that role's draft rather than an error. A slot
  // that never stored a context is a fresh draft: it resolves the current
  // page's AUTO item like any new draft (§5.3/§6.2).
  const switchRole = useCallback(
    async (role: AgentRole) => {
      if (role === activeRoleRef.current) return;
      if (streamingRef.current) stop();
      snapshotActiveSlot();
      roleSelectionPendingRef.current = false;
      activeRoleRef.current = role;
      setActiveRole(role);
      writeActiveAgentRole(role);
      const slot = readAgentRoleSlots()[role];
      if (slot?.conversationId) {
        // Clear outgoing state while loading, without overwriting the
        // target's stored pointer. Rapid switches must not borrow a row
        // from the previous role or send against it.
        enterDraft({ context: slot.context ?? EMPTY_CONVERSATION_CONTEXT, explicit: slot.explicit ?? null, contextSettled: slot.context !== undefined, draft: slot.draft ?? null, paste: slot.paste ?? null });
        roleSelectionPendingRef.current = true;
        // selectConversation increments the selection epoch synchronously.
        // A false result may mean superseded, rather than a missing row.
        const epoch = selectionEpochRef.current + 1;
        const ok = await selectConversation(slot.conversationId, {
          composerText: slot.draft ?? null,
          paste: slot.paste ?? null,
        });
        if (selectionEpochRef.current !== epoch || activeRoleRef.current !== role) return;
        if (ok) return;
        // The stored id no longer resolves — fall through to the draft.
      }
      const freshDraft = slot?.context === undefined;
      enterDraft({
        context: slot?.context ?? EMPTY_CONVERSATION_CONTEXT,
        explicit: slot?.explicit ?? null,
        contextSettled: slot?.context !== undefined,
        draft: slot?.draft ?? null,
        paste: slot?.paste ?? null,
      });
      // Explicit write again — the composer still reads the outgoing slot's
      // text until the remount flushes (see selectConversation). A fresh
      // slot keeps its missing context: writing EMPTY here would mark the
      // draft resolved before the AUTO lookup below ever ran.
      writeAgentRoleSlot(role, {
        conversationId: null,
        draft: slot?.draft ?? null,
        context: slot?.context,
        explicit: slot?.explicit ?? null,
        paste: slot?.paste ?? null,
      });
      if (!freshDraft) return;
      const epoch = selectionEpochRef.current;
      const page = pageContextFor(pathnameRef.current);
      if (!page.jobId && !page.resumeId) return;
      const result = await resolveDraftPageContext({
        jobId: page.jobId ?? null,
        resumeId: page.resumeId ?? null,
      });
      if (selectionEpochRef.current !== epoch || conversationIdRef.current) return;
      if (result?.success && result.data) {
        contextSettledRef.current = true;
        setContext(result.data);
        contextRef.current = result.data;
        writeAgentRoleSlot(role, {
          conversationId: null,
          draft: slot?.draft ?? null,
          context: result.data,
          explicit: slot?.explicit ?? null,
          paste: slot?.paste ?? null,
        });
      }
    },
    [stop, snapshotActiveSlot, selectConversation, enterDraft],
  );
  switchRoleRef.current = switchRole;

  // Quit flushes the live composer. Context edits were already mirrored
  // synchronously, so this listener is not the only copy of an explicit clear.
  useEffect(() => {
    const persist = () => persistActiveSlot();
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, [persistActiveSlot]);

  // Shared post-removal flow: refresh History, then move the open draft to
  // the newest live conversation (or a fresh one) when the removed row was
  // the current draft — an archived id can never stay active.
  const leaveConversation = useCallback(
    async (
      id: string,
      run: (id: string) => Promise<{ success: boolean; code?: string }>,
    ) => {
      const result = await run(id);
      if (!result.success) {
        setActionError({ code: result.code ?? "GENERIC" });
        return false;
      }
      setHistoryVersion((n) => n + 1);
      if (id !== conversationIdRef.current) return true;
      const listed = await listChatConversations();
      const next = listed.data?.[0];
      if (next) {
        await selectConversation(next.id);
        return true;
      }
      await startNewConversation();
      return true;
    },
    [selectConversation, startNewConversation],
  );

  const removeConversation = useCallback(
    (id: string) => leaveConversation(id, deleteChatConversation),
    [leaveConversation],
  );

  const archiveConversation = useCallback(
    (id: string) => leaveConversation(id, archiveChatConversation),
    [leaveConversation],
  );

  const approvalPending = useMemo(
    () => hasPendingApproval(chat.messages),
    [chat.messages],
  );

  const dispatch = useCallback(
    (message: QueuedMessage) => {
      if (recoveryBlockedRef.current || roleSelectionPendingRef.current) return;
      conflictRef.current = false;
      setActionError(null);
      setFailedStep(null);
      needsDurableSyncRef.current = false;
      if (conversationIdRef.current) return chat.sendMessage(message);
      if (creatingRef.current) {
        setQueued(message);
        return;
      }
      creatingRef.current = true;
      void (async () => {
        try {
          const id = await createPersisted(firstText(message.parts), []);
          if (!id) return;
          await chat.sendMessage(message);
        } finally {
          creatingRef.current = false;
        }
      })();
    },
    [chat, createPersisted],
  );

  const sendMessage = useCallback(
    (message: QueuedMessage) => {
      if (streamingRef.current || approvalPending || creatingRef.current) {
        setQueued(message);
        return;
      }
      void dispatch(message);
    },
    [approvalPending, dispatch],
  );

  // Open a task session (card E): activate it in the Pilot slot and, for a
  // freshly created session, send the fixed kickoff text as the first turn.
  const openTaskSession = useCallback(
    async (input: { conversationId: string; kickoffText?: string }) => {
      open();
      const ok = await selectConversation(input.conversationId);
      if (ok && input.kickoffText) {
        sendMessage({ parts: [{ type: "text", text: input.kickoffText }] });
      }
      return ok;
    },
    [open, selectConversation, sendMessage],
  );

  // External composer writes (D8): suggestions fill the input without
  // touching the chat — no request, no conversation, no model call. The
  // composer's registered setter applies it while mounted; unmounted, the
  // seed + nonce remount lands it as the next initial text.
  const fillComposer = useCallback((text: string) => {
    updateComposerSeed(text);
    const api = composerApiRef.current;
    if (api) api.set(text);
    else setComposerNonce((n) => n + 1);
  }, [updateComposerSeed]);

  const registerComposerApi = useCallback(
    (api: { read: () => string; set: (text: string) => void } | null) => {
      composerApiRef.current = api;
    },
    [],
  );

  useEffect(() => {
    if (conflictRef.current || !queued || approvalPending || chat.status !== "ready") return;
    if (creatingRef.current) return;
    setQueued(undefined);
    void dispatch(queued);
  }, [queued, approvalPending, chat.status, dispatch]);

  const regenerate = useCallback((messageId?: string) => {
    if (nativeSession) return;
    if (regenerateInFlightRef.current || recoveryBlockedRef.current || streamingRef.current || !conversationIdRef.current) return;
    const target = messageId ?? chat.messages.at(-1)?.id;
    if (!target) return;
    regenerateInFlightRef.current = true;
    regenerateTargetRef.current = target;
    conflictRef.current = false;
    setActionError(null);
    const settle = () => { regenerateInFlightRef.current = false; };
    try {
      void Promise.resolve(
        messageId === undefined
          ? chat.regenerate()
          : chat.regenerate({ messageId }),
      ).then(settle, settle);
    } catch {
      settle();
    }
  }, [chat, nativeSession]);

  const clearQueued = useCallback(() => setQueued(undefined), []);

  const reanswer = useCallback(
    (targetMessageId: string, role: AgentRole) => {
      if (
        recoveryBlockedRef.current ||
        streamingRef.current ||
        approvalPending ||
        !conversationIdRef.current
      ) {
        return;
      }
      conflictRef.current = false;
      setActionError(null);
      setFailedStep(null);
      needsDurableSyncRef.current = true;
      pendingSpecialOpRef.current = {
        operation: "reanswer",
        targetMessageId,
        role,
      };
      void chat.sendMessage();
    },
    [approvalPending, chat],
  );

  const retryStep = useCallback(
    (turnId: string, stepIndex: number) => {
      if (
        recoveryBlockedRef.current ||
        streamingRef.current ||
        approvalPending ||
        !conversationIdRef.current
      ) {
        return;
      }
      conflictRef.current = false;
      setActionError(null);
      setFailedStep(null);
      needsDurableSyncRef.current = true;
      pendingSpecialOpRef.current = {
        operation: "retry_step",
        turnId,
        stepIndex,
      };
      void chat.sendMessage();
    },
    [approvalPending, chat],
  );

  // suggest_role handoff (MAO-B): the card carries the request into the
  // target role's slot and switches to it. The text lands as a composer
  // draft the user reviews and sends — nothing is auto-sent across roles.
  const clearActionError = useCallback(() => setActionError(null), []);
  const requestAddContext = useCallback(
    () => setContextPickerNonce((n) => n + 1),
    [],
  );
  const requestModelPicker = useCallback(
    () => setModelPickerNonce((n) => n + 1),
    [],
  );

  const setDraftModel = useCallback(
    (selection: ExplicitModelSelection | null) => {
      if (conversationIdRef.current) return;
      explicitRef.current = selection;
      setExplicit(selection);
      persistActiveSlot();
      void runPreflight();
    },
    [persistActiveSlot, runPreflight],
  );

  const persistContext = useCallback(async (items: AgentConversationContextItem[]) => {
    const id = conversationIdRef.current;
    const epoch = selectionEpochRef.current;
    const next = { version: 1 as const, items };
    const previous = contextRef.current;
    // The user owns the context from here on — including an explicit clear,
    // which must persist as "resolved to empty", not revert to fresh.
    contextSettledRef.current = true;
    setContext(next);
    contextRef.current = next;
    // A draft clear has no conversation row. Mirror it now — pagehide is not
    // the write that has to survive a quit.
    if (!id) {
      persistActiveSlot();
      return;
    }
    const result = await updateChatConversationContext(id, contextRequests(items));
    if (selectionEpochRef.current !== epoch || conversationIdRef.current !== id || contextRef.current !== next) return;
    if (!result.success || !result.data) {
      setContext(previous);
      contextRef.current = previous;
      setActionError({ code: result.code ?? "GENERIC" });
      return;
    }
    setContext(result.data);
    contextRef.current = result.data;
    persistActiveSlot();
  }, [persistActiveSlot]);

  const transferToRole = useCallback(
    async (role: AgentRole, text: string, sourceToolCallId?: string) => {
      const draft = text.trim();
      if (!draft) return;
      // Harvest before switchRole swaps the transcript and context — the
      // request's attachments and manual context chips travel with it.
      const carried = harvestTransferSource(chat.messages, sourceToolCallId);
      const carriedContext = contextRef.current.items.filter(
        (item) => item.source === "MANUAL",
      );
      if (role !== activeRoleRef.current) await switchRole(role);
      const existing = draftTextForSlot() ?? "";
      let merged =
        existing && existing !== draft ? `${existing}\n\n${draft}` : draft;
      // The composer holds a single paste card — when the target slot
      // already owns one the carried body folds into the draft text
      // instead of clobbering it.
      if (carried?.paste && !pasteChipRef.current)
        setPasteChip(carried.paste);
      else if (carried?.paste) merged = `${merged}\n\n${carried.paste.text}`;
      fillComposer(merged);
      if (carried && carried.files.length > 0) {
        setFileChips((prev) => {
          const seen = new Set(prev.map((chip) => chip.id));
          return [
            ...prev,
            ...carried.files.filter((chip) => !seen.has(chip.id)),
          ].slice(0, APP_CONSTANTS.AGENT_FILE_MAX_PER_MESSAGE);
        });
      }
      if (carriedContext.length > 0) {
        void persistContext(
          dedupeContextItems([...contextRef.current.items, ...carriedContext]),
        );
      }
      persistActiveSlot();
    },
    [
      chat,
      switchRole,
      fillComposer,
      persistContext,
      persistActiveSlot,
      setPasteChip,
      setFileChips,
    ],
  );

  const removeContextItem = useCallback(
    (kind: AgentConversationContextItem["kind"], entityId: string) => {
      void persistContext(
        contextRef.current.items.filter(
          (item) => item.kind !== kind || item.entityId !== entityId,
        ),
      );
    },
    [persistContext],
  );

  const addContextItem = useCallback(
    (item: AgentConversationContextItem) => {
      if (
        contextRef.current.items.some(
          (existing) =>
            existing.kind === item.kind && existing.entityId === item.entityId,
        )
      ) {
        return;
      }
      void persistContext([
        ...contextRef.current.items,
        { ...item, source: "MANUAL" },
      ]);
    },
    [persistContext],
  );

  const activeTaskId =
    taskBinding && taskBinding.conversationId === conversationId
      ? taskBinding.taskId
      : null;

  // Same reset the card applied to its local pick: a bound-task change
  // (conversation switch) clears the manual selection.
  useEffect(() => {
    setSelectedTaskId(null);
  }, [activeTaskId]);

  const busy = streamingRef.current || approvalPending;

  useEffect(() => {
    if (
      !conversationId ||
      nativeSession ||
      (identity.kind !== "account" && identity.kind !== "managed") ||
      chat.status === "submitted" ||
      chat.status === "streaming" ||
      chat.messages.length === 0 ||
      contextUsage?.conversationId === conversationId ||
      typeof fetch !== "function"
    ) {
      return;
    }
    const epoch = selectionEpochRef.current;
    const targetId = conversationId;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/ai/chat/compact?conversationId=${encodeURIComponent(targetId)}`,
          { signal: controller.signal },
        );
        if (!res || !res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { usage?: AgentContextUsage | null }
          | null;
        if (
          controller.signal.aborted ||
          selectionEpochRef.current !== epoch ||
          conversationIdRef.current !== targetId ||
          !body?.usage
        ) {
          return;
        }
        setContextUsage((prev) =>
          prev?.conversationId === targetId ? prev : body.usage ?? null,
        );
      } catch {
        // Snapshot usage fetch is progressive enhancement; never block UI.
      }
    })();
    return () => controller.abort();
  }, [
    conversationId,
    nativeSession,
    identity.kind,
    chat.status,
    chat.messages.length,
    contextUsage?.conversationId,
  ]);

  const compactContext = useCallback(
    async (focusNote?: string) => {
      const id = conversationIdRef.current;
      if (
        !id ||
        nativeSession ||
        streamingRef.current ||
        approvalPending ||
        compactingRef.current ||
        identity.kind === "legacy" ||
        typeof fetch !== "function"
      ) {
        return;
      }
      const epoch = selectionEpochRef.current;
      compactingRef.current = true;
      setCompacting(true);
      setCompactionFeedback(null);
      try {
        const trimmedFocus = focusNote?.trim();
        const res = await fetch("/api/ai/chat/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: id,
            ...(trimmedFocus ? { focusNote: trimmedFocus } : {}),
          }),
        });
        if (
          selectionEpochRef.current !== epoch ||
          conversationIdRef.current !== id
        ) {
          return;
        }
        if (!res) {
          setCompactionFeedback({ kind: "error" });
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | {
              status?: string;
              reason?: string;
              code?: string;
              usage?: AgentContextUsage | null;
              beforeTokens?: number | null;
              afterTokens?: number | null;
            }
          | null;
        if (
          selectionEpochRef.current !== epoch ||
          conversationIdRef.current !== id
        ) {
          return;
        }
        if (body?.usage) {
          setContextUsage(body.usage);
        }
        if (
          res.status === 409 &&
          (body?.code === "COMPACTION_IN_PROGRESS" ||
            body?.code === "CONVERSATION_TURN_CONFLICT" ||
            body?.code === "CONVERSATION_STALE_WRITE")
        ) {
          setCompactionFeedback({ kind: "busy", code: body.code });
          return;
        }
        if (res.ok && body?.status === "committed") {
          setCompactionFeedback({
            kind: "success",
            beforeTokens: body.beforeTokens ?? null,
            afterTokens: body.afterTokens ?? null,
          });
          return;
        }
        if (res.ok && body?.status === "skipped") {
          setCompactionFeedback({ kind: "skipped", code: body.reason });
          return;
        }
        setCompactionFeedback({ kind: "error", code: body?.code });
      } catch {
        if (
          selectionEpochRef.current === epoch &&
          conversationIdRef.current === id
        ) {
          setCompactionFeedback({ kind: "error" });
        }
      } finally {
        compactingRef.current = false;
        setCompacting(false);
      }
    },
    [approvalPending, identity.kind, nativeSession],
  );

  const preflight = {
    checked: identity.checked,
    ok: identity.ok,
    dismissed: preflightDismissed,
    model: identity.model ?? undefined,
    provider: identity.displayName ?? undefined,
    code: identity.code,
  };

  return {
    nativeSession,
    nativeStatus,
    startNativeConversation,
    restartNativeSession,
    isOpen,
    open,
    close,
    busy,
    messages: chat.messages,
    toolStreams,
    jobWrites,
    status: chat.status,
    brandCompletion,
    error: chat.error,
    actionError,
    recoveryFailure,
    clearError: () => {
      chat.clearError();
      setActionError(null);
      setPreflightDismissed(true);
    },
    clearActionError,
    sendMessage,
    fillComposer,
    registerComposerApi,
    composerSeed,
    pasteChip,
    setPasteChip,
    fileChips,
    addFiles,
    removeFileChip,
    clearFileChips,
    contextUsage,
    compacting,
    compactionFeedback,
    compactContext,
    clearCompactionFeedback,
    activeRole,
    switchRole,
    transferToRole,
    stop,
    regenerate,
    reanswer,
    retryStep,
    unifiedStatus,
    failedStep,
    conversationTitle,
    addToolApprovalResponse: (...args: Parameters<typeof chat.addToolApprovalResponse>) => {
      if (recoveryBlockedRef.current || !durableApprovalRef.current || streamingRef.current || approvalSendingRef.current) return;
      selectedApprovalRef.current = args[0].id;
      approvalSendingRef.current = true;
      conflictRef.current = false;
      setActionError(null);
      return chat.addToolApprovalResponse(...args);
    },
    approvalPending,
    queued,
    clearQueued,
    startNewConversation,
    selectConversation,
    openTaskSession,
    activeTaskId,
    selectedTaskId,
    setSelectedTaskId,
    removeConversation,
    archiveConversation,
    historyVersion,
    conversationId,
    ensureTodayPlanConversation,
    context,
    explicit,
    setDraftModel,
    draftPermissionMode,
    setDraftPermissionMode,
    addContextItem,
    removeContextItem,
    requestAddContext,
    contextPickerNonce,
    requestModelPicker,
    modelPickerNonce,
    identity,
    preflight,
    refreshPreflight: runPreflight,
    composerNonce,
    panelWidth,
    startResize,
    isResizing,
    isPanelExpanded,
    togglePanelExpand,
  };
}

export function AgentChatProvider({
  initialConversation = null,
  initialMessages,
  userId = null,
  children,
}: {
  initialConversation?: AgentChatInitialConversation | null;
  initialMessages?: UIMessage[];
  /** Signed-in account. Durable slots are stored under this id. */
  userId?: string | null;
  children: React.ReactNode;
}) {
  const value = useAgentChatValue(
    initialConversation?.id ? initialConversation : null,
    initialConversation?.messages ?? initialMessages ?? [],
    userId,
  );
  return (
    <AgentChatContext.Provider value={value}>
      {children}
    </AgentChatContext.Provider>
  );
}

export function useAgentChat() {
  const ctx = useContext(AgentChatContext);
  if (!ctx) {
    throw new Error("useAgentChat must be used within an AgentChatProvider");
  }
  return ctx;
}

export type { ChatConversationSummary };
