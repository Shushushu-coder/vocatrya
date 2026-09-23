"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";
import {
  listAiConnections,
  mintAiConnectionTicket,
} from "@/actions/aiConnection.actions";
import type { ConnectionSummary } from "@/lib/ai/connection-service";

const CODEX_BACKEND = "CODEX_RUNTIME";

type ModelEntry = {
  id: string;
  displayName: string;
  source: string;
  availability: string;
};

const STATUS_KEY: Record<string, string> = {
  CONNECTED: "settings.aiConnStatusConnected",
  REAUTH_REQUIRED: "settings.aiConnStatusReauthRequired",
  DISCONNECTED: "settings.aiConnStatusDisconnected",
  ERROR: "settings.aiConnStatusError",
};

const OP_DONE_KEY: Record<string, string> = {
  reconnect: "settings.aiConnReconnectDone",
  disconnect: "settings.aiConnDisconnectDone",
  verify: "settings.aiConnVerifyDone",
};

const ERROR_KEY: Record<string, string> = {
  RUNTIME_NOT_INSTALLED: "settings.aiConnErrRuntimeNotInstalled",
  RUNTIME_BROKEN: "settings.aiConnErrRuntimeBroken",
  LOGIN_ALREADY_IN_PROGRESS: "settings.aiConnErrInProgress",
  LOGIN_CANCELLED: "settings.aiConnErrLoginCancelled",
  LOGIN_TIMEOUT: "settings.aiConnErrLoginTimeout",
  LOGIN_FAILED: "settings.aiConnErrLoginFailed",
  AUTH_NOT_CONFIRMED: "settings.aiConnErrAuthNotConfirmed",
  REAUTH_REQUIRED: "settings.aiConnErrReauthRequired",
  ACCOUNT_IDENTITY_CONFLICT: "settings.aiConnErrIdentityConflict",
  CONNECTION_NOT_FOUND: "settings.aiConnErrNotFound",
  CONNECTION_ARCHIVED: "settings.aiConnErrArchived",
  INFERENCE_FAILED: "settings.aiConnErrInferenceFailed",
  UNSUPPORTED_BACKEND: "settings.aiConnErrUnsupportedBackend",
  INVALID_TICKET: "settings.aiConnErrInvalidTicket",
  BACKEND_UNAVAILABLE: "settings.aiConnErrBackendUnavailable",
};

/**
 * Phase D minimal account-login surface. Renders only inside the desktop
 * shell — without the vocatryaAi preload bridge there is no managed runtime
 * to orchestrate, so the card stays hidden on the web.
 */
