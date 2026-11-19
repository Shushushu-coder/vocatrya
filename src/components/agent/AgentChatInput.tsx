"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import type { TextUIPart, UIMessage } from "ai";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AgentAddContextMenu } from "@/components/agent/AgentChatContextBar";
import { AgentPermissionChip } from "@/components/agent/AgentPermissionChip";
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";
import { AgentContextUsage } from "@/components/agent/AgentContextUsage";
import { AgentDictationButton } from "@/components/agent/AgentDictationButton";
import { chipLabel } from "@/components/agent/pasteChip";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { readAgentChatError } from "@/lib/agent/chatTransport";
import {
  agentErrorCopy,
  categorizeAgentErrorCode,
} from "@/lib/agent/chatErrorUx";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_FILE_PART_TYPE,
  AGENT_PASTE_PART_TYPE,
  isAgentFilePart,
  isAgentPastePart,
  type AgentFilePart,
  type AgentPastePart,
} from "@/models/agent.model";
import {
  AGENT_FILE_ACCEPT,
  fileChipToPartData,
} from "@/lib/agent/agentFiles";
import { insertDictationText } from "@/lib/dictation/insert";

import { useI18n, type TranslateFn } from "@/i18n";

type ComposerPart = TextUIPart | AgentPastePart | AgentFilePart;

