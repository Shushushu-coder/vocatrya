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
import type { AccountRuntimeCapabilities } from "@/lib/ai/runtime/capabilities";

// Implemented account-login backends. Each entry pins the account provider
// it requests — the server re-validates the provider/runtime pairing when
// minting the ticket, and the runtime adapter verifies the real auth
// outcome. Everything else (runtime name, login interaction, capability
// hints) comes from the unified runtime capability descriptor fetched via
// the vocatryaRuntime bridge — never hardcoded per provider here.
const ACCOUNT_LOGIN_BACKENDS = [
  {
    backendKind: "CODEX_RUNTIME",
    providerLabel: "ChatGPT",
    connectLabelKey: "settings.connectChatGPT",
    accountProvider: "OPENAI",
  },
  {
    backendKind: "CLAUDE_RUNTIME",
    providerLabel: "Claude",
    connectLabelKey: "settings.connectClaude",
    accountProvider: "ANTHROPIC",
  },
  {
    backendKind: "OPENCODE_RUNTIME",
    providerLabel: "ChatGPT",
    connectLabelKey: "settings.connectChatGPTViaOpenCode",
    accountProvider: "OPENAI",
  },
  {
    backendKind: "GROK_RUNTIME",
    providerLabel: "Grok",
    connectLabelKey: "settings.connectGrok",
    accountProvider: "XAI",
  },
  {
    backendKind: "CURSOR_RUNTIME",
    providerLabel: "Cursor",
    connectLabelKey: "settings.connectCursor",
    accountProvider: "CURSOR",
  },
  {
    backendKind: "DEVIN_RUNTIME",
    providerLabel: "Devin",
    connectLabelKey: "settings.connectDevin",
    accountProvider: "DEVIN",
  },
] as const;

type BackendKind = (typeof ACCOUNT_LOGIN_BACKENDS)[number]["backendKind"];

type RuntimeListEntry = {
  displayName: string;
  capabilities: AccountRuntimeCapabilities;
};

type RuntimeState = { state: string; version?: string };

type InstallMethod = {
  kind: string;
  summary: string;
  executable: string;
  args: string[];
  documentationUrl?: string;
};

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

// Unified runtime install-state labels (NOT_INSTALLED/READY/
// UPDATE_AVAILABLE/BROKEN) — runtime state and connection auth state are
// separate axes and render in separate places.
const RUNTIME_STATE_KEY: Record<string, string> = {
  NOT_INSTALLED: "settings.aiConnRuntimeStateNotInstalled",
  READY: "settings.aiConnRuntimeStateReady",
  UPDATE_AVAILABLE: "settings.aiConnRuntimeStateUpdateAvailable",
  BROKEN: "settings.aiConnRuntimeStateBroken",
};

const OP_DONE_KEY: Record<string, string> = {
  reconnect: "settings.aiConnReconnectDone",
  disconnect: "settings.aiConnDisconnectDone",
  verify: "settings.aiConnVerifyDone",
};