function AiConnectionsCard() {
  const { t } = useI18n();
  const [bridgeAvailable] = useState(
    () => typeof window !== "undefined" && Boolean(window.vocatryaAi),
  );
  const [runtimeState, setRuntimeState] = useState<{
    state: string;
    version?: string;
  } | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingTicket, setPendingTicket] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelEntry[]>>({});
  const [smokeText, setSmokeText] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const result = await listAiConnections();
    if (result.success && result.data) {
      setConnections(
        result.data.filter((c) => c.backendKind === CODEX_BACKEND),
      );
    }
  }, []);

  useEffect(() => {
    if (!bridgeAvailable) return;
    void refresh();
    void window.vocatryaRuntime
      ?.detect(CODEX_BACKEND)
      .then((status) =>
        setRuntimeState({ state: status.state, version: status.version }),
      )
      .catch(() => setRuntimeState(null));
  }, [bridgeAvailable, refresh]);

  const errorMessage = useCallback(
    (code?: string) =>
      t((code && ERROR_KEY[code]) || "settings.aiConnErrGeneric"),
    [t],
  );

  const mintTicket = useCallback(
    async (operation: string, connectionId?: string) => {
      const result = await mintAiConnectionTicket({
        operation,
        backendKind: CODEX_BACKEND,
        connectionId,
      });
      if (!result.success || !result.data) {
        toastError(result.message || t("settings.aiConnErrGeneric"));
        return null;
      }
      return result.data.ticket;
    },
    [t],
  );

  const connect = useCallback(async () => {
    const ai = window.vocatryaAi;
    if (!ai) return;
    const ticket = await mintTicket("login");
    if (!ticket) return;
    setPendingTicket(ticket);
    setBusy("connect");
    try {
      const result = await ai.startLogin({ backendKind: CODEX_BACKEND, ticket });
      if (result.ok) {
        toastSuccess(t("settings.aiConnConnected"));
        await refresh();
      } else {
        toastError(errorMessage(result.code));
      }
    } finally {
      setBusy(null);
      setPendingTicket(null);
    }
  }, [mintTicket, refresh, errorMessage, t]);

  const cancelLogin = useCallback(async () => {
    if (!pendingTicket) return;
    await window.vocatryaAi?.cancelOperation({ ticket: pendingTicket });
  }, [pendingTicket]);

  const runConnectionOp = useCallback(
    async (
      connectionId: string,
      operation: "reconnect" | "disconnect" | "verify",
    ) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket(operation, connectionId);
      if (!ticket) return;
      setBusy(`${operation}:${connectionId}`);
      try {
        const result = await ai[operation]({ connectionId, ticket });
        if (result.ok) {
          toastSuccess(t(OP_DONE_KEY[operation]));
          await refresh();
        } else {
          toastError(errorMessage(result.code));
          if (result.connection) await refresh();
        }
      } finally {
        setBusy(null);
      }
    },
    [mintTicket, refresh, errorMessage, t],
  );

  const loadModels = useCallback(
    async (connectionId: string) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket("listModels", connectionId);
      if (!ticket) return;
      setBusy(`models:${connectionId}`);
      try {
        const result = await ai.listModels({ connectionId, ticket });
        if (result.ok && result.models) {
          setModels((prev) => ({ ...prev, [connectionId]: result.models! }));
        } else {
          toastError(errorMessage(result.code));
        }
      } finally {
        setBusy(null);
      }
    },
    [mintTicket, errorMessage],
  );

  const runSmoke = useCallback(
    async (connectionId: string) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket("smoke", connectionId);
      if (!ticket) return;
      setBusy(`smoke:${connectionId}`);
      try {
        const result = await ai.runSmoke({ connectionId, ticket });
        if (result.ok && result.matched) {
          toastSuccess(t("settings.aiConnSmokePassed"));
          setSmokeText((prev) => ({ ...prev, [connectionId]: result.text! }));
        } else {
          toastError(errorMessage(result.code ?? "INFERENCE_FAILED"));
        }
      } finally {
        setBusy(null);
      }
    },
    [mintTicket, errorMessage, t],
  );

  if (!bridgeAvailable) return null;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.aiConnectionsTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.aiConnectionsDescription")}
        </p>
      </div>

      <div className="text-sm text-muted-foreground">
        {runtimeState
          ? t("settings.aiConnRuntimeStatus", {
              state: runtimeState.state,
              version: runtimeState.version ?? "?",
            })
          : t("settings.checking")}
      </div>

      <div className="flex items-center gap-2">
        {busy === "connect" ? (
          <>
            <Button variant="outline" onClick={cancelLogin}>
              {t("settings.aiConnCancelLogin")}
            </Button>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("settings.aiConnLoginInProgress")}
            </span>
          </>
        ) : (
          <Button
            onClick={connect}
            disabled={busy !== null || runtimeState?.state !== "READY"}
          >
            {t("settings.connectChatGPT")}
          </Button>
        )}
      </div>

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("settings.aiConnNone")}
        </p>
      ) : (
        <ul className="space-y-3">
          {connections.map((connection) => (
            <li key={connection.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{connection.displayName}</span>
                  {connection.accountIdentity && (
                    <span className="ml-2 text-sm text-muted-foreground">
                      {connection.accountIdentity}
                    </span>
                  )}
                </div>
                <span className="text-sm">
                  {t(STATUS_KEY[connection.status] ?? "settings.aiConnStatusError")}
                </span>
              </div>
              {connection.lastVerifiedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.aiConnLastVerified", {
                    at: new Date(connection.lastVerifiedAt).toLocaleString(),
                  })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => runConnectionOp(connection.id, "reconnect")}
                >
                  {busy === `reconnect:${connection.id}` && (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  )}
                  {t("settings.aiConnReconnect")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => runConnectionOp(connection.id, "disconnect")}
                >
                  {t("settings.aiConnDisconnect")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => runConnectionOp(connection.id, "verify")}
                >
                  {busy === `verify:${connection.id}` ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3 w-3" />
                  )}
                  {t("settings.aiConnVerify")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => loadModels(connection.id)}
                >
                  {busy === `models:${connection.id}` && (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  )}
                  {t("settings.aiConnViewModels")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || connection.status !== "CONNECTED"}
                  onClick={() => runSmoke(connection.id)}
                >
                  {busy === `smoke:${connection.id}` && (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  )}
                  {t("settings.aiConnRunSmoke")}
                </Button>
              </div>
              {models[connection.id] && (
                <ul className="text-sm text-muted-foreground list-disc pl-5">
                  {models[connection.id].map((model) => (
                    <li key={model.id}>
                      {model.displayName}{" "}
                      <span className="text-xs">({model.id})</span>
                    </li>
                  ))}
                </ul>
              )}
              {smokeText[connection.id] && (
                <p className="text-xs font-mono text-muted-foreground">
                  {smokeText[connection.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default AiConnectionsCard;
