"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { AiServiceSlot, useAiServicesLayout } from "./AiServicesLayout";
import AiServiceIcon from "./AiServiceIcon";
import AiServiceListItem from "./AiServiceListItem";
import SettingsDrawer from "./SettingsDrawer";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { toastSuccess, toastError } from "@/lib/toast";
import { useConditionNotice } from "@/components/common/useConditionNotice";
import { useI18n } from "@/i18n";
import {
  listAiConnections,
  mintAiConnectionTicket,
} from "@/actions/aiConnection.actions";
import type { ConnectionSummary } from "@/lib/ai/connection-service";
import type { AccountRuntimeCapabilities } from "@/lib/ai/runtime/capabilities";
import type { RuntimeUpdateCheckResult } from "@/lib/ai/runtime/update-check";

// Implemented account-login backends. Each entry pins the account provider
// options it offers — the server re-validates the provider/runtime pairing
// when minting the ticket, and the runtime adapter verifies the real auth
// outcome. OpenCode is its own account ecosystem (Zen pay-as-you-go / Go
// subscription), so its card offers both products. Everything else
// (runtime name, login interaction, capability hints) comes from the
// unified runtime capability descriptor fetched via the vocatryaRuntime
// bridge — never hardcoded per provider here.
const ACCOUNT_LOGIN_BACKENDS = [
  {
    backendKind: "CODEX_RUNTIME",
    providerLabel: "ChatGPT",
    accountOptions: [
      { accountProvider: "OPENAI", connectLabelKey: "settings.connectChatGPT" },
    ],
  },
  {
    backendKind: "CLAUDE_RUNTIME",
    providerLabel: "Claude",
    accountOptions: [
      { accountProvider: "ANTHROPIC", connectLabelKey: "settings.connectClaude" },
    ],
  },
  {
    backendKind: "OPENCODE_RUNTIME",
    providerLabel: "OpenCode",
    accountOptions: [
      {
        accountProvider: "OPENCODE_GO",
        connectLabelKey: "settings.connectOpenCodeGo",
      },
      {
        accountProvider: "OPENCODE_ZEN",
        connectLabelKey: "settings.connectOpenCodeZen",
      },
    ],
  },
  {
    backendKind: "GROK_RUNTIME",
    providerLabel: "Grok",
    accountOptions: [
      { accountProvider: "XAI", connectLabelKey: "settings.connectGrok" },
    ],
  },
  {
    backendKind: "CURSOR_RUNTIME",
    providerLabel: "Cursor",
    accountOptions: [
      { accountProvider: "CURSOR", connectLabelKey: "settings.connectCursor" },
    ],
  },
  {
    backendKind: "DEVIN_RUNTIME",
    providerLabel: "Devin",
    accountOptions: [
      { accountProvider: "DEVIN", connectLabelKey: "settings.connectDevin" },
    ],
  },
  {
    backendKind: "ANTIGRAVITY_RUNTIME",
    providerLabel: "Antigravity",
    accountOptions: [
      {
        accountProvider: "ANTIGRAVITY",
        connectLabelKey: "settings.connectAntigravity",
      },
    ],
  },
] as const;

type BackendKind = (typeof ACCOUNT_LOGIN_BACKENDS)[number]["backendKind"];

type RuntimeListEntry = {
  displayName: string;
  capabilities: AccountRuntimeCapabilities;
};

type RuntimeInstall = {
  path: string;
  source: string;
  version: string | null;
  verified: boolean;
  stale: boolean;
  selected: boolean;
  /** Purposes this install is chosen for: default | native | exec (streaming). */
  selectedFor?: string[];
};

type RuntimeState = {
  state: string;
  version?: string;
  executablePath?: string;
  installs?: RuntimeInstall[];
  verifiedVersions?: string[];
};

const toRuntimeState = (status: {
  state: string;
  version?: string;
  executablePath?: string;
  installs?: RuntimeInstall[];
  verifiedVersions?: string[];
}): RuntimeState => ({
  state: status.state,
  version: status.version,
  executablePath: status.executablePath,
  installs: status.installs,
  verifiedVersions: status.verifiedVersions,
});

const INSTALL_SOURCE_KEY: Record<string, string> = {
  standalone: "runtimeUpdate.installSourceStandalone",
  npm: "runtimeUpdate.installSourceNpm",
  "npm-staging": "runtimeUpdate.installSourceNpmStaging",
  path: "runtimeUpdate.installSourcePath",
};

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

