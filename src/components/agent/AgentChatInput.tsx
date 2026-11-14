"use client";

import { useCallback, useEffect, useRef } from "react";
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
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";
import { AgentContextUsage } from "@/components/agent/AgentContextUsage";
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
        addFiles(files);
        return;
      }
    }
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

      {/* No PromptInputBody: it wraps these in a display:contents div, and
          InputGroup only stacks vertically via has-[>[data-align=block-end]],
          a DOM-child selector that wrapper defeats. Nested, the group stays a
          row and the textarea collapses to a ~24px sliver beside the footer. */}
      <PromptInput
        accept={AGENT_FILE_ACCEPT}
        multiple
        onFiles={addFiles}
        onSubmit={(message) => submit(message.text)}
      >
        {/* Controlled through PromptInputProvider: value lives in the
            controller so fillComposer can write to it, and it still clears
            on successful submit. */}
        <PromptInputTextarea
          className="min-h-9"
          onPaste={onPaste}
          placeholder={t("agent.inputPlaceholder")}
        />
        {/* Unified composer toolbar (AWU-COMPOSER/MODEL/CONTEXT): add-content
            menu, model picker and the context estimate all live here; the
            header keeps only the conversation-level controls. */}
        <PromptInputFooter>
          <PromptInputTools>
            <AgentAddContextMenu compact={compact} />
            <AgentChatIdentity compact={compact} />
            <AgentContextUsage />
            <span className="text-xs text-muted-foreground">
              {approvalPending && !queued ? t("agent.waitingOnApproval") : ""}
            </span>
          </PromptInputTools>
          <PromptInputSubmit
            aria-label={
              isGenerating ? t("agent.stopResponse") : t("agent.send")
            }
            disabled={!isGenerating && !canSend}
            className="[&_svg]:size-3.5"
            onStop={onStop}
            size="icon-xs"
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

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
    requestModelPicker,
  } = useAgentChat();
  const parsed = error ? readAgentChatError(error) : null;
  const code =
    actionError?.code && categorizeAgentErrorCode(actionError.code) === "recovery"
      ? actionError.code
      : parsed?.code && parsed.code !== "GENERIC"
      ? parsed.code
      : (actionError?.code ?? preflight.code ?? parsed?.code ?? "GENERIC");
  const copy = agentErrorCopy(categorizeAgentErrorCode(code));
  const raw = parsed?.message ?? "";
  const showRaw = raw.length > 0 && !raw.trim().startsWith("{") && code === "GENERIC";

  return (
    <Alert variant="destructive" className="flex items-start gap-2">
      <AlertDescription className="flex-1 space-y-1">
        <p className="font-medium">{t(copy.titleKey)}</p>
        <p>{showRaw ? raw : t(copy.bodyKey)}</p>
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
