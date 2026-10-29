"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { useRightRail } from "@/context/RightRailContext";
import { useSidebar } from "@/context/SidebarContext";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { APP_CONSTANTS } from "@/lib/constants";
import { toastInfo } from "@/lib/toast";
import { useI18n } from "@/i18n";
import {
  archiveChatConversation,
  createChatConversation,
  deleteChatConversation,
  getAgentChatPreflight,
  getChatConversation,
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
  isNestedTool,
  type AgentAddJobResult,
  type AgentNestedStreamData,
} from "@/models/agent.model";
import {
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
  revision: number;
  id: string;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  lockKind: ChatLockKind;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  title: string | null;
  titleFallback: string | null;
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

function useAgentChatValue(
  initial: AgentChatInitialConversation | null,
  seedMessages: UIMessage[],
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
    toggleExpand: togglePanelExpand,
  } = useResizablePanel(
    APP_CONSTANTS.AGENT_CHAT_PANEL_WIDTH_KEY,
    APP_CONSTANTS.AGENT_CHAT_PANEL_MIN_WIDTH,
  );

  const lastPathnameRef = useRef(pathname);
  useEffect(() => {
    const navigated = lastPathnameRef.current !== pathname;
    lastPathnameRef.current = pathname;
    if (isPanelExpanded && (sidebarExpanded || navigated)) togglePanelExpand();
  }, [sidebarExpanded, isPanelExpanded, pathname, togglePanelExpand]);

  const [interruptedTurn, setInterruptedTurn] = useState(false);
  // Presentation-only completion signal; errors, aborts and approval waits stay idle.
  const [brandCompletion, setBrandCompletion] = useState(0);
  const [identity, setIdentity] = useState<AgentChatIdentity>(() =>
    identityFromInitial(initial),
  );
  const [conversationId, setConversationId] = useState<string | null>(
    initial?.id ?? null,
  );
  const [context, setContext] = useState<AgentConversationContextV1>(
    initial?.context ?? EMPTY_CONVERSATION_CONTEXT,
  );
  const [explicit, setExplicit] = useState<ExplicitModelSelection | null>(null);
  const [actionError, setActionError] = useState<{ code: string } | null>(null);
  // Display-only dismissal of the preflight banner — it never lifts the
  // send restriction, which stays bound to identity.ok.
  const [preflightDismissed, setPreflightDismissed] = useState(false);
  const [contextPickerNonce, setContextPickerNonce] = useState(0);
  const [modelPickerNonce, setModelPickerNonce] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const conversationIdRef = useRef<string | null>(initial?.id ?? null);
  const revisionRef = useRef(initial?.revision ?? 0);
  const activeExecutionRef = useRef<{ conversationId: string; requestId: string; existingWrites: Set<string> } | null>(null);
  const completedExecutionRef = useRef<string | null>(null);
  const recoveryRef = useRef<{ conversationId: string; requestId: string } | null>(null);
  const recoveryBlockedRef = useRef(false);
  const selectionEpochRef = useRef(0);
  const preflightEpochRef = useRef(0);
  const [recoveryFailure, setRecoveryFailure] = useState<{
    conversationId: string; requestId: string; operation: "reload" | "cancel";
  } | null>(null);
  const selectedApprovalRef = useRef<string | null>(null);
  const approvalSendingRef = useRef(false);
  const durableApprovalRef = useRef(Boolean(initial));
  const conflictRef = useRef(false);
  const regenerateTargetRef = useRef<string | null>(null);
  // Status lags one render behind the click, so an in-flight ref is the only
  // thing that stops a fast second click from opening a second request.
  const regenerateInFlightRef = useRef(false);
  const contextRef = useRef(context);
  const explicitRef = useRef<ExplicitModelSelection | null>(null);
  const lockKindRef = useRef<ChatLockKind | null>(initial?.lockKind ?? null);
  const creatingRef = useRef(false);
  const draftResolvedRef = useRef(initial !== null);
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
        const last = messages.at(-1);
        const approval = last?.parts.find(p => isToolUIPart(p) && p.state === "approval-responded" && p.approval?.id === selectedApprovalRef.current);
        const operation = trigger === "regenerate-message" ? "regenerate" : approval ? "approval" : "send";
        activeExecutionRef.current = { conversationId: id, requestId, existingWrites: savedWriteCallIds(messages) };
        recoveryRef.current = null;
        completedExecutionRef.current = null;
        durableApprovalRef.current = false;
        return { body: {
          conversationId: id, requestId, expectedRevision: revisionRef.current, operation,
          ...(operation === "send" ? { newMessage: last } : operation === "regenerate" ? { targetMessageId: regenerateTargetRef.current ?? messageId } : {
            approvalId: isToolUIPart(approval!) ? approval!.approval?.id : undefined,
            decision: isToolUIPart(approval!) ? approval!.approval?.approved : undefined,
            reason: isToolUIPart(approval!) ? approval!.approval?.reason : undefined,
          }),
        } };
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
      if (!activeExecutionRef.current || activeExecutionRef.current.conversationId !== conversationIdRef.current) return;
      if (part.type !== AGENT_NESTED_STREAM_PART_TYPE || !part.id) return;
      const id = part.id;
      const { delta } = part.data as AgentNestedStreamData;
      setToolStreams((prev) => ({ ...prev, [id]: (prev[id] ?? "") + delta }));
    },
    onFinish: ({ message, isAbort, isError }) => {
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
    if (streamingRef.current) {
      stop();
      setInterruptedTurn(true);
      toastInfo(t("agent.generationStoppedReopen"));
    }
    setIsOpen(false);
    releaseRail(AGENT_CHAT_PANEL_ID);
  }, [stop, releaseRail, t]);

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

  const open = useCallback(() => {
    collapseSidebar();
    requestOpen(AGENT_CHAT_PANEL_ID);
    setIsOpen(true);
    void runPreflight();
  }, [collapseSidebar, requestOpen, runPreflight]);

  useEffect(() => {
    if (isOpen && holder !== AGENT_CHAT_PANEL_ID) close();
  }, [holder, isOpen, close]);

  useEffect(() => {
    writeActiveConversationId(initial?.id ?? null);
    if (initial?.id || draftResolvedRef.current) return;
    draftResolvedRef.current = true;
    const page = pageContextFor(pathnameRef.current);
    if (!page.jobId && !page.resumeId) return;
    void resolveDraftPageContext({
      jobId: page.jobId ?? null,
      resumeId: page.resumeId ?? null,
    }).then((result) => {
      if (conversationIdRef.current || !result?.success || !result.data) return;
      setContext(result.data);
      contextRef.current = result.data;
    });
  }, [initial?.id]);

  const [composerNonce, setComposerNonce] = useState(0);
  const [queued, setQueued] = useState<QueuedMessage | undefined>();

  const resetTransient = useCallback(() => {
    setBrandCompletion(0);
    chat.clearError();
    setActionError(null);
    setInterruptedTurn(false);
    setComposerNonce((n) => n + 1);
    setToolStreams({});
    setQueued(undefined);
  }, [chat]);

  const applyCreated = useCallback(
    (data: {
      id: string;
      context: AgentConversationContextV1;
      lockKind: ChatLockKind;
      resolvedModel: string | null;
      revision: number;
    }) => {
      revisionRef.current = data.revision;
      durableApprovalRef.current = true;
      conflictRef.current = false;
      conversationIdRef.current = data.id;
      lockKindRef.current = data.lockKind;
      setConversationId(data.id);
      setContext(data.context);
      contextRef.current = data.context;
      explicitRef.current = null;
      setExplicit(null);
      writeActiveConversationId(data.id);
      setHistoryVersion((n) => n + 1);
      void runPreflight();
    },
    [runPreflight],
  );

  const createPersisted = useCallback(
    async (firstUserText: string | null, messages: UIMessage[]) => {
      const result = await createChatConversation({
        messages,
        context: contextRequests(contextRef.current.items),
        explicit: explicitRef.current,
        firstUserText,
      });
      if (!result.success || !result.data) {
        setActionError({ code: result.code ?? "GENERIC" });
        return null;
      }
      applyCreated(result.data);
      return result.data.id;
    },
    [applyCreated],
  );

  const startNewConversation = useCallback(
    async (options?: { explicit?: ExplicitModelSelection | null }) => {
      const wasStreaming = streamingRef.current;
      stop();
      selectionEpochRef.current += 1;
      recoveryRef.current = null;
      recoveryBlockedRef.current = false;
      revisionRef.current = 0;
      conflictRef.current = false;
      conversationIdRef.current = null;
      lockKindRef.current = null;
      setConversationId(null);
      const nextExplicit = options?.explicit ?? null;
      explicitRef.current = nextExplicit;
      setExplicit(nextExplicit);
      chat.setMessages([]);
      resetTransient();
      const empty = EMPTY_CONVERSATION_CONTEXT;
      setContext(empty);
      contextRef.current = empty;
      draftResolvedRef.current = true;
      writeActiveConversationId(null);
      setIdentity(UNKNOWN_IDENTITY);
      if (wasStreaming) toastInfo(t("agent.conversationStartedStopped"));
      void runPreflight();
      const page = pageContextFor(pathnameRef.current);
      if (!page.jobId && !page.resumeId) return;
      const result = await resolveDraftPageContext({
        jobId: page.jobId ?? null,
        resumeId: page.resumeId ?? null,
      });
      if (conversationIdRef.current) return;
      if (result?.success && result.data) {
        setContext(result.data);
        contextRef.current = result.data;
      }
    },
    [chat, stop, resetTransient, runPreflight, t],
  );

  const selectConversation = useCallback(
    async (id: string) => {
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
      const data = result.data;
      revisionRef.current = data.revision;
      durableApprovalRef.current = true;
      recoveryBlockedRef.current = false;
      activeExecutionRef.current = null;
      conflictRef.current = false;
      conversationIdRef.current = data.id;
      lockKindRef.current = data.lockKind;
      explicitRef.current = null;
      setExplicit(null);
      setConversationId(data.id);
      setContext(data.context);
      contextRef.current = data.context;
      chat.setMessages(data.messages);
      resetTransient();
      writeActiveConversationId(data.id);
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
    [chat, stop, resetTransient, runPreflight],
  );

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
      if (recoveryBlockedRef.current) return;
      conflictRef.current = false;
      setInterruptedTurn(false);
      setActionError(null);
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
          setInterruptedTurn(false);
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

  const seedExchange = useCallback(
    (userText: string, assistantText: string) => {
      const id = conversationIdRef.current;
      // The in-flight guard has to win before the optimistic exchange, or a
      // second click paints messages the open create call never persists.
      if (id) { setActionError({ code: "CONVERSATION_TURN_CONFLICT" }); return; }
      if (creatingRef.current) return;

      // setMessages publishes the seeded transcript on the chat object. The
      // pre-seed copy is the only transcript a rejected create can restore.
      const previousMessages = chat.messages.slice();
      const next: UIMessage[] = [
        ...previousMessages,
        {
          id: generateId(),
          role: "user",
          parts: [{ type: "text", text: userText }],
        },
        {
          id: generateId(),
          role: "assistant",
          parts: [{ type: "text", text: assistantText }],
        },
      ];
      chat.setMessages(next);

      creatingRef.current = true;
      setActionError(null);
      void (async () => {
        let committed = false;
        try {
          committed = Boolean(await createPersisted(userText, next));
        } catch {
          // A thrown action does not go through createPersisted's typed code.
          setActionError((current) => current ?? { code: "GENERIC" });
        } finally {
          if (!committed && conversationIdRef.current === null) {
            chat.setMessages(previousMessages);
          }
          creatingRef.current = false;
        }
      })();
    },
    [chat, createPersisted],
  );

  useEffect(() => {
    if (conflictRef.current || !queued || approvalPending || chat.status !== "ready") return;
    if (creatingRef.current) return;
    setQueued(undefined);
    void dispatch(queued);
  }, [queued, approvalPending, chat.status, dispatch]);

  const regenerate = useCallback((messageId?: string) => {
    if (regenerateInFlightRef.current || recoveryBlockedRef.current || streamingRef.current || !conversationIdRef.current) return;
    const target = messageId ?? chat.messages.at(-1)?.id;
    if (!target) return;
    regenerateInFlightRef.current = true;
    regenerateTargetRef.current = target;
    conflictRef.current = false;
    setActionError(null);
    setInterruptedTurn(false);
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
  }, [chat]);

  const clearQueued = useCallback(() => setQueued(undefined), []);
  const dismissInterrupted = useCallback(() => setInterruptedTurn(false), []);
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
      void runPreflight();
    },
    [runPreflight],
  );

  const persistContext = useCallback(async (items: AgentConversationContextItem[]) => {
    const id = conversationIdRef.current;
    const next = { version: 1 as const, items };
    const previous = contextRef.current;
    setContext(next);
    contextRef.current = next;
    if (!id) return;
    const result = await updateChatConversationContext(id, contextRequests(items));
    if (!result.success || !result.data) {
      setContext(previous);
      contextRef.current = previous;
      setActionError({ code: result.code ?? "GENERIC" });
      return;
    }
    setContext(result.data);
    contextRef.current = result.data;
  }, []);

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

  const busy = streamingRef.current || approvalPending;

  const preflight = {
    checked: identity.checked,
    ok: identity.ok,
    dismissed: preflightDismissed,
    model: identity.model ?? undefined,
    provider: identity.displayName ?? undefined,
    code: identity.code,
  };

  return {
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
    seedExchange,
    stop,
    regenerate,
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
    interruptedTurn,
    dismissInterrupted,
    startNewConversation,
    selectConversation,
    removeConversation,
    archiveConversation,
    historyVersion,
    conversationId,
    context,
    explicit,
    setDraftModel,
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
  children,
}: {
  initialConversation?: AgentChatInitialConversation | null;
  initialMessages?: UIMessage[];
  children: React.ReactNode;
}) {
  const value = useAgentChatValue(
    initialConversation?.id ? initialConversation : null,
    initialConversation?.messages ?? initialMessages ?? [],
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
