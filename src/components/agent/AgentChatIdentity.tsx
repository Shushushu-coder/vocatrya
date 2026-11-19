"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Lock, ChevronDown } from "lucide-react";
import {
  getNativeChatEntry,
  listEligibleChatModels,
} from "@/actions/agentChat.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/i18n";
import type {
  EligibleChatModel,
  ExplicitModelSelection,
  NativeChatEntry,
  NativeUnavailableDetails,
} from "@/lib/agent/chatTypes";

// Lives in the composer toolbar (AWU-MODEL). The popover opens upward, and a
// pick on an existing conversation starts a new draft carrying the composer's
// draft text, MANUAL context and paste chip (D1) — never a silent resend.
export function AgentChatIdentity({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const {
    conversationId,
    identity,
    setDraftModel,
    startNewConversation,
    startNativeConversation,
    nativeSession,
    explicit,
    modelPickerNonce,
  } = useAgentChat();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<EligibleChatModel[]>([]);
  const [nativeEntry, setNativeEntry] = useState<NativeChatEntry | null>(null);

  // Same mount-vs-bump rule as AgentAddContextMenu: the nonce outlives the
  // toolbar remount that carries it, so the value at mount is already seen.
  const seenPickerNonceRef = useRef(modelPickerNonce);
  useEffect(() => {
    if (modelPickerNonce === seenPickerNonceRef.current) return;
    seenPickerNonceRef.current = modelPickerNonce;
    setPicking(true);
    setOpen(true);
  }, [modelPickerNonce]);

  useEffect(() => {
    if (!open || nativeSession) return;
    let cancelled = false;
    void listEligibleChatModels().then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setModels(result.data);
    });
    void getNativeChatEntry({ preferred: explicit }).then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setNativeEntry(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, nativeSession, explicit]);

  const locked = Boolean(conversationId) && identity.locked;
  const legacy = Boolean(conversationId) && identity.persistedLegacy;
  const label = nativeSession
    ? t("nativeSession.badge")
    : legacy
    ? identity.model
      ? t("agent.legacyIdentity", { model: identity.model })
      : t("agent.legacyIdentityUnknown")
    : identity.model && identity.displayName
      ? t("agent.identityPair", {
          model: identity.model,
          connection: identity.displayName,
        })
      : (identity.model ?? t(identity.code === "AI_NOT_CONFIGURED" ? "agent.configureAi" : "agent.selectModel"));

  const nativeReasonText = (details: NativeUnavailableDetails | undefined) => {
    switch (details?.reason) {
      case "CONNECTION_INELIGIBLE":
        return t("nativeSession.entryConnection");
      case "RUNTIME_NOT_READY":
        return t("nativeSession.entryRuntime");
      case "RUNTIME_VERSION_MISMATCH":
        return t("nativeSession.entryVersion", {
          required: details.requiredVersion ?? "",
          actual: details.runtimeVersion ?? t("nativeSession.unknownVersion"),
        });
      case "MODEL_UNSUPPORTED":
        return t("nativeSession.entryModel");
      default:
        return t("nativeSession.unavailable");
    }
  };

  const choose = (model: EligibleChatModel) => {
    const selection: ExplicitModelSelection = {
      connectionId: model.connectionId,
      model: model.model,
    };
    setOpen(false);
    setPicking(false);
    if (conversationId) {
      void startNewConversation({ explicit: selection, carry: true });
      return;
    }
    setDraftModel(selection);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPicking(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="agent-identity"
          className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-full border px-2.5 text-xs text-foreground hover:bg-muted ${compact ? "max-w-full" : "max-w-sm"}`}
          title={label}
          aria-expanded={open}
          aria-label={label || t("agent.selectModel")}
        >
          {locked ? <Lock className="h-3 w-3 shrink-0" aria-hidden /> : null}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 space-y-2 p-3">
        {nativeSession ? (
          <>
            <p className="text-sm font-medium">{t("nativeSession.entry")}</p>
            <p className="text-xs text-muted-foreground">
              {t("nativeSession.textOnly")}
            </p>
            {identity.model ? (
              <p className="text-xs text-muted-foreground">{identity.model}</p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                void startNewConversation({ carry: true });
              }}
            >
              {t("nativeSession.leave")}
            </Button>
          </>
        ) : locked && !picking ? (
          <>
            <p className="text-sm">
              {t("agent.lockTitle", { model: identity.model ?? "" })}
            </p>
            <p className="text-xs text-muted-foreground">{t("agent.lockBody")}</p>
            <p className="text-xs text-muted-foreground">{t("agent.lockCarry")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPicking(true)}
            >
              {t("agent.useOtherModel")}
            </Button>
          </>
        ) : legacy && !picking ? (
          <p className="text-sm">{label}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {conversationId ? t("agent.useOtherModel") : t("agent.modelForNew")}
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("agent.noEligibleModels")}
                </p>
              ) : (
                models.map((model) => (
                  <button
                    key={`${model.connectionId}:${model.model}`}
                    type="button"
                    className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => choose(model)}
                  >
                    {t("agent.identityPair", {
                      model: model.model,
                      connection: model.displayName,
                    })}
                  </button>
                ))
              )}
            </div>
            {models.length === 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href="/dashboard/settings?section=ai-services">{t("agent.goToAiSettings")}</Link>
              </Button>
            )}
            <div className="border-t pt-2">
              {nativeEntry === null ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("settings.checking")}
                </p>
              ) : nativeEntry.ok ? (
                <button
                  type="button"
                  data-testid="agent-native-entry"
                  className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setOpen(false);
                    setPicking(false);
                    void startNativeConversation({
                      connectionId: nativeEntry.connectionId,
                      model: nativeEntry.model,
                    });
                  }}
                >
                  <span className="block truncate text-sm">
                    {t("nativeSession.entry")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("nativeSession.textOnly")} · {nativeEntry.model}
                  </span>
                </button>
              ) : (
                <div className="px-2 py-1.5">
                  <p className="text-sm text-muted-foreground">
                    {t("nativeSession.entry")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {nativeReasonText(nativeEntry.details)}
                  </p>
                  <Button
                    asChild
                    size="sm"
                    variant="link"
                    className="h-auto px-0 text-xs"
                  >
                    <Link href="/dashboard/settings?section=ai-services">
                      {t("agent.goToAiSettings")}
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
