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
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { VocatryaChatTransport } from "@/lib/agent/chatTransport";
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
  createChatConversation,
  deleteChatConversation,
  getAgentChatPreflight,
  getChatConversation,
  listChatConversations,
  resolveDraftPageContext,
  saveChatConversation,
  updateChatConversationContext,
} from "@/actions/agentChat.actions";
import { getUserSettings } from "@/actions/userSettings.actions";
import { checkOllamaConnection } from "@/utils/ai.utils";
import { AiProvider } from "@/models/ai.model";
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
  kind: "account" | "legacy" | "blocked" | "unknown";
  locked: boolean;
  model: string | null;
  displayName: string | null;
  persistedLegacy: boolean;
  code?: string;
};

export type AgentChatInitialConversation = {
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
  if (initial.lockKind === "account") {
    return {
      checked: false,
      ok: true,
      kind: "account",
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
  const [contextPickerNonce, setContextPickerNonce] = useState(0);
  const [modelPickerNonce, setModelPickerNonce] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const conversationIdRef = useRef<string | null>(initial?.id ?? null);
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
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          conversationId: conversationIdRef.current,
        },
      }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => {
      if (part.type !== AGENT_NESTED_STREAM_PART_TYPE || !part.id) return;
      const id = part.id;
      const { delta } = part.data as AgentNestedStreamData;
      setToolStreams((prev) => ({ ...prev, [id]: (prev[id] ?? "") + delta }));
    },
    onFinish: ({ message, isAbort, isError }) => {
      if (isAbort || isError) return;

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

  const close = useCallback(() => {
    if (streamingRef.current) {
      chat.stop();
      setInterruptedTurn(true);
      toastInfo(t("agent.generationStoppedReopen"));
    }
    setIsOpen(false);
    releaseRail(AGENT_CHAT_PANEL_ID);
  }, [chat, releaseRail, t]);

  const runPreflight = useCallback(async () => {
    try {
      const account = await getAgentChatPreflight({
        conversationId: conversationIdRef.current,
        explicit: conversationIdRef.current ? null : explicitRef.current,
      });
      const state = account?.data;
      if (state?.kind === "account") {
        setIdentity({
          checked: true,
          ok: true,
          kind: "account",
          locked: state.locked,
          model: state.model,
          displayName: state.displayName,
          persistedLegacy: false,
        });
        return;
      }
      if (state?.kind === "blocked") {
        setIdentity((prev) => ({
          ...prev,
          checked: true,
          ok: false,
          kind: "blocked",
          locked: Boolean(conversationIdRef.current) && prev.locked,
          code: state.code,
          persistedLegacy: false,
        }));
        return;
      }
      if (state?.kind === "legacy") {
        setIdentity({
          checked: true,
          ok: Boolean(state.model),
          kind: "legacy",
          locked: false,
          model: state.model,
          displayName: null,
          persistedLegacy: state.persisted,
          code: state.model ? undefined : "AI_NOT_CONFIGURED",
        });
        if (state.model || state.persisted) return;
      }
    } catch {
      // Preflight is advisory. A missing action falls through to settings.
    }

    const settings = await getUserSettings();
    const ai = settings?.data?.settings?.ai;
    const provider = ai?.provider ?? AiProvider.OLLAMA;
    const persistedLegacy =
      lockKindRef.current === "legacy" && Boolean(conversationIdRef.current);

    if (!ai?.model) {
      setIdentity({
        checked: true,
        ok: false,
        kind: "legacy",
        locked: false,
        model: null,
        displayName: provider,
        persistedLegacy,
        code: "AI_NOT_CONFIGURED",
      });
      return;
    }

    if (provider !== AiProvider.OLLAMA) {
      setIdentity({
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
    setIdentity({
      checked: true,
      ok: result.isConnected,
      kind: "legacy",
      locked: false,
      model: ai.model,
      displayName: provider,
      persistedLegacy,
      code: result.isConnected ? undefined : "BACKEND_UNAVAILABLE",
    });
  }, []);

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
    }) => {
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
      chat.stop();
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
    [chat, resetTransient, runPreflight, t],
  );

  const selectConversation = useCallback(
    async (id: string) => {
      if (streamingRef.current) chat.stop();
      const result = await getChatConversation(id);
      if (!result.success || !result.data) {
        setActionError({ code: result.code ?? "CONVERSATION_NOT_FOUND" });
        return false;
      }
      const data = result.data;
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
        data.lockKind === "account"
          ? {
              checked: false,
              ok: true,
              kind: "account",
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
    [chat, resetTransient, runPreflight],
  );

  const removeConversation = useCallback(
    async (id: string) => {
      const result = await deleteChatConversation(id);
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

  const approvalPending = useMemo(
    () => hasPendingApproval(chat.messages),
    [chat.messages],
  );

  const dispatch = useCallback(
    (message: QueuedMessage) => {
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
      const next: UIMessage[] = [
        ...chat.messages,
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
      const id = conversationIdRef.current;
      if (id) {
        void saveChatConversation(id, next);
        setHistoryVersion((n) => n + 1);
        return;
      }
      if (creatingRef.current) return;
      creatingRef.current = true;
      void (async () => {
        try {
          const created = await createPersisted(userText, next);
          if (!created) chat.setMessages(chat.messages);
        } finally {
          creatingRef.current = false;
        }
      })();
    },
    [chat, createPersisted],
  );

  useEffect(() => {
    if (!queued || approvalPending || chat.status !== "ready") return;
    if (creatingRef.current) return;
    setQueued(undefined);
    void dispatch(queued);
  }, [queued, approvalPending, chat.status, dispatch]);

  const regenerate = useCallback(() => {
    if (streamingRef.current || !conversationIdRef.current) return;
    setInterruptedTurn(false);
    void chat.regenerate();
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
    error: chat.error,
    actionError,
    clearError: () => {
      chat.clearError();
      setActionError(null);
    },
    clearActionError,
    sendMessage,
    seedExchange,
    stop: chat.stop,
    regenerate,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    approvalPending,
    queued,
    clearQueued,
    interruptedTurn,
    dismissInterrupted,
    startNewConversation,
    selectConversation,
    removeConversation,
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