// crypto.randomUUID is secure-context-only, so it is absent over plain http on
// a LAN host and calling it drops the paste. The id only has to be unique
// within one composer, never unguessable.
function chipId(): string {
  return (
    crypto.randomUUID?.() ??
    `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function queuedText(
  parts: UIMessage["parts"],
  t: TranslateFn,
  formatChars: (n: number) => string,
): string {
  const text = parts.find((part) => part.type === "text");
  const chip = parts.find(isAgentPastePart);
  const file = parts.find(isAgentFilePart);
  if (text?.type === "text" && text.text) return text.text;
  if (chip) return chipLabel(chip.data, t, formatChars);
  return file ? file.data.name : "";
}

// The provider owns the text — fillComposer reaches it through the
// registered API, and a nonce bump remounts this provider on the next seed
// (role switch, conversation reset) instead of an uncontrolled key reset.
export function AgentChatInput() {
  const { composerNonce, composerSeed } = useAgentChat();
  return (
    <PromptInputProvider key={composerNonce} initialInput={composerSeed}>
      <AgentChatComposer />
    </PromptInputProvider>
  );
}

function AgentChatComposer() {
  const {
    sendMessage,
    nativeSession,
    stop,
    status,
    approvalPending,
    queued,
    clearQueued,
    error,
    actionError,
    preflight,
    registerComposerApi,
    pasteChip,
    setPasteChip,
    fileChips,
    addFiles,
    clearFileChips,
    panelWidth,
    activeRole,
    conversationId,
  } = useAgentChat();
  const controller = usePromptInputController();
  const { t, formatNumber } = useI18n();
  const formatChars = (n: number) => formatNumber(n);

  const text = controller.textInput.value;
  // The paste chip is provider state — a model switch remounts this composer
  // (D1) and the card survives the remount on the provider, not here.
  const chip = pasteChip;

  // The provider reads the live draft on a role switch and writes through
  // fillComposer; the ref keeps read() current without re-registering.
  const valueRef = useRef(text);
  valueRef.current = text;
  const setInput = controller.textInput.setInput;
  useEffect(() => {
    registerComposerApi({
      read: () => valueRef.current,
      set: (value: string) => setInput(value),
    });
    return () => registerComposerApi(null);
  }, [registerComposerApi, setInput]);

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // File items take the attachment path (AWU-FILES). The text/plain a
    // file copy also carries is just the path/name metadata, not something
    // the user meant to type, so it is consumed here rather than inserted.
    const items = event.clipboardData?.items;
    if (items) {
      const files: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length > 0) {
        event.preventDefault();
        if (!nativeSession) addFiles(files);
        return;
      }
    }
    if (nativeSession) return;
    const pasted = event.clipboardData.getData("text/plain");
    if (pasted.length < APP_CONSTANTS.AGENT_CHAT_PASTE_THRESHOLD) return;
    event.preventDefault();
    const truncated = pasted.length > APP_CONSTANTS.AGENT_CHAT_PASTE_MAX_CHARS;
    // The ceiling is enforced here, at chip creation, so nothing beyond it
    // ever enters `messages` or the conversation row.
    const body = truncated
      ? pasted.slice(0, APP_CONSTANTS.AGENT_CHAT_PASTE_MAX_CHARS)
      : pasted;
    setPasteChip({
      id: chipId(),
      text: body,
      chars: body.length,
      truncated,
    });
  };

  const submit = (submitted: string) => {
    const trimmed = submitted.trim();
    const fileParts = fileChips
      .map(fileChipToPartData)
      .filter((data): data is NonNullable<typeof data> => data !== null)
      .map(
        (data) =>
          ({
            type: AGENT_FILE_PART_TYPE,
            id: data.id,
            data,
          }) satisfies AgentFilePart,
      );
    const parts: ComposerPart[] = [
      ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
      ...(chip
        ? [
            {
              type: AGENT_PASTE_PART_TYPE,
              id: chip.id,
              data: chip,
            } satisfies AgentPastePart,
          ]
        : []),
      ...fileParts,
    ];
    if (parts.length === 0) return;
    // Unconditional. Whether this goes out now or waits — for an approval, or
    // for the reply already streaming — is the provider's call, because it is
    // the only place that sees every sender.
    sendMessage({ parts });
    setPasteChip(undefined);
    clearFileChips();
  };

  const onStop = useCallback(() => {
    void stop();
  }, [stop]);

  const insertDictation = useCallback(
    (transcript: string) => {
      setInput(insertDictationText(valueRef.current, transcript).text);
    },
    [setInput],
  );

  const isGenerating = status === "submitted" || status === "streaming";
  // A file still extracting has nothing to send yet — send stays disabled
  // until every chip settles ready or is removed, so an expected attachment
  // can never be silently left out of the message.
  const filesPending = fileChips.some((c) => c.status === "extracting");
  const canSend =
    preflight.ok &&
    !filesPending &&
    (text.trim().length > 0 ||
      !!chip ||
      fileChips.some((c) => c.status === "ready"));
  // Same breakpoint the panel header uses for its compact variant.
  const compact = panelWidth < 480;

  return (
    <div className="flex flex-col gap-2">
      {error ||
      actionError ||
      (preflight.checked && !preflight.ok && !preflight.dismissed) ? (
        <ChatErrorBanner />
      ) : null}

      {queued ? (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {approvalPending
                ? t("agent.queuedApproval")
                : t("agent.queuedStreaming")}
            </p>
            <p className="truncate">{queuedText(queued.parts, t, formatChars)}</p>
          </div>
          <Button
            aria-label={t("agent.removeFromQueue")}
            className="size-6 shrink-0"
            onClick={clearQueued}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {approvalPending && !queued && <p role="status" className="px-1 text-xs text-amber-600">{t("agent.waitingOnApproval")}</p>}
      {/* No PromptInputBody: it wraps these in a display:contents div, and
          InputGroup only stacks vertically via has-[>[data-align=block-end]],
          a DOM-child selector that wrapper defeats. Nested, the group stays a
          row and the textarea collapses to a ~24px sliver beside the footer. */}
      <PromptInput
        className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm"
        accept={AGENT_FILE_ACCEPT}
        multiple
        onFiles={nativeSession ? undefined : addFiles}
        onSubmit={(message) => submit(message.text)}
      >
        {/* Controlled through PromptInputProvider: value lives in the
            controller so fillComposer can write to it, and it still clears
            on successful submit. */}
        <PromptInputTextarea
          className="min-h-16 px-4 pt-3 text-sm"
          onPaste={onPaste}
          placeholder={t("agent.inputPlaceholder")}
        />
        {/* Unified composer toolbar (AWU-COMPOSER/MODEL/CONTEXT): add-content
            menu, model picker and the context estimate all live here; the
            header keeps only the conversation-level controls. */}
        <PromptInputFooter className="flex-wrap gap-2 border-t border-border/50 px-3 pb-3 pt-2">
          <PromptInputTools className={`min-w-0 gap-1.5 ${compact ? "basis-full" : "flex-1"}`}>
            {nativeSession ? null : <AgentAddContextMenu compact={compact} />}
            <AgentChatIdentity compact={compact} />
            {nativeSession ? null : <AgentPermissionChip compact={compact} />}
          </PromptInputTools>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {nativeSession ? null : <AgentContextUsage />}
            <AgentDictationButton
              insertText={insertDictation}
              ownershipKey={`${activeRole}:${conversationId ?? "draft"}`}
              compact={compact}
            />
            <PromptInputSubmit
              aria-label={
                isGenerating ? t("agent.stopResponse") : t("agent.send")
              }
              disabled={!isGenerating && !canSend}
              className="size-8 rounded-full [&_svg]:size-4"
              onStop={onStop}
              size="icon-xs"
              status={status}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

// Structured reason carried by NATIVE_SESSION_UNAVAILABLE — the same
// fields nativeSession.server.ts's readiness report produces. Unknown or
// absent fields fall back to the generic copy.
type NativeDetails = {
  reason?: string;
  runtimeVersion?: string | null;
  requiredVersion?: string | null;
  model?: string | null;
  models?: string[] | null;
};

const NATIVE_REASON_KEY: Record<string, string> = {
  CONNECTION_INELIGIBLE: "nativeSession.unavailableConnection",
  RUNTIME_NOT_READY: "nativeSession.unavailableRuntime",
  RUNTIME_VERSION_MISMATCH: "nativeSession.unavailableVersion",
  MODEL_UNSUPPORTED: "nativeSession.unavailableModel",
};

function ChatErrorBanner() {
  const { t } = useI18n();
  const {
    error,
    actionError,
    clearError,
    preflight,
    messages,
    regenerate,
    startNewConversation,
    startNativeConversation,
    requestModelPicker,
  } = useAgentChat();
  const [cliUpdateBusy, setCliUpdateBusy] = useState(false);
  const [cliUpdateError, setCliUpdateError] = useState<string | null>(null);
  const parsed = error ? readAgentChatError(error) : null;
  const code =
    actionError?.code && categorizeAgentErrorCode(actionError.code) === "recovery"
      ? actionError.code
      : parsed?.code && parsed.code !== "GENERIC"
      ? parsed.code
      : (actionError?.code ?? preflight.code ?? parsed?.code ?? "GENERIC");
  const category = categorizeAgentErrorCode(code);
  const copy = agentErrorCopy(category);
  const raw = parsed?.message ?? "";
  const showRaw = raw.length > 0 && !raw.trim().startsWith("{") && code === "GENERIC";
  const nativeDetails =
    category === "native-unavailable"
      ? ((actionError?.details ?? null) as NativeDetails | null)
      : null;
  const canUpdateCli =
    nativeDetails?.reason === "RUNTIME_VERSION_MISMATCH" &&
    Boolean(nativeDetails.requiredVersion) &&
    typeof window !== "undefined" &&
    typeof window.vocatryaRuntime?.applyUpdate === "function";

  const applyCliUpdate = async () => {
    const runtime = window.vocatryaRuntime;
    if (!runtime?.applyUpdate) return;
    setCliUpdateBusy(true);
    setCliUpdateError(null);
    try {
      const result = await runtime.applyUpdate("CODEX_RUNTIME", {
        target: "required",
      });
      if (result.ok) {
        clearError();
        void startNativeConversation();
      } else {
        setCliUpdateError(
          t("nativeSession.updateFailed", { code: result.code }),
        );
      }
    } catch {
      setCliUpdateError(t("nativeSession.updateFailed", { code: "ERROR" }));
    } finally {
      setCliUpdateBusy(false);
    }
  };

  const nativeBody = nativeDetails?.reason
    ? t(
        NATIVE_REASON_KEY[nativeDetails.reason] ?? "nativeSession.unavailable",
        {
          required: nativeDetails.requiredVersion ?? "",
          actual: nativeDetails.runtimeVersion ?? t("nativeSession.unknownVersion"),
          model: nativeDetails.model ?? "",
          models: (nativeDetails.models ?? []).join(", "),
        },
      )
    : null;

  return (
    <Alert variant="destructive" className="flex items-start gap-2">
      <AlertDescription className="flex-1 space-y-1">
        <p className="font-medium">{t(copy.titleKey)}</p>
        <p>{showRaw ? raw : (nativeBody ?? t(copy.bodyKey))}</p>
        {cliUpdateError ? <p className="text-xs">{cliUpdateError}</p> : null}
        {category === "native-unavailable" ? (
          <span className="flex flex-wrap items-center gap-2 pt-1">
            {canUpdateCli ? (
              <Button
                className="h-7 px-2 text-xs"
                disabled={cliUpdateBusy}
                onClick={() => void applyCliUpdate()}
                size="sm"
                type="button"
              >
                {cliUpdateBusy
                  ? t("nativeSession.updating")
                  : t("nativeSession.updateCli", {
                      version: nativeDetails?.requiredVersion ?? "",
                    })}
              </Button>
            ) : null}
            <Button
              className="h-7 px-2 text-xs"
              onClick={() => {
                clearError();
                void startNewConversation();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("nativeSession.usePlain")}
            </Button>
          </span>
        ) : null}
        {copy.action === "retry" ? (
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => {
              clearError();
              if (messages.length > 0) void regenerate();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("agent.retry")}
          </Button>
        ) : null}
        {copy.action === "settings" ? (
          <Button asChild className="h-7 px-2 text-xs" size="sm" variant="outline">
            <Link href="/dashboard/settings?section=ai-services">{t("agent.goToAiSettings")}</Link>
          </Button>
        ) : null}
        {copy.action === "new-model" ? (
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => {
              clearError();
              void startNewConversation();
              requestModelPicker();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("agent.useOtherModel")}
          </Button>
        ) : null}
      </AlertDescription>
      <Button
        aria-label={t("common.dismissError")}
        className="size-6 shrink-0"
        onClick={clearError}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </Alert>
  );
}