const ERROR_KEY: Record<string, string> = {
  RUNTIME_NOT_INSTALLED: "settings.aiConnErrRuntimeNotInstalled",
  RUNTIME_BROKEN: "settings.aiConnErrRuntimeBroken",
  RUNTIME_UPDATE_REQUIRED: "settings.aiConnErrRuntimeUpdateRequired",
  LOGIN_ALREADY_IN_PROGRESS: "settings.aiConnErrInProgress",
  LOGIN_CANCELLED: "settings.aiConnErrLoginCancelled",
  LOGIN_TIMEOUT: "settings.aiConnErrLoginTimeout",
  LOGIN_FAILED: "settings.aiConnErrLoginFailed",
  AUTH_NOT_CONFIRMED: "settings.aiConnErrAuthNotConfirmed",
  AUTH_METHOD_UNVERIFIED: "settings.aiConnErrAuthMethodUnverified",
  UNSUPPORTED_AUTH_METHOD: "settings.aiConnErrUnsupportedAuthMethod",
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    "settings.aiConnErrUnsupportedCombination",
  MODEL_DISCOVERY_UNAVAILABLE: "settings.aiConnErrModelUnavailable",
  MODEL_UNAVAILABLE: "settings.aiConnErrModelUnavailable",
  PERMISSION_BOUNDARY_NOT_READY: "settings.aiConnErrPermissionBoundary",
  PROVIDER_POLICY_RESTRICTED: "settings.aiConnErrProviderPolicyRestricted",
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
 * Consolidated account-login surface for the six ACCOUNT_LOGIN runtimes.
 * Renders only inside the desktop shell — without the vocatryaAi preload
 * bridge there is no managed runtime to orchestrate, so the card stays
 * hidden on the web.
 */
function AiConnectionsCard() {
  const { t } = useI18n();
  const [bridgeAvailable] = useState(
    () => typeof window !== "undefined" && Boolean(window.vocatryaAi),
  );
  const [runtimeInfo, setRuntimeInfo] = useState<
    Partial<Record<BackendKind, RuntimeListEntry>>
  >({});
  const [runtimeStates, setRuntimeStates] = useState<
    Partial<Record<BackendKind, RuntimeState>>
  >({});
  const [installInfo, setInstallInfo] = useState<
    Partial<Record<BackendKind, InstallMethod[]>>
  >({});
  const [updateInfo, setUpdateInfo] = useState<
    Partial<Record<BackendKind, InstallMethod[]>>
  >({});
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingTicket, setPendingTicket] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelEntry[]>>({});
  const [smokeText, setSmokeText] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const result = await listAiConnections();
    if (result.success && result.data) {
      setConnections(
        result.data.filter((c) =>
          ACCOUNT_LOGIN_BACKENDS.some((b) => b.backendKind === c.backendKind),
        ),
      );
    }
  }, []);

  useEffect(() => {
    if (!bridgeAvailable) return;
    void refresh();
    void window.vocatryaRuntime
      ?.list()
      .then((list) => {
        const next: Partial<Record<BackendKind, RuntimeListEntry>> = {};
        for (const entry of list) {
          if (
            ACCOUNT_LOGIN_BACKENDS.some(
              (b) => b.backendKind === entry.backendKind,
            )
          ) {
            next[entry.backendKind as BackendKind] = {
              displayName: entry.displayName,
              capabilities: entry.capabilities,
            };
          }
        }
        setRuntimeInfo(next);
      })
      .catch(() => undefined);
    for (const backend of ACCOUNT_LOGIN_BACKENDS) {
      void window.vocatryaRuntime
        ?.detect(backend.backendKind)
        .then((status) => {
          setRuntimeStates((prev) => ({
            ...prev,
            [backend.backendKind]: {
              state: status.state,
              version: status.version,
            },
          }));
          // Install/update metadata is fetched only when the runtime state
          // needs it — a READY runtime never pays for it.
          if (status.state === "NOT_INSTALLED" || status.state === "BROKEN") {
            void window.vocatryaRuntime
              ?.getInstallInfo(backend.backendKind)
              .then((info) =>
                setInstallInfo((prev) => ({
                  ...prev,
                  [backend.backendKind]: info.methods,
                })),
              )
              .catch(() => undefined);
          }
          if (status.state === "UPDATE_AVAILABLE") {
            void window.vocatryaRuntime
              ?.getUpdateInfo(backend.backendKind)
              .then((info) =>
                setUpdateInfo((prev) => ({
                  ...prev,
                  [backend.backendKind]: info.methods,
                })),
              )
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }
  }, [bridgeAvailable, refresh]);

  const errorMessage = useCallback(
    (code?: string) =>
      t((code && ERROR_KEY[code]) || "settings.aiConnErrGeneric"),
    [t],
  );

  // The vendor's authorize URL surfaces mid-login for runtimes whose
  // capability descriptor marks surfacesAuthorizationUrl — the spawned
  // CLI cannot open a browser itself (OpenCode/Grok/Cursor). Cleared when
  // the login ends. Never persisted.
  useEffect(() => {
    const unsubscribe = window.vocatryaAi?.onOAuthUrl?.(setOauthUrl);
    return () => unsubscribe?.();
  }, []);

  const mintTicket = useCallback(
    async (
      operation: string,
      backendKind: BackendKind,
      connectionId?: string,
      accountProvider?: string,
    ) => {
      const result = await mintAiConnectionTicket({
        operation,
        backendKind,
        connectionId,
        accountProvider,
      });
      if (!result.success || !result.data) {
        toastError(result.message || t("settings.aiConnErrGeneric"));
        return null;
      }
      return result.data.ticket;
    },
    [t],
  );

  const connect = useCallback(
    async (backend: (typeof ACCOUNT_LOGIN_BACKENDS)[number]) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket(
        "login",
        backend.backendKind,
        undefined,
        backend.accountProvider,
      );
      if (!ticket) return;
      setPendingTicket(ticket);
      setBusy(`connect:${backend.backendKind}`);
      try {
        const result = await ai.startLogin({
          backendKind: backend.backendKind,
          ticket,
        });
        if (result.ok) {
          toastSuccess(t("settings.aiConnConnected"));
          await refresh();
        } else {
          toastError(errorMessage(result.code));
        }
      } finally {
        setBusy(null);
        setPendingTicket(null);
        setOauthUrl(null);
      }
    },
    [mintTicket, refresh, errorMessage, t],
  );

  const cancelLogin = useCallback(async () => {
    if (!pendingTicket) return;
    await window.vocatryaAi?.cancelOperation({ ticket: pendingTicket });
  }, [pendingTicket]);

  const runConnectionOp = useCallback(
    async (
      connectionId: string,
      backendKind: BackendKind,
      operation: "reconnect" | "disconnect" | "verify",
    ) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket(operation, backendKind, connectionId);
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
    async (connectionId: string, backendKind: BackendKind) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket("listModels", backendKind, connectionId);
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
    async (connectionId: string, backendKind: BackendKind) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket("smoke", backendKind, connectionId);
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

      {ACCOUNT_LOGIN_BACKENDS.map((backend) => {
        const runtime = runtimeInfo[backend.backendKind];
        const runtimeState = runtimeStates[backend.backendKind];
        const backendConnections = connections.filter(
          (c) => c.backendKind === backend.backendKind,
        );
        const runtimeName = runtime?.displayName ?? backend.backendKind;
        const isConnecting = busy === `connect:${backend.backendKind}`;
        return (
          <section
            key={backend.backendKind}
            className="space-y-3 rounded-md border p-3"
          >
            {/* Provider + runtime are both always visible — two account
                providers can share a provider name (ChatGPT via Codex vs
                ChatGPT via OpenCode) so the runtime label disambiguates. */}
            <div className="flex items-center justify-between">
              <h4 className="font-medium">
                {backend.providerLabel}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  {t("settings.aiConnViaRuntime", { name: runtimeName })}
                </span>
              </h4>
              <span className="text-sm text-muted-foreground">
                {runtimeState
                  ? `${t(
                      RUNTIME_STATE_KEY[runtimeState.state] ??
                        "settings.aiConnStatusError",
                    )}${runtimeState.version ? ` (v${runtimeState.version})` : ""}`
                  : t("settings.checking")}
              </span>
            </div>

            {/* Unified install/update UX: NOT_INSTALLED and BROKEN surface
                the registry's install metadata; UPDATE_AVAILABLE surfaces
                update metadata. Install/update never runs implicitly — the
                user always performs an explicit action (and runtime-side
                execution stays disabled this phase). */}
            {(runtimeState?.state === "NOT_INSTALLED" ||
              runtimeState?.state === "BROKEN") && (
              <div className="rounded-md border border-dashed p-2 text-sm space-y-1">
                <p className="text-muted-foreground">
                  {runtimeState.state === "BROKEN"
                    ? t("settings.aiConnReinstallHint")
                    : t("settings.aiConnInstallHint")}
                </p>
                {(installInfo[backend.backendKind] ?? []).map((method) => (
                  <div
                    key={`${method.kind}:${method.executable}`}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-muted-foreground">
                      {method.summary}
                    </span>
                    {method.documentationUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(
                            method.documentationUrl,
                            "_blank",
                            "noopener",
                          )
                        }
                      >
                        {t("settings.aiConnInstallDocs")}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {runtimeState?.state === "UPDATE_AVAILABLE" && (
              <div className="rounded-md border border-dashed p-2 text-sm space-y-1">
                <p className="text-muted-foreground">
                  {t("settings.aiConnUpdateAvailable")}
                </p>
                {(updateInfo[backend.backendKind] ?? []).map((method) => (
                  <p
                    key={`${method.kind}:${method.executable}`}
                    className="text-muted-foreground"
                  >
                    {method.summary}
                  </p>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              {isConnecting ? (
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
                  onClick={() => connect(backend)}
                  disabled={busy !== null || runtimeState?.state !== "READY"}
                >
                  {t(backend.connectLabelKey)}
                </Button>
              )}
            </div>

            {/* Capability-driven login hint: runtimes whose login runs in a
                visible console window tell the user where to look. */}
            {isConnecting &&
              runtime?.capabilities.login.interaction ===
                "VISIBLE_CONSOLE" && (
                <p className="text-sm text-muted-foreground">
                  {t("settings.aiConnConsoleLoginHint")}
                </p>
              )}

            {isConnecting && oauthUrl && (
              <div className="rounded-md border p-2 text-sm space-y-1">
                <p className="text-muted-foreground">
                  {t("settings.aiConnOAuthHint")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(oauthUrl, "_blank", "noopener")}
                >
                  {t("settings.aiConnOpenAuthPage")}
                </Button>
              </div>
            )}

            {backendConnections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("settings.aiConnNone")}
              </p>
            ) : (
              <ul className="space-y-3">
                {backendConnections.map((connection) => (
                  <li
                    key={connection.id}
                    className="rounded-md border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">
                          {connection.displayName}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t("settings.aiConnViaRuntime", {
                            name: runtimeName,
                          })}
                        </span>
                        {connection.accountIdentity && (
                          <span className="ml-2 text-sm text-muted-foreground">
                            {connection.accountIdentity}
                          </span>
                        )}
                      </div>
                      <span className="text-sm">
                        {t(
                          STATUS_KEY[connection.status] ??
                            "settings.aiConnStatusError",
                        )}
                      </span>
                    </div>
                    {connection.lastVerifiedAt && (
                      <p className="text-xs text-muted-foreground">
                        {t("settings.aiConnLastVerified", {
                          at: new Date(
                            connection.lastVerifiedAt,
                          ).toLocaleString(),
                        })}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          runConnectionOp(
                            connection.id,
                            backend.backendKind,
                            "reconnect",
                          )
                        }
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
                        onClick={() =>
                          runConnectionOp(
                            connection.id,
                            backend.backendKind,
                            "disconnect",
                          )
                        }
                      >
                        {t("settings.aiConnDisconnect")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          runConnectionOp(
                            connection.id,
                            backend.backendKind,
                            "verify",
                          )
                        }
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
                        onClick={() =>
                          loadModels(connection.id, backend.backendKind)
                        }
                      >
                        {busy === `models:${connection.id}` && (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        )}
                        {t("settings.aiConnViewModels")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          busy !== null || connection.status !== "CONNECTED"
                        }
                        onClick={() =>
                          runSmoke(connection.id, backend.backendKind)
                        }
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
          </section>
        );
      })}
    </div>
  );
}

export default AiConnectionsCard;