// Update-check verdict labels — the online check's verdict axis, separate
// from the local install state above.
const UPDATE_CHECK_STATUS_KEY: Record<string, string> = {
  UP_TO_DATE: "runtimeUpdate.upToDate",
  UPDATE_AVAILABLE: "runtimeUpdate.updateAvailable",
  AHEAD_OF_CHANNEL: "runtimeUpdate.aheadOfChannel",
  CHECK_FAILED: "runtimeUpdate.checkFailed",
  UNSUPPORTED: "runtimeUpdate.unsupported",
  NOT_RUN: "runtimeUpdate.notRun",
  CURRENT_UNKNOWN: "runtimeUpdate.currentUnknown",
  UNCOMPARABLE: "runtimeUpdate.uncomparable",
};

const UPDATE_SOURCE_KEY: Record<string, string> = {
  "npm-latest": "runtimeUpdate.sourceNpm",
  "channel-file": "runtimeUpdate.sourceChannel",
  "json-manifest": "runtimeUpdate.sourceManifest",
  "install-script": "runtimeUpdate.sourceInstallScript",
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
 * Consolidated account-login surface for the ACCOUNT_LOGIN runtimes.
 * Renders only inside the desktop shell — without the vocatryaAi preload
 * bridge there is no managed runtime to orchestrate, so the card stays
 * hidden on the web.
 */
function AiConnectionsCard() {
  const { t } = useI18n();
  const integrated = useAiServicesLayout();
  const [detailBackend, setDetailBackend] = useState<string | null>(null);
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
  const [updateChecks, setUpdateChecks] = useState<
    Partial<Record<BackendKind, RuntimeUpdateCheckResult>>
  >({});
  const [updateBusy, setUpdateBusy] = useState<
    Partial<Record<BackendKind, boolean>>
  >({});
  const [updateIpcFailed, setUpdateIpcFailed] = useState<
    Partial<Record<BackendKind, boolean>>
  >({});
  const [applyBusy, setApplyBusy] = useState<
    Partial<Record<BackendKind, boolean>>
  >({});
  const [applyOutcome, setApplyOutcome] = useState<
    Partial<Record<BackendKind, { ok: boolean; text: string }>>
  >({});
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingTicket, setPendingTicket] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelEntry[]>>({});
  const [smokeText, setSmokeText] = useState<Record<string, string>>({});

  // null until the first successful listAiConnections read.
  const [connectionsChecked, setConnectionsChecked] = useState(false);

  const refresh = useCallback(async () => {
    const result = await listAiConnections();
    if (result.success && result.data) {
      setConnectionsChecked(true);
      setConnections(
        result.data.filter((c) =>
          ACCOUNT_LOGIN_BACKENDS.some((b) => b.backendKind === c.backendKind),
        ),
      );
    }
  }, []);

  // Persistent condition, mirrored top-left from the status read above. The
  // per-action toasts below (connect/verify failures) stay bottom-right.
  useConditionNotice(
    connectionsChecked ? connections.some((c) => c.status === "REAUTH_REQUIRED") : null,
    {
      kind: "ai-connection:REAUTH_REQUIRED",
      title: t("common.errorNoticeAiReauthTitle"),
      message: t("common.errorNoticeAiReauthMessage"),
      action: {
        label: t("common.errorNoticeReconnect"),
        href: "/dashboard/settings?section=ai-services",
      },
    },
  );

  // The single online update-check path — the automatic mount-time check
  // and the manual recheck share it. force bypasses the upstream cache;
  // the check is read-only and never runs an installer or updater.
  const runUpdateCheck = useCallback(
    async (backendKind: BackendKind, force: boolean) => {
      const runtime = window.vocatryaRuntime;
      if (!runtime || typeof runtime.checkUpdate !== "function") return;
      setUpdateBusy((prev) => ({ ...prev, [backendKind]: true }));
      setUpdateIpcFailed((prev) => ({ ...prev, [backendKind]: false }));
      try {
        const result = await runtime.checkUpdate(backendKind, { force });
        setUpdateChecks((prev) => ({ ...prev, [backendKind]: result }));
      } catch {
        setUpdateChecks((prev) => {
          const next = { ...prev };
          delete next[backendKind];
          return next;
        });
        setUpdateIpcFailed((prev) => ({ ...prev, [backendKind]: true }));
      } finally {
        setUpdateBusy((prev) => ({ ...prev, [backendKind]: false }));
      }
    },
    [],
  );

  // One-click update — the bridge executes an audited target ("latest" |
  // "required"); on completion we re-probe detection AND rerun the online
  // check so the card reflects the real installed version, not optimism.
  const runApplyUpdate = useCallback(
    async (backendKind: BackendKind, target: "latest" | "required") => {
      const runtime = window.vocatryaRuntime;
      if (!runtime || typeof runtime.applyUpdate !== "function") return;
      setApplyBusy((prev) => ({ ...prev, [backendKind]: true }));
      try {
        const result = await runtime.applyUpdate(backendKind, { target });
        setApplyOutcome((prev) => ({
          ...prev,
          [backendKind]: result.ok
            ? {
                ok: true,
                text: t("runtimeUpdate.applyDone", {
                  version: result.version ?? "",
                }),
              }
            : {
                ok: false,
                text:
                  result.code === "MANUAL_REQUIRED"
                    ? t("runtimeUpdate.applyManual")
                    : t("runtimeUpdate.applyFailed", { code: result.code }),
              },
        }));
        void runtime
          .detect(backendKind)
          .then((status) =>
            setRuntimeStates((prev) => ({
              ...prev,
              [backendKind]: toRuntimeState(status),
            })),
          )
          .catch(() => undefined);
        void runUpdateCheck(backendKind, true);
      } catch {
        setApplyOutcome((prev) => ({
          ...prev,
          [backendKind]: {
            ok: false,
            text: t("runtimeUpdate.applyFailed", { code: "ERROR" }),
          },
        }));
      } finally {
        setApplyBusy((prev) => ({ ...prev, [backendKind]: false }));
      }
    },
    [runUpdateCheck, t],
  );

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
            [backend.backendKind]: toRuntimeState(status),
          }));
          // Install metadata is fetched only when the runtime state needs
          // it — a READY runtime never pays for it.
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
          // Automatic online update check for every installed runtime —
          // the same service path as the manual recheck below.
          if (status.installed) {
            void runUpdateCheck(backend.backendKind, false);
          }
        })
        .catch(() => undefined);
    }
  }, [bridgeAvailable, refresh, runUpdateCheck]);

  const errorMessage = useCallback(
    (code?: string) =>
      t((code && ERROR_KEY[code]) || "settings.aiConnErrGeneric"),
    [t],
  );

  // Update-check failure detail: the service reports stable codes —
  // NETWORK / TIMEOUT / INVALID_RESPONSE / HTTP_<status>.
  const updateErrorText = useCallback(
    (error: string) => {
      if (error.startsWith("HTTP_")) {
        return t("runtimeUpdate.errHttp", { status: error.slice(5) });
      }
      if (error === "TIMEOUT") return t("runtimeUpdate.errTimeout");
      if (error === "INVALID_RESPONSE") return t("runtimeUpdate.errInvalid");
      return t("runtimeUpdate.errNetwork");
    },
    [t],
  );

  // The vendor's authorize URL surfaces mid-login for runtimes whose
  // capability descriptor marks surfacesAuthorizationUrl — either because
  // the spawned CLI cannot open a browser itself (Grok/Cursor), or as the
  // fallback entry when its own browser attempt may fail (Codex).
  // Cleared when the login ends. Never persisted.
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
    async (
      backend: (typeof ACCOUNT_LOGIN_BACKENDS)[number],
      accountProvider: string,
    ) => {
      const ai = window.vocatryaAi;
      if (!ai) return;
      const ticket = await mintTicket(
        "login",
        backend.backendKind,
        undefined,
        accountProvider,
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
        if (operation === "reconnect") setOauthUrl(null);
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

  if (!bridgeAvailable) return integrated ? (
    <AiServiceSlot placement="account-available">
      <div className="rounded-lg border bg-muted/20 p-3 text-sm">
        <h4 className="font-medium">{t("settings.aiConnectionsTitle")}</h4>
        <p className="mt-1 text-muted-foreground">{t("settings.aiServicesDesktopOnly")}</p>
      </div>
    </AiServiceSlot>
  ) : null;

  return (
    <div className={integrated ? "contents" : "space-y-4 rounded-lg border p-4"}>
      <div className={integrated ? "hidden" : undefined}>
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
        // A reconnect runs the same login process and can surface the same
        // authorize URL / console hint — the oauthUrl block and the
        // VISIBLE_CONSOLE hint must not hide just because busy is
        // `reconnect:<id>` rather than `connect:<kind>`.
        const isReconnecting = backendConnections.some(
          (c) => busy === `reconnect:${c.id}`,
        );
        const loginInFlight = isConnecting || isReconnecting;
        const update = updateChecks[backend.backendKind];
        const updateChecking = updateBusy[backend.backendKind] === true;
        const updateFailed = updateIpcFailed[backend.backendKind] === true;
        const applying = applyBusy[backend.backendKind] === true;
        const applied = applyOutcome[backend.backendKind] ?? null;
        const compact = integrated && backendConnections.length === 0 && !isConnecting;
        const card = (
          <section className="min-w-0 space-y-3 rounded-lg border bg-card p-3">

            {/* Product + runtime are both always visible — a runtime can
                host several account products (OpenCode Go / Zen) so the
                runtime label disambiguates what executes the session. */}
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
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
                user always performs an explicit action. One-click updates
                run through the audited runtime:applyUpdate path; install
                methods stay display-only. */}
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
            {(() => {
              // Read-only self-check status of the installed build
              // (cache-managed runtimes only). TODO: add a "Re-verify"
              // button wired to a clear-cache IPC; today UNVERIFIED expires
              // after a few minutes and restarting the app retries FAIL.
              const probe = runtime?.capabilities.capabilityProbe;
              if (!probe || runtimeState?.state !== "READY") return null;
              const failed =
                probe.streaming === "FAIL" ||
                probe.streaming === "UNVERIFIED" ||
                probe.structured === "FAIL" ||
                probe.structured === "UNVERIFIED";
              const key = probe.probing
                ? "settings.aiConnSelfCheckRunning"
                : failed
                  ? "settings.aiConnSelfCheckFailed"
                  : probe.streaming === "PENDING" || probe.structured === "PENDING"
                    ? "settings.aiConnSelfCheckPending"
                    : "settings.aiConnSelfCheckPassed";
              return (
                <p
                  className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
                  data-testid="runtime-self-check"
                >
                  {t(key, { version: probe.version })}
                </p>
              );
            })()}
            <details className="text-sm" open={integrated ? undefined : true}>
              <summary className="cursor-pointer text-muted-foreground">{t("settings.aiServicesRuntimeDetails")}</summary>
            {/* Online update check — the UPDATE_AVAILABLE verdict comes
                from a real upstream comparison (effectiveState), never
                from the local probe alone. Checking never installs or
                updates anything; failures are reported as failures and
                never as "up to date". */}
            {(runtimeState?.state === "READY" ||
              runtimeState?.state === "BROKEN") && (
              <div className="rounded-md border border-dashed p-2 text-sm space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {update
                      ? `${t("runtimeUpdate.currentVersion")} ${
                          update.currentVersion
                            ? `v${update.currentVersion}`
                            : t("runtimeUpdate.versionUnknown")
                        } · ${t("runtimeUpdate.availableVersion")} ${
                          update.check.latestVersion
                            ? `v${update.check.latestVersion}`
                            : "—"
                        }`
                      : updateChecking
                        ? t("runtimeUpdate.checking")
                        : t("runtimeUpdate.notRun")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateChecking}
                    onClick={() =>
                      void runUpdateCheck(backend.backendKind, true)
                    }
                  >
                    {updateChecking ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    {t("runtimeUpdate.recheck")}
                  </Button>
                </div>
                {update && (
                  <p className="text-muted-foreground">
                    {t(
                      UPDATE_CHECK_STATUS_KEY[update.check.status] ??
                        "runtimeUpdate.checkFailed",
                    )}
                    {update.check.error
                      ? ` (${updateErrorText(update.check.error)})`
                      : ""}
                    {update.check.source
                      ? ` · ${t(
                          UPDATE_SOURCE_KEY[update.check.source] ??
                            "runtimeUpdate.sourceUnknown",
                        )}`
                      : ""}
                    {update.check.checkedAt
                      ? ` · ${t("runtimeUpdate.lastChecked", {
                          at: new Date(
                            update.check.checkedAt,
                          ).toLocaleString(),
                        })}`
                      : ""}
                  </p>
                )}
                {runtimeState?.installs && runtimeState.installs.length > 0 && (
                  <div className="space-y-0.5 text-muted-foreground" data-testid="runtime-installs">
                    {runtimeState.executablePath && (
                      <p>
                        {t("runtimeUpdate.installInUse", {
                          version: runtimeState.version ?? t("runtimeUpdate.versionUnknown"),
                          path: runtimeState.executablePath,
                        })}
                      </p>
                    )}
                    {(["native", "exec"] as const).map((purpose) => {
                      const chosen = runtimeState.installs?.find((i) =>
                        i.selectedFor?.includes(purpose),
                      );
                      return chosen && !chosen.selected ? (
                        <p key={purpose}>
                          {t(
                            purpose === "native"
                              ? "runtimeUpdate.installNativeUse"
                              : "runtimeUpdate.installExecUse",
                            {
                              version: chosen.version ?? t("runtimeUpdate.versionUnknown"),
                              path: chosen.path,
                            },
                          )}
                        </p>
                      ) : null;
                    })}
                    {runtimeState.verifiedVersions &&
                      runtimeState.verifiedVersions.length > 0 && (
                        <p>
                          {t("runtimeUpdate.installVerifiedVersions", {
                            versions: runtimeState.verifiedVersions
                              .map((v) => `v${v}`)
                              .join(", "),
                          })}
                        </p>
                      )}
                    {runtimeState.installs.length > 1 && (
                      <>
                        <p>{t("runtimeUpdate.installMultiple")}</p>
                        <ul className="list-disc pl-4">
                          {runtimeState.installs.map((install) => (
                            <li key={install.path} className="break-all">
                              {install.path} ·{" "}
                              {install.version
                                ? `v${install.version}`
                                : t("runtimeUpdate.versionUnknown")}{" "}
                              · {t(INSTALL_SOURCE_KEY[install.source] ?? "runtimeUpdate.installSourcePath")}
                              {" · "}
                              {install.verified
                                ? t("runtimeUpdate.installVerified")
                                : t("runtimeUpdate.installUnverified")}
                              {install.stale
                                ? ` · ${t("runtimeUpdate.installStale")}`
                                : ""}
                              {install.selected
                                ? ` · ${t("runtimeUpdate.installSelected")}`
                                : ""}
                              {install.selectedFor?.includes("native")
                                ? ` · ${t("runtimeUpdate.installTagNative")}`
                                : ""}
                              {install.selectedFor?.includes("exec")
                                ? ` · ${t("runtimeUpdate.installTagExec")}`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                {updateFailed && !update && (
                  <p className="text-muted-foreground">
                    {t("runtimeUpdate.checkFailed")} ·{" "}
                    {t("runtimeUpdate.checkFailedHint")}
                  </p>
                )}
                {update &&
                  update.compatibility.current !== null &&
                  update.check.status !== "NOT_RUN" && (
                    <p className="text-muted-foreground">
                      {update.compatibility.current === "VERIFIED"
                        ? t("runtimeUpdate.compatVerifiedCurrent", {
                            version: update.currentVersion ?? "",
                          })
                        : update.compatibility.current === "UNVERIFIED"
                          ? t("runtimeUpdate.compatUnverifiedCurrent", {
                              certified:
                                update.compatibility.certifiedVersions.join(
                                  ", ",
                                ),
                            })
                          : t("runtimeUpdate.compatNoBaseline")}
                    </p>
                  )}
                {/* Strict capability target (e.g. Codex native-session
                    0.169.0) — a separate axis from "a newer build exists";
                    offered only when the install flavor can actually pin
                    it (npm-global). */}
                {update?.requiredVersion &&
                  update.currentVersion !== update.requiredVersion &&
                  !(
                    update.currentVersion &&
                    runtimeState?.verifiedVersions?.includes(
                      update.currentVersion,
                    )
                  ) && (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.requiredHint", {
                          version: update.requiredVersion,
                        })}
                      </p>
                      {update.apply?.canRequired ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={applying}
                          onClick={() =>
                            void runApplyUpdate(backend.backendKind, "required")
                          }
                        >
                          {applying ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : null}
                          {t("runtimeUpdate.applyRequired", {
                            version: update.requiredVersion,
                          })}
                        </Button>
                      ) : (
                        <p className="text-muted-foreground">
                          {t("runtimeUpdate.applyManual")}
                        </p>
                      )}
                    </div>
                  )}
                {update?.check.status === "UPDATE_AVAILABLE" && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.updateHint")}
                      </p>
                      {update.apply?.canLatest ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={applying}
                          onClick={() =>
                            void runApplyUpdate(backend.backendKind, "latest")
                          }
                        >
                          {applying ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : null}
                          {t("runtimeUpdate.applyLatest", {
                            version: update.check.latestVersion ?? "",
                          })}
                        </Button>
                      ) : null}
                    </div>
                    {update.compatibility.available === "VERIFIED" ? (
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.verifiedAvailableHint")}
                      </p>
                    ) : update.compatibility.available === "UNVERIFIED" ? (
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.unverifiedAvailableHint", {
                          certified:
                            update.compatibility.certifiedVersions.join(", "),
                        })}
                      </p>
                    ) : null}
                    {update.methods.map((method) => (
                      <p
                        key={`${method.kind}:${method.executable}`}
                        className="text-muted-foreground"
                      >
                        {method.summary}
                      </p>
                    ))}
                    {update.recovery?.command ? (
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.recoveryCommand", {
                          version: update.recovery.version,
                          command: update.recovery.command,
                        })}
                      </p>
                    ) : update.recovery &&
                      update.compatibility.available === "UNVERIFIED" ? (
                      <p className="text-muted-foreground">
                        {t("runtimeUpdate.recoveryNone")}
                      </p>
                    ) : null}
                  </>
                )}
                {update?.check.status === "CHECK_FAILED" && (
                  <p className="text-muted-foreground">
                    {t("runtimeUpdate.checkFailedHint")}
                  </p>
                )}
                {applied ? (
                  <p
                    className={
                      applied.ok ? "text-muted-foreground" : "text-destructive"
                    }
                  >
                    {applied.text}
                  </p>
                ) : null}
              </div>
            )}

            </details>

            <div className="flex flex-wrap items-center gap-2">
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
                // A connect button always mints a NEW connection row — an
                // existing row for the same account provider already covers
                // re-auth through its own "Reconnect", so the button hides
                // instead of spawning a duplicate login and a second row.
                // Gated per provider, not per backend: OpenCode Go/Zen are
                // two products on one runtime.
                backend.accountOptions.map((option) =>
                  backendConnections.some(
                    (c) => c.provider === option.accountProvider,
                  ) ? null : (
                    <Button
                      key={option.accountProvider}
                      onClick={() => connect(backend, option.accountProvider)}
                      disabled={
                        busy !== null || runtimeState?.state !== "READY"
                      }
                    >
                      {t(option.connectLabelKey)}
                    </Button>
                  ),
                )
              )}
            </div>

            {/* Capability-driven login hint: runtimes whose login runs in a
                visible console window tell the user where to look. */}
            {loginInFlight &&
              runtime?.capabilities.login.interaction ===
                "VISIBLE_CONSOLE" && (
                <p className="text-sm text-muted-foreground">
                  {t("settings.aiConnConsoleLoginHint")}
                </p>
              )}

            {loginInFlight && oauthUrl && (
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
                      <div className="min-w-0 break-words">
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
        return (
          <AiServiceSlot key={backend.backendKind} placement={backendConnections.length > 0 || isConnecting ? "account-connected" : "account-available"}>
            {compact ? <>
              <AiServiceListItem
                icon={<AiServiceIcon name={backend.providerLabel} />}
                name={backend.providerLabel}
                description={runtimeState?.state === "READY" ? runtimeName : runtimeState ? t(RUNTIME_STATE_KEY[runtimeState.state] ?? "settings.aiConnStatusError") : t("settings.checking")}
                onDetails={() => setDetailBackend(backend.backendKind)}
                action={backend.accountOptions.length === 1 ? (
                  <Button size="sm" variant="secondary" className="h-8 rounded-full px-3 text-xs" aria-label={t(backend.accountOptions[0].connectLabelKey)} disabled={busy !== null || runtimeState?.state !== "READY"} onClick={() => { setDetailBackend(null); void connect(backend, backend.accountOptions[0].accountProvider); }}>
                    {t("settings.aiServicesConnect")}
                  </Button>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button size="sm" variant="secondary" className="h-8 rounded-full px-3 text-xs" disabled={busy !== null || runtimeState?.state !== "READY"}>{t("settings.aiServicesConnect")}</Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">{backend.accountOptions.map(option => <DropdownMenuItem key={option.accountProvider} onSelect={() => { setDetailBackend(null); void connect(backend, option.accountProvider); }}>{t(option.connectLabelKey)}</DropdownMenuItem>)}</DropdownMenuContent>
                  </DropdownMenu>
                )}
              />
              <SettingsDrawer open={detailBackend === backend.backendKind} onOpenChange={open => setDetailBackend(open ? backend.backendKind : null)} title={backend.providerLabel} description={t("settings.aiConnViaRuntime", { name: runtimeName })}>
                {card}
              </SettingsDrawer>
            </> : card}
          </AiServiceSlot>
        );
      })}
    </div>
  );
}

export default AiConnectionsCard;
